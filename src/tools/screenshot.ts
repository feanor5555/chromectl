/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createInflate} from 'node:zlib';

import {zod} from '../third_party/index.js';
import type {
  BoundingBox,
  CDPSession,
  ElementHandle,
  Page,
  Protocol,
  ScreenshotClip,
} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

type ScreenshotFormat = 'png' | 'jpeg' | 'webp';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function restoreNothing(): Promise<void> {
  // The window state was never touched.
}

async function detachQuietly(session: CDPSession): Promise<void> {
  try {
    await session.detach();
  } catch {
    // The session dies with the page; nothing left to clean up.
  }
}

/**
 * Puts the browser window of the page's target into a state in which it paints
 * and brings the page to the front, then hands back a callback that restores
 * the window state that was found.
 *
 * A capture reads the window's surface, and a minimized window produces no
 * surface frame: the capture either stalls until Chrome gives up or comes back
 * blank. Throws when the window is minimized and cannot be restored.
 */
async function prepareWindowForCapture(
  page: Page,
): Promise<() => Promise<void>> {
  let session: CDPSession;
  let windowId: number;
  let previousState: Protocol.Browser.WindowState | undefined;
  try {
    session = await page.createCDPSession();
  } catch {
    // Without a session there is nothing to inspect or change; the uniformity
    // check has to catch a blank frame.
    return restoreNothing;
  }
  try {
    const window = await session.send('Browser.getWindowForTarget');
    windowId = window.windowId;
    previousState = window.bounds.windowState;
  } catch {
    // Connections that do not expose the Browser domain report no window.
    await detachQuietly(session);
    return restoreNothing;
  }

  if (previousState === 'minimized') {
    try {
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {windowState: 'normal'},
      });
      const {bounds} = await session.send('Browser.getWindowBounds', {
        windowId,
      });
      if (bounds.windowState === 'minimized') {
        throw new Error('the window stayed minimized');
      }
    } catch (error) {
      await detachQuietly(session);
      throw new Error(
        `The browser window is minimized and could not be restored (${describeError(error)}). A minimized window renders no frame, so the screenshot would be blank.`,
      );
    }
  }

  try {
    await page.bringToFront();
  } catch (error) {
    await detachQuietly(session);
    throw new Error(
      `The page could not be brought to the front (${describeError(error)}). A page that is not the active tab renders no frame, so the screenshot would be blank.`,
    );
  }

  return async () => {
    if (previousState === 'minimized') {
      try {
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: {windowState: previousState},
        });
      } catch {
        // The window keeps the state it is in; the capture itself is done and
        // must not fail over this.
      }
    }
    await detachQuietly(session);
  };
}

// prettier-ignore
const PNG_SIGNATURE = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
);

