/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {zod} from '../third_party/index.js';
import type {ScreenRecorder, VideoFormat} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const execFileAsync = promisify(execFile);

type SupportedVideoExtension = '.webm' | '.mp4';

const supportedExtensions: SupportedVideoExtension[] = ['.webm', '.mp4'];

/**
 * How long stopping a recording may take before the tool answers anyway. A
 * recorder whose ffmpeg is gone waits for a process exit that has already
 * happened and would otherwise never return.
 */
const STOP_TIMEOUT_MS = 10_000;

async function generateTempFilePath(
  extension: SupportedVideoExtension,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-devtools-mcp-'));
  return path.join(dir, `screencast${extension}`);
}

function ffmpegMissingError(): Error {
  return new Error(
    'ffmpeg is required for screencast recording but was not found. ' +
      'Install ffmpeg (https://ffmpeg.org/) and ensure it is available in your PATH.',
  );
}

/**
 * A muxer option the recorder passes for a format, and the ffmpeg release that
 * introduced it.
 */
interface MuxerRequirement {
  muxer: string;
  option: string;
  value: string;
  introducedIn: string;
}

/**
 * What the recorder demands of ffmpeg per format. An ffmpeg that does not know
 * the option exits before it writes a single byte, leaving an empty file, and
 * every frame written into the dead process afterwards fails on a pipe nobody
 * reads.
 */
const muxerRequirements: Partial<Record<VideoFormat, MuxerRequirement>> = {
  mp4: {
    muxer: 'mp4',
    option: 'movflags',
    value: 'hybrid_fragmented',
    introducedIn: 'ffmpeg 7.1',
  },
};

const formatSupport = new Map<string, boolean>();

/**
 * Whether the ffmpeg at hand accepts the options a recording in this format
 * needs. The binary is asked about the option itself rather than about its
 * version, and the answer is kept per binary and format because it cannot
 * change while the server runs. An ffmpeg that fails the question, or answers
 * without mentioning the option at all, counts as capable: an answer that says
 * nothing is no proof of a missing option.
 */
async function supportsFormat(
  ffmpegPath: string,
  format: VideoFormat,
): Promise<boolean> {
  const requirement = muxerRequirements[format];
  if (!requirement) {
    return true;
  }
  const cacheKey = `${ffmpegPath} ${format}`;
  const cached = formatSupport.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let supported = true;
  try {
    const {stdout} = await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-h',
      `muxer=${requirement.muxer}`,
    ]);
    if (stdout.includes(`-${requirement.option}`)) {
      supported = stdout.includes(requirement.value);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw ffmpegMissingError();
    }
  }
  formatSupport.set(cacheKey, supported);
  return supported;
}

function unsupportedFormatError(
  ffmpegPath: string,
  format: VideoFormat,
  requirement: MuxerRequirement,
): Error {
  return new Error(
    `The ffmpeg at "${ffmpegPath}" cannot record ${format}: its ${requirement.muxer} muxer ` +
      `rejects "-${requirement.option} ${requirement.value}", which the recorder passes for this ` +
      `format and which ${requirement.introducedIn} introduced. Such a recording produces an empty ` +
      `file. Record to a .webm path instead, or point --experimental-ffmpeg-path at ` +
      `${requirement.introducedIn} or newer.`,
  );
}

interface FrameWriteGuard {
  /** Releases the guard and reports how many frame writes failed. */
  release(): number;
}

function reportToStderr(message: string): void {
  process.stderr.write(`[screencast] ${message}\n`);
}

/**
 * Keeps a recording whose ffmpeg has died from taking the server down with it.
 *
 * The recorder writes every captured frame into ffmpeg's stdin. Once that
 * process is gone, the write fails on a pipe nobody reads: Node raises the
 * EPIPE as an unhandled error event on the pipe, which ends this process, and
 * the recorder reports the failed write through `console.log`, which lands on
 * stdout, where the MCP protocol lives. For the lifetime of a recording both go
 * to stderr instead, and every other exception keeps its default handling.
 */
function guardFrameWrites(): FrameWriteGuard {
  let failedWrites = 0;
  const originalLog = console.log;

  // A write that fails on a pipe whose reader is already gone is reported
  // through the callback rather than as an exception, and the recorder passes
  // it on with `console.log`. While a recording runs that channel carries
  // nothing else, so each line counts as a lost frame.
  console.log = (...values: unknown[]) => {
    failedWrites++;
    reportToStderr(values.map(value => String(value)).join(' '));
  };

  const onUncaughtException = (
    error: Error & {code?: string; syscall?: string},
  ) => {
    if (error.code !== 'EPIPE' || error.syscall !== 'write') {
      // Not the recorder's pipe: let the default handling take over.
      throw error;
    }
    failedWrites++;
    reportToStderr(`frame write failed: ${error.message}`);
  };
  process.on('uncaughtException', onUncaughtException);

  return {
    release() {
      process.off('uncaughtException', onUncaughtException);
      console.log = originalLog;
      return failedWrites;
    },
  };
}

let frameWriteGuard: FrameWriteGuard | null = null;

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return null;
  }
}

