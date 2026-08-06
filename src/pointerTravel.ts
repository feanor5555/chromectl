/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How the pointer gets from where it stands to where an interaction needs it:
 * along a drawn curve, one event per point of it, on a schedule kept by the
 * clock. The geometry of that curve and the belief about where the pointer
 * stands live here as well, so that `pacing.ts` carries the timing alone and
 * the page type carries nothing of either.
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
  drawPointerStepGapMs,
  drawSkewed,
  POINTER_CURVATURE_MAX,
  POINTER_CURVATURE_MIN,
  POINTER_POINTS_MAX,
  POINTER_POINTS_MIN,
  POINTER_SHORTEST_STEP_PX,
  POINTER_STRIDE_MAX_PX,
  POINTER_STRIDE_MIN_PX,
  sleepMs,
  takeLeadPause,
} from './pacing.js';
import type {CdpPage, ElementHandle} from './third_party/index.js';
import type {ContextPage} from './tools/ToolDefinition.js';
import {logger} from './utils/logger.js';

/** A spot in the layout viewport, in CSS pixels. */
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/** One point of a pointer path, with the gap held after it. */
export interface PointerStep extends PointerPoint {
  readonly gapMs: number;
}

/** A whole path, and how long travelling it takes. */
export interface PointerPath {
  readonly points: readonly PointerStep[];
  readonly durationMs: number;
}

/**
 * Where the pointer stands on each page, as far as this process knows. It is
 * kept per page rather than per session, because puppeteer's own mouse state is
 * per page and a coordinate belongs to the document it was taken in. A
 * navigation does not clear it — a physical pointer does not move because a
 * page loaded — so a page is absent here only as long as nothing has moved on
 * it yet.
 *
 * The map is weak and keyed by the page, so a closed page takes its entry with
 * it, and the page type stays what upstream declares.
 */
const pointerPositions = new WeakMap<ContextPage, PointerPoint>();

/** Where the pointer stands on this page, if anything has moved it yet. */
export function pointerPosition(page: ContextPage): PointerPoint | undefined {
  return pointerPositions.get(page);
}

/** Writes down where the pointer now stands on this page. */
export function recordPointerAt(page: ContextPage, at: PointerPoint): void {
  pointerPositions.set(page, {x: at.x, y: at.y});
}

/**
 * Where a point at `u` of the way along the path sits in the curve's own
 * parameter. It is short at both ends and long in the middle, so a constant
 * event rate produces a pointer that accelerates away from the start and slows
 * into the target instead of one moving at a constant speed. It carries no
 * randomness and no tuning constant.
 */
function smoothstep(u: number): number {
  return 3 * u ** 2 - 2 * u ** 3;
}

/**
 * The path the pointer takes from where it stands to where it is going: a
 * quadratic Bézier whose control point sits perpendicular to the straight line
 * at the drawn curvature, sampled at as many points as the distance and the
 * drawn stride call for.
 *
 * How many points that is stays within what the distance can plausibly carry:
 * the floor is granted only as far as `POINTER_SHORTEST_STEP_PX` allows, and a
 * target the pointer already stands on is not travelled to at all.
 *
 * Both endpoints are excluded. The first is where the pointer already stands,
 * and the last is dispatched by the move that carries the interaction's own
 * conditions, which re-resolves the target rather than trusting the point this
 * was drawn against.
 *
 * Pure, so the geometry is testable without a browser.
 */
export function drawPointerPath(
  from: PointerPoint,
  to: PointerPoint,
): PointerPath {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < POINTER_SHORTEST_STEP_PX) {
    return {points: [], durationMs: 0};
  }
  const stride = drawSkewed(POINTER_STRIDE_MIN_PX, POINTER_STRIDE_MAX_PX);
  const fewest = Math.min(
    POINTER_POINTS_MIN,
    Math.floor(distance / POINTER_SHORTEST_STEP_PX),
  );
  const count = Math.min(
    POINTER_POINTS_MAX,
    Math.max(fewest, Math.round(distance / stride)),
  );
  const curvature = drawSkewed(POINTER_CURVATURE_MIN, POINTER_CURVATURE_MAX);
  // The offset is the distance times the curvature along the unit
  // perpendicular of the straight line, which leaves the line's own components
  // scaled by the curvature alone.
  const bow = curvature * (Math.random() < 0.5 ? -1 : 1);
  const control = {
    x: (from.x + to.x) / 2 - dy * bow,
    y: (from.y + to.y) / 2 + dx * bow,
  };
  const points: PointerStep[] = [];
  let durationMs = 0;
  for (let index = 1; index <= count; index++) {
    const t = smoothstep(index / (count + 1));
    const inverse = 1 - t;
    const gapMs = drawPointerStepGapMs();
    durationMs += gapMs;
    points.push({
      x: inverse ** 2 * from.x + 2 * inverse * t * control.x + t ** 2 * to.x,
      y: inverse ** 2 * from.y + 2 * inverse * t * control.y + t ** 2 * to.y,
      gapMs,
    });
  }
  return {points, durationMs};
}

/**
 * Where the pointer is taken to stand when nothing is known about it yet: a
 * spot on the perimeter of the layout viewport, drawn uniformly over the whole
 * perimeter so a wide window's long edges come up correspondingly more often.
 */
export function drawViewportEdgePoint(
  width: number,
  height: number,
): PointerPoint {
  const perimeter = 2 * (width + height);
  const along = Math.random() * perimeter;
  if (along < width) {
    return {x: along, y: 0};
  }
  if (along < width + height) {
    return {x: width, y: along - width};
  }
  if (along < 2 * width + height) {
    return {x: 2 * width + height - along, y: height};
  }
  return {x: 0, y: perimeter - along};
}

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
  const known = pointerPosition(page);
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
 * the action costs what it always cost: the reserved rest of the pause, or the
 * path when the path is the longer of the two. A travel that finds no
 * reservation is one whose call site forgot to ask for one — it then pays the
 * whole pause and the path on top of it, which is what the note in the log is
 * about.
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
  const reservedMs = takeLeadPause();
  if (reservedMs === 0 && path.points.length > 0) {
    logger?.('the pointer travelled against a pause nobody reserved');
  }
  await sleepMs(reservedMs - path.durationMs);
  let dueAtMs = Date.now();
  for (const point of path.points) {
    if (currentInterruption()) {
      return;
    }
    dueAtMs += point.gapMs;
    await abandonIfBlocked(mouse.move(point.x, point.y));
    recordPointerAt(page, point);
    await sleepMs(dueAtMs - Date.now());
  }
  recordPointerAt(page, to);
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
    recordPointerAt(page, await answerOrAbandon(handle.clickablePoint()));
  } catch (error) {
    logger?.('failed to resolve where the pointer was left', error);
  }
}