const PNG_CHANNELS_BY_COLOR_TYPE = new Map<number, number>([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

interface PngImage {
  width: number;
  height: number;
  /** Samples per pixel, which for 8 bit depth is also the bytes per pixel. */
  channels: number;
  /** The concatenated IDAT chunks, i.e. the raw zlib stream. */
  stream: Uint8Array;
}

/**
 * Reads the header and the pixel stream out of a PNG. Returns undefined for
 * anything this decoder does not handle: a non-PNG, a bit depth other than 8,
 * an interlaced image or a truncated file.
 */
function parsePng(image: Uint8Array): PngImage | undefined {
  if (image.length < PNG_SIGNATURE.length) {
    return undefined;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (image[i] !== PNG_SIGNATURE[i]) {
      return undefined;
    }
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const chunks: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let channels = 0;
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= image.length) {
    const length = view.getUint32(offset);
    const body = offset + 8;
    const end = body + length;
    // Every chunk carries a four byte CRC behind its body.
    if (end + 4 > image.length) {
      return undefined;
    }
    const type = String.fromCharCode(
      image[offset + 4],
      image[offset + 5],
      image[offset + 6],
      image[offset + 7],
    );
    if (type === 'IHDR') {
      if (length < 13) {
        return undefined;
      }
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const bitDepth = image[body + 8];
      const colorType = image[body + 9];
      const interlaceMethod = image[body + 12];
      if (bitDepth !== 8 || interlaceMethod !== 0) {
        return undefined;
      }
      channels = PNG_CHANNELS_BY_COLOR_TYPE.get(colorType) ?? 0;
      if (channels === 0) {
        return undefined;
      }
    } else if (type === 'IDAT') {
      chunks.push(image.subarray(body, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (width <= 0 || height <= 0 || channels === 0 || chunks.length === 0) {
    return undefined;
  }
  return {width, height, channels, stream: Buffer.concat(chunks)};
}

function paethPredictor(
  left: number,
  above: number,
  upperLeft: number,
): number {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) {
    return left;
  }
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

/**
 * Reverses the PNG scanline filter in place. Returns false for an unknown
 * filter type.
 */
function unfilterScanline(
  filterType: number,
  line: Uint8Array,
  previous: Uint8Array,
  bytesPerPixel: number,
): boolean {
  switch (filterType) {
    case 0:
      return true;
    case 1:
      for (let i = bytesPerPixel; i < line.length; i++) {
        line[i] = (line[i] + line[i - bytesPerPixel]) & 0xff;
      }
      return true;
    case 2:
      for (let i = 0; i < line.length; i++) {
        line[i] = (line[i] + previous[i]) & 0xff;
      }
      return true;
    case 3:
      for (let i = 0; i < line.length; i++) {
        const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return true;
    case 4:
      for (let i = 0; i < line.length; i++) {
        const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
        const upperLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
        line[i] =
          (line[i] + paethPredictor(left, previous[i], upperLeft)) & 0xff;
      }
      return true;
    default:
      return false;
  }
}

/**
 * Reports whether every pixel of the PNG carries the same value. The pixel
 * stream is inflated and unfiltered scanline by scanline and the walk stops at
 * the first pixel that differs, so only an image that really is one colour is
 * read to the end. Returns undefined when the image cannot be decoded here and
 * the question therefore stays unanswered.
 */
async function isUniformPng(image: Uint8Array): Promise<boolean | undefined> {
  const png = parsePng(image);
  if (png === undefined) {
    return undefined;
  }
  const bytesPerPixel = png.channels;
  const lineLength = png.width * bytesPerPixel;
  const line = new Uint8Array(lineLength);
  const previous = new Uint8Array(lineLength);
  const reference = new Uint8Array(bytesPerPixel);
  let filterType = -1;
  let filled = 0;
  let scanlines = 0;
  let uniform = true;
  const inflater = createInflate();
  inflater.end(png.stream);
  try {
    for await (const chunk of inflater) {
      const bytes: Uint8Array = chunk;
      let offset = 0;
      while (offset < bytes.length) {
        if (filterType < 0) {
          filterType = bytes[offset];
          offset++;
          continue;
        }
        const take = Math.min(lineLength - filled, bytes.length - offset);
        line.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled < lineLength) {
          continue;
        }
        if (!unfilterScanline(filterType, line, previous, bytesPerPixel)) {
          return undefined;
        }
        if (scanlines === 0) {
          reference.set(line.subarray(0, bytesPerPixel));
        }
        for (let i = 0; i < lineLength; i++) {
          if (line[i] !== reference[i % bytesPerPixel]) {
            uniform = false;
            break;
          }
        }
        previous.set(line);
        filled = 0;
        filterType = -1;
        scanlines++;
        if (!uniform) {
          break;
        }
      }
      if (!uniform) {
        break;
      }
    }
  } catch {
    return undefined;
  }
  if (!uniform) {
    return false;
  }
  // A stream that ended early says nothing about the pixels that never arrived.
  return scanlines === png.height ? true : undefined;
}

async function getSourceBox(
  page: Page,
  element: ElementHandle | undefined,
  fullPage: boolean,
): Promise<BoundingBox | undefined> {
  if (element) {
    const box = await element.boundingBox();
    return box ?? undefined;
  }
  if (fullPage) {
    const dims = await page.evaluate(() => ({
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ),
    }));
    if (dims.width <= 0 || dims.height <= 0) {
      return undefined;
    }
    return {x: 0, y: 0, width: dims.width, height: dims.height};
  }
  const viewport = page.viewport();
  if (viewport) {
    return {x: 0, y: 0, width: viewport.width, height: viewport.height};
  }
  // The browser is launched and connected with `defaultViewport: null`, so
  // `page.viewport()` stays null until something emulates one. Fall back to the
  // window's own dimensions, which is the area a viewport screenshot captures.
  const dims = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  if (dims.width <= 0 || dims.height <= 0) {
    return undefined;
  }
  return {x: 0, y: 0, width: dims.width, height: dims.height};
}

function computeDownscaleClip(
  box: BoundingBox,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
): ScreenshotClip | undefined {
  const widthScale =
    maxWidth !== undefined ? Math.min(1, maxWidth / box.width) : 1;
  const heightScale =
    maxHeight !== undefined ? Math.min(1, maxHeight / box.height) : 1;
  const scale = Math.min(widthScale, heightScale);
  if (scale >= 1) {
    return undefined;
  }
  // Skip degenerate sub-pixel results.
  if (Math.round(box.width * scale) < 1 || Math.round(box.height * scale) < 1) {
    return undefined;
  }
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    scale,
  };
}

export const screenshot = definePageTool(args => {
  const {
    screenshotFormat,
    screenshotQuality,
    screenshotMaxWidth,
    screenshotMaxHeight,
  } = args ?? {};

  const defaultFormat: ScreenshotFormat = screenshotFormat ?? 'png';

  return {
    name: 'take_screenshot',
    description: `Take a screenshot of the page or element.`,
    annotations: {
      category: ToolCategory.DEBUGGING,
      // Not read-only due to filePath param.
      readOnlyHint: false,
    },
    schema: {
      format: zod
        .enum(['png', 'jpeg', 'webp'])
        .default(defaultFormat)
        .describe(
          `Type of format to save the screenshot as. Default is "${defaultFormat}"`,
        ),
      quality: zod
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.',
        ),
      uid: zod
        .string()
        .optional()
        .describe(
          'The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.',
        ),
      fullPage: zod
        .boolean()
        .optional()
        .describe(
          'If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.',
        ),
      filePath: zod
        .string()
        .optional()
        .describe(
          'The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.',
        ),
    },
    blockedByDialog: true,
    verifyFilesSchema: ['filePath'],
    handler: async (request, response, context) => {
      if (request.params.uid && request.params.fullPage) {
        throw new Error('Providing both "uid" and "fullPage" is not allowed.');
      }

      const page = request.page.pptrPage;
      using element = request.params.uid
        ? await request.page.getElementByUid(request.params.uid)
        : undefined;

      const format = request.params.format;
      const quality =
        format === 'png'
          ? undefined
          : (request.params.quality ?? screenshotQuality);
      const fullPage = request.params.fullPage ?? false;

      // `getElementByUid` mints a fresh ElementHandle per call, so dispose it
      // once the capture is done to avoid leaking a remote object for the life
      // of the page's execution context.
      let screenshot: Uint8Array;

      // Compute a downscale clip when --screenshot-max-width or
      // --screenshot-max-height is set and the source exceeds either bound.
      // The smaller scale factor wins so both bounds are respected while
      // preserving aspect ratio.
      let clip: ScreenshotClip | undefined;
      if (
        screenshotMaxWidth !== undefined ||
        screenshotMaxHeight !== undefined
      ) {
        const box = await getSourceBox(page, element, fullPage);
        if (box) {
          clip = computeDownscaleClip(
            box,
            screenshotMaxWidth,
            screenshotMaxHeight,
          );
        }
      }

      // The capture reads the browser window's surface, which only exists while
      // the window paints: a minimized window delivers no frame. The window is
      // therefore brought into a painting state before the capture and put back
      // the way it was found afterwards.
      const restoreWindow = await prepareWindowForCapture(page);
      try {
        if (clip) {
          // page.screenshot with clip lets the CDP scale param downscale the
          // capture for viewport, full-page and element shots alike. We rely on
          // Puppeteer's default of captureBeyondViewport=true when a clip is
          // present so element/full-page captures below the fold still work.
          screenshot = await page.screenshot({
            type: format,
            quality,
            optimizeForSpeed: true,
            clip,
          });
        } else if (element) {
          screenshot = await element.screenshot({
            type: format,
            quality,
            optimizeForSpeed: true,
          });
        } else {
          screenshot = await page.screenshot({
            type: format,
            fullPage,
            quality,
            optimizeForSpeed: true,
          });
        }
      } finally {
        await restoreWindow();
      }

      // A single colour over the whole image is what a window that produced no
      // rendered frame delivers. The captured area can also be one colour by
      // itself, so this is reported alongside the image instead of failing.
      // Only PNG is checked: decoding a lossy format would need a decoder this
      // package does not have.
      const uniform = format === 'png' && (await isUniformPng(screenshot));

      if (request.params.uid) {
        response.appendResponseLine(
          `Took a screenshot of node with uid "${request.params.uid}".`,
        );
      } else if (fullPage) {
        response.appendResponseLine(
          'Took a screenshot of the full current page.',
        );
      } else {
        response.appendResponseLine(
          "Took a screenshot of the current page's viewport.",
        );
      }

      if (uniform) {
        response.appendResponseLine(
          'Warning: the screenshot is a single colour over the whole image. Either the captured area really is one colour, or the browser window handed back a frame without any rendered content.',
        );
      }

      // Narrow `format` at the point of use: in the factory form of
      // definePageTool TS widens the Schema generic, which loses the literal
      // union from zod.enum on request.params.format.
      const extension: '.png' | '.jpeg' | '.webp' =
        format === 'jpeg' ? '.jpeg' : format === 'webp' ? '.webp' : '.png';

      if (request.params.filePath) {
        const result = await context.saveFile(
          screenshot,
          request.params.filePath,
          extension,
        );
        response.appendResponseLine(`Saved screenshot to ${result.filename}.`);
      } else if (screenshot.length >= 2_000_000) {
        const {filepath} = await context.saveTemporaryFile(
          screenshot,
          `screenshot${extension}`,
        );
        response.appendResponseLine(`Saved screenshot to ${filepath}.`);
      } else {
        response.attachImage({
          mimeType: `image/${format}`,
          data: Buffer.from(screenshot).toString('base64'),
        });
      }
    },
  };
});