export const startScreencast = definePageTool(args => ({
  name: 'screencast_start',
  description: `Starts recording a screencast (video) of the selected page in specified format.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
    conditions: ['experimentalScreencast'],
  },
  schema: {
    filePath: zod
      .string()
      .optional()
      .describe(
        `Output file path (${supportedExtensions.join(',')} are supported). Uses mkdtemp to generate a unique path if not provided.`,
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: ['filePath'],
  handler: async (request, response, context) => {
    if (context.getScreenRecorder() !== null) {
      response.appendResponseLine(
        'Error: a screencast recording is already in progress. Use screencast_stop to stop it before starting a new one.',
      );
      return;
    }

    const requestedFilePath = request.params.filePath;
    const ffmpegPath = args?.experimentalFfmpegPath ?? 'ffmpeg';

    // Match the extension case-insensitively so e.g. `.WEBM` is recognized as
    // WebM. An explicitly requested but unsupported extension is rejected
    // rather than being silently rewritten to `.mp4` (which would change both
    // the format and the output path from what was requested). A missing
    // extension falls back to `.mp4`. The matched extension is normalized to
    // lower case. Without a requested path the format follows what the ffmpeg
    // at hand can produce, so the generated path is a file that can be played.
    let enforcedExtension: SupportedVideoExtension;
    if (requestedFilePath === undefined) {
      enforcedExtension = (await supportsFormat(ffmpegPath, 'mp4'))
        ? '.mp4'
        : '.webm';
    } else {
      const requestedExtension = path.extname(requestedFilePath);
      const matchedExtension = supportedExtensions.find(
        supportedExtension =>
          supportedExtension === requestedExtension.toLowerCase(),
      );
      if (!matchedExtension && requestedExtension !== '') {
        throw new Error(
          `Unsupported screencast file extension "${requestedExtension}". ` +
            `Supported formats: ${supportedExtensions.join(', ')} (case-insensitive).`,
        );
      }
      enforcedExtension = matchedExtension ?? '.mp4';
    }

    const format = enforcedExtension.substring(1) as VideoFormat;
    const requirement = muxerRequirements[format];
    if (requirement && !(await supportsFormat(ffmpegPath, format))) {
      throw unsupportedFormatError(ffmpegPath, format, requirement);
    }

    const filePath =
      requestedFilePath ?? (await generateTempFilePath(enforcedExtension));
    const resolvedPath = await context.ensureExtension(
      filePath,
      enforcedExtension,
    );

    const page = request.page;

    // A guard without a recording behind it can only be a leftover.
    frameWriteGuard?.release();
    frameWriteGuard = null;
    const guard = guardFrameWrites();
    let recorder: ScreenRecorder;
    try {
      recorder = await page.pptrPage.screencast({
        path: resolvedPath,
        format: format,
        ffmpegPath: args?.experimentalFfmpegPath,
      });
    } catch (err) {
      guard.release();
      // If we generated a temporary directory for this recording, remove it so
      // a failed start (e.g. ffmpeg missing) does not leak an empty directory.
      if (requestedFilePath === undefined) {
        try {
          await fs.rm(path.dirname(resolvedPath), {
            recursive: true,
            force: true,
          });
        } catch {
          // no-op
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT') && message.includes('ffmpeg')) {
        throw ffmpegMissingError();
      }
      throw err;
    }

    frameWriteGuard = guard;
    context.setScreenRecorder({recorder, filePath: resolvedPath});

    response.appendResponseLine(
      `Screencast recording started. The recording will be saved to ${resolvedPath}. Use ${stopScreencast.name} to stop recording.`,
    );
  },
}));

export const stopScreencast = definePageTool({
  name: 'screencast_stop',
  description: 'Stops the active screencast recording on the selected page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
    conditions: ['experimentalScreencast'],
  },
  schema: {},
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (_request, response, context) => {
    const data = context.getScreenRecorder();
    if (!data) {
      response.appendResponseLine(
        'Error: no active screencast recording to stop.',
      );
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      // A recorder whose ffmpeg exited waits for a process exit that has
      // already happened, so the wait is bounded and the caller gets an answer
      // either way.
      const stopPromise = data.recorder.stop().then(() => true);
      const stopped = await Promise.race([
        stopPromise,
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        }),
      ]);
      const failedWrites = frameWriteGuard?.release() ?? 0;
      frameWriteGuard = null;
      const size = await fileSize(data.filePath);

      if (!stopped) {
        // The recorder is on its own from here; a failure it reports later has
        // no caller left to hand it to.
        stopPromise.catch((error: unknown) => {
          reportToStderr(`recorder failed to shut down: ${String(error)}`);
        });
        response.appendResponseLine(
          `The screencast recorder did not shut down within ${STOP_TIMEOUT_MS}ms; the recording at ${data.filePath} may be incomplete.`,
        );
      } else {
        response.appendResponseLine(
          `The screencast recording has been stopped and saved to ${data.filePath}.`,
        );
      }
      if (failedWrites > 0) {
        response.appendResponseLine(
          `The ffmpeg process ended during the recording; ${failedWrites} frames could not be written.`,
        );
      }
      if (size === 0) {
        response.appendResponseLine(
          failedWrites > 0
            ? 'The file is empty: ffmpeg ended before it wrote any video.'
            : 'The file is empty: no video was produced. A page that never repaints delivers no frames, and fewer than two frames yield no video at all.',
        );
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      frameWriteGuard?.release();
      frameWriteGuard = null;
      context.setScreenRecorder(null);
    }
  },
});
