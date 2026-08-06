/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How the pointer gets from where it stands to where an interaction needs it:
 * along a drawn curve, one event per point of it, on a schedule kept by the
 * clock.
 *
 * It lives outside `tools/` because everything a module in there exports is
 * taken for a tool.
 */

import {
  abandonIfBlocked,
  answerOrAbandon,
  currentInterruption,
} from './interruption.js';
import {
  drawPointerPath,
  drawViewportEdgePoint,
  sleepMs,
  type PointerPoint,
} from './pacing.js';
import type {CdpPage, ElementHandle} from './third_party/index.js';
import type {ContextPage} from './tools/ToolDefinition.js';
import {logger} from './utils/logger.js';

/** The size of the layout viewport when nothing is known about it. */
const FALLBACK_VIEWPORT = {width: 1280, height: 800} as const;

/**
 * How large the page's layout viewport is, in the CSS pixels the pointer is
 * moved in. It is read off the page's own session, and the two fallbacks behind
 * it exist so that a pointer with nowhere to start from still starts somewhere:
 * the emulated viewport, and a common window size.
 */
async function layoutViewportSize(
  page: ContextPage,
): Promise<{width: number; height: number}> {
  try {
    const client = (page.pptrPage as unknown as CdpPage)._client();
    const metrics = await answerOrAbandon(client.send('Page.getLayoutMetrics'));
    const {clientWidth, clientHeight} = metrics.cssLayoutViewport;
    if (clientWidth > 0 && clientHeight > 0) {
      return {width: clientWidth, height: clientHeight};
    }
  } catch (error) {
    logger?.('failed to read the layout viewport', error);
  }
  const viewport = page.pptrPage.viewport();
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    return {width: viewport.width, height: viewport.height};
  }
  return FALLBACK_VIEWPORT;
}

/**
 * Where the pointer sets off from: where it stands, or a drawn spot on the edge
 * of the viewport for a page nothing has moved it on yet. A belief that turns
 * out to be wrong costs nothing — it decides where a path starts, and the path
 * always ends on the move that carries the interaction's own conditions.
 */
async function pointerStart(page: ContextPage): Promise<PointerPoint> {
  const known = page.pointerPosition;
  if (known) {
    return known;
  }
  const {width, height} = await layoutViewportSize(page);
  return drawViewportEdgePoint(width, height);
}

/**
 * Moves the pointer to a spot the way a hand does: along a drawn curve, one
 * `mouse.move` per point of it, each its own mousemove event. `mouse.move` is
 * used rather than a raw CDP send because it also carries puppeteer's own
 * pointer position, which is where the press is dispatched.
 *
 * The schedule is kept by the clock rather than by the sleeps: a point is due
 * at the sum of the gaps in front of it, and what is waited after a move is
 * whatever is left until then. A link that makes every move a round trip is
 * absorbed that way instead of being added to the path's drawn duration.
 *
 * What is left of the pause reserved before the action is waited out first, so
 * the action costs what it always cost: the pause, or the path when the path is
 * the longer of the two.
 *
 * The loop stops where it stands once the page it moves on has begun to leave
 * or has raised a dialog, like every other paced stream. Where it runs to the
 * end, the target is written down as the pointer's place: the move that carries
 * the interaction follows immediately and is what puts it exactly there.
 */
export async function travelPaced(
  page: ContextPage,
  to: PointerPoint,
): Promise<void> {
  const mouse = page.pptrPage.mouse;
  const path = drawPointerPath(await pointerStart(page), to);
  await sleepMs(page.takeLeadPause() - path.durationMs);
  let dueAtMs = Date.now();
  for (const point of path.points) {
    if (currentInterruption()) {
      return;
    }
    dueAtMs += point.gapMs;
    await abandonIfBlocked(mouse.move(point.x, point.y));
    page.setPointerPosition(point);
    await sleepMs(dueAtMs - Date.now());
  }
  page.setPointerPosition(to);
}

/** The same to an element's own point, resolved after it has been scrolled to. */
export async function travelToElement(
  page: ContextPage,
  handle: ElementHandle<Element>,
): Promise<void> {
  await travelPaced(page, await answerOrAbandon(handle.clickablePoint()));
}

/**
 * Writes down that the pointer now stands on this element, for an interaction
 * that left it somewhere other than where it travelled to — a drag ends on the
 * element it dropped onto, not on the one it picked up.
 *
 * It is a belief and nothing depends on it, so a point that cannot be resolved
 * any more leaves the previous one standing rather than ending the call that
 * has already done its work.
 */
export async function recordPointerOn(
  page: ContextPage,
  handle: ElementHandle<Element>,
): Promise<void> {
  try {
    page.setPointerPosition(await answerOrAbandon(handle.clickablePoint()));
  } catch (error) {
    logger?.('failed to resolve where the pointer was left', error);
  }
}
