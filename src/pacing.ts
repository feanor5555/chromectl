/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Human pacing: the timing the keystroke brake works to, and the per-call
 * budget derived from it.
 *
 * A braked call lasts as long as the text it types, so a fixed per-call ceiling
 * either cuts an honest input off in the middle of a field or is so wide that a
 * hung daemon is never noticed. `callBudgetMs` therefore derives the ceiling
 * from the work the call actually carries: the fixed overhead every call pays,
 * plus the worst case of the pauses and characters it types, plus the wait a
 * caller's own `timeout` argument asks for, plus a safety margin of 1.5, and
 * never less than the 60 s floor that ends a hung daemon.
 *
 * The figures the brake works to: a key stays down 70–140 ms, the gap to the
 * next press is 15–80 ms, and every paced action is preceded by a 250–700 ms
 * pause. A target the page had to jump to costs a further 1000–1200 ms before
 * the action follows. The pointer reaches that target along a drawn path of
 * 8–20 points with 8–45 ms between them, and the pause in front of the action
 * pays for it: what is left of it once the path's own duration is known is what
 * is waited out. A 400–900 ms settle window follows the action, charged per
 * action like the pauses, because the wrapper that waits it out is entered once
 * per action and a form of many short fields is one call of many actions. Every
 * one of those intervals is drawn afresh through `drawSkewed`, which is the
 * single place the brake takes a value from.
 *
 * A call passes two ceilings, not one, because it can stand in line before it
 * does anything: the wait for the process-wide tool mutex is capped by
 * `MUTEX_WAIT_CEILING_MS`, and `callBudgetMs` applies to the work that begins
 * once the mutex is held. Both are hard maximums, and neither can be spent by
 * the other.
 *
 * A single CDP command is bounded twice as well, and the two are not the same
 * bound: `DISPATCH_DEADLINE_MS` is what a tool waits for a command it
 * dispatched, and `PROTOCOL_TIMEOUT_MS` is what the connection allows any
 * command at all. The second is the wider of the two on purpose — a tool that
 * grants one command a long window has to be the one whose timeout fires.
 *
 * Every layer one call passes through takes its deadline from here — the front,
 * the daemon socket and the MCP request inside the daemon — so the three cannot
 * drift apart. None of them sees the moment the mutex is acquired, so each of
 * them grants `queuedCallBudgetMs`, the sum of the two ceilings. The inner
 * layers add `INNER_BUDGET_SLACK_MS` on top, so the outermost layer is the one
 * whose timer fires first and reports.
 *
 * Human pacing is what every call gets unless it says otherwise. The way out is
 * `PACE_FULL`, selected per call by the full-speed switch, and it exists for our
 * own pages: there is nobody there to fool, so every wait is pure cost. The two
 * profiles are the only ones — there is no third, no scaling factor and no
 * environment variable that could make full speed a machine's silent default.
 */

/** Shortest and longest a single key stays down. */
export const KEY_HOLD_MIN_MS = 70;
export const KEY_HOLD_MAX_MS = 140;

/**
 * Shortest and longest gap between the release of one key and the next press.
 * The distribution is right-skewed: most gaps sit near the lower end, the long
 * ones are the rare tail.
 */
export const KEY_INTERVAL_MIN_MS = 15;
export const KEY_INTERVAL_MAX_MS = 80;

/**
 * Worst case of one typed character: the key is held, then the gap follows.
 * The pace this bounds averages around 140 ms per character, some 430
 * keystrokes a minute.
 */
export const CHARACTER_MAX_MS = KEY_HOLD_MAX_MS + KEY_INTERVAL_MAX_MS;

/**
 * Shortest and longest pause taken before a single paced action reaches the
 * page — the moment a person spends looking at the next field, moving there and
 * clicking. The distribution is right-skewed like the key gaps, most pauses sit
 * near the lower end and the mean lands around 450 ms.
 */
export const PRE_ACTION_PAUSE_MIN_MS = 250;
export const PRE_ACTION_PAUSE_MAX_MS = 700;

/**
 * Shortest and longest pause after the view has jumped to bring the target into
 * it. The jump reaches the page in one step, so what is waited out is not the
 * travel but the moment after it: a person takes the new view in and finds the
 * target in it before acting. It is longer than the pre-action pause because the
 * whole view changed, and it is paid only when the page actually moved.
 */
export const SCROLL_PAUSE_MIN_MS = 1_000;
export const SCROLL_PAUSE_MAX_MS = 1_200;

/**
 * Shortest and longest a mouse button stays down on a paced click. It is short
 * enough beside the pre-action pause that the budget covers it out of its
 * safety margin rather than counting it.
 */
export const MOUSE_HOLD_MIN_MS = 150;
export const MOUSE_HOLD_MAX_MS = 195;

/**
 * Shortest and longest gap between the release of one click and the press of
 * the next one within a double click. Both are operator settings, not measured
 * values: no peer-reviewed figure for the interval inside a human double click
 * exists. The upper end is chosen so that the whole distance from the first
 * press to the second — one hold plus this gap, at most 375 ms — stays below
 * the shortest double-click threshold a desktop uses, while the lower end stays
 * far enough above zero to be a hand rather than a dispatch loop. Like the hold
 * it is short enough that the budget covers it out of its safety margin.
 */
export const MOUSE_CLICK_GAP_MIN_MS = 90;
export const MOUSE_CLICK_GAP_MAX_MS = 180;

/**
 * Shortest and longest settle window after an action has run, drawn like every
 * other interval: the moment a person spends taking in what the page now shows,
 * waited out once per action of a call. It sits on top of the helper's own wait
 * for the navigation and for a DOM that stops mutating, which is where the tool
 * learns that the page is done, so nothing depends on this window and it belongs
 * to a profile like every other interval the brake takes.
 */
export const SETTLE_MIN_MS = 400;
export const SETTLE_MAX_MS = 900;

/**
 * Fewest and most points one pointer path is sampled at. The floor keeps a
 * short hop from being a single jump, the ceiling keeps a path across a wide
 * window from becoming a stream of hundreds of events.
 */
export const POINTER_POINTS_MIN = 8;
export const POINTER_POINTS_MAX = 20;

/**
 * Shortest and longest stride between two points of a path. The distance
 * divided by the drawn stride is what decides how many points the path has,
 * before the two bounds above cut it to size.
 */
export const POINTER_STRIDE_MIN_PX = 45;
export const POINTER_STRIDE_MAX_PX = 130;

/**
 * How far the path bows off the straight line, as a fraction of its own
 * length: a hand does not travel on the line between two points, and the side
 * it bows to is a coin flip.
 */
export const POINTER_CURVATURE_MIN = 0.05;
export const POINTER_CURVATURE_MAX = 0.2;

/**
 * Shortest and longest gap between two points of a path. The points are spaced
 * so that a constant gap already produces an accelerating and decelerating
 * pointer, and the gap is drawn on top of that like every other interval.
 */
export const POINTER_STEP_GAP_MIN_MS = 8;
export const POINTER_STEP_GAP_MAX_MS = 45;

/** Worst case of one pointer path: every point of the longest one at the longest gap. */
export const POINTER_PATH_MAX_MS = POINTER_POINTS_MAX * POINTER_STEP_GAP_MAX_MS;

/** Longest gap held open before a call is allowed to navigate. */
export const NAVIGATION_GAP_MAX_MS = 2_000;

/**
 * `WaitForHelper`'s own windows, which run inside the same call: the stable-DOM
 * window, the navigation window and the navigation window armed before the
 * action.
 */
export const WAIT_FOR_HELPER_MAX_MS = 3_000 + 3_000 + 100;

/**
 * Fixed overhead of any call, whatever it does and whatever it types. Only the
 * navigation gap is paid per call: it is held once, in front of the call.
 */
export const CALL_OVERHEAD_MS = NAVIGATION_GAP_MAX_MS;

/**
 * Worst case of one paced action, all of it paid per action rather than per
 * call: `fill_form` enters the wrapper once per element, so a form of many
 * short fields pays every one of these as often as it has elements.
 *
 * The pause before the action and the path the pointer travels are one term,
 * not two: the pause is what the path is taken out of, and what is left of it
 * is waited out, so an action pays the longer of the two and never both.
 */
export const ACTION_OVERHEAD_MS =
  Math.max(PRE_ACTION_PAUSE_MAX_MS, POINTER_PATH_MAX_MS) +
  SCROLL_PAUSE_MAX_MS +
  SETTLE_MAX_MS +
  WAIT_FOR_HELPER_MAX_MS;

/** Margin on top of the worst case, for everything not counted here. */
export const BUDGET_SAFETY_FACTOR = 1.5;

/**
 * No call is granted less than this. A call that types nothing keeps the
 * ceiling it has always had, and a daemon that hangs still ends.
 */
export const MIN_CALL_BUDGET_MS = 60_000;

/**
 * Longest a call may wait for the browser to become free before it gives up.
 * Waiting is not work: a braked fill holds the browser for minutes, and a call
 * queued behind it must not spend its work budget standing in line. The ceiling
 * is fixed rather than derived, because what a call waits out is the call ahead
 * of it and has nothing to do with what it is going to type itself.
 */
export const MUTEX_WAIT_CEILING_MS = 180_000;

/**
 * How much wider every inner ceiling is than the outer one it sits under. The
 * outermost timer has to fire first, otherwise an inner socket dies and the
 * caller is told about that instead of about the deadline it set.
 */
export const INNER_BUDGET_SLACK_MS = 10_000;

/**
 * The widest window any single tool grants one command: the helper's stable-DOM
 * window of 3 s (`WaitForHelper`), stretched by the CPU throttling rate the
 * emulation tool allows up to 20×. The navigation window is stretched by the
 * network multiplier instead, whose slowest profile is 10×, so 60 s is the
 * maximum of the two.
 */
export const WIDEST_TOOL_WINDOW_MS = 3_000 * 20;

/**
 * Longest a single CDP command may stay unanswered before the connection gives
 * up on it. Puppeteer's own default is 180 s, which is the whole ceiling a call
 * queued behind this one may wait — so a command that never comes back would
 * hold the browser for three minutes and the caller be told nothing about why.
 *
 * This is the connection's backstop, not the deadline a dispatch works to. It
 * has to be wider than the widest window a tool grants one command, otherwise
 * it cuts a legitimate wait off from underneath the tool that set it: an
 * `evaluate` under 20× CPU throttling is given 60 s by the stable-DOM window,
 * and a connection that gave up at 13 s ended that wait without anyone hearing
 * of it. It therefore keeps the "inner is wider" invariant of this file — the
 * widest tool window plus the same slack every inner layer adds — so the tool's
 * own timeout is always the one that fires first and reports.
 */
export const PROTOCOL_TIMEOUT_MS =
  WIDEST_TOOL_WINDOW_MS + INNER_BUDGET_SLACK_MS;

/**
 * Longest one dispatched command is waited for before the call gives up on it.
 * This is the narrow bound the connection used to carry for everybody: it is
 * raced per command in `abandonIfBlocked` and `answerOrAbandon`, where the tool
 * knows it is dispatching an interaction rather than waiting one out.
 *
 * It covers what the dialog signal does not — a renderer in a loop, a native
 * chooser holding the page, a crashed process: nothing raises a `dialog` event
 * there, so without this deadline the call would sit on the command until the
 * connection's backstop ends it. The value is the worst case of one paced action
 * with the same margin the budget grants, well under `MUTEX_WAIT_CEILING_MS`, so
 * a call queued behind the hung one still gets its turn instead of running out.
 */
export const DISPATCH_DEADLINE_MS = Math.ceil(
  ACTION_OVERHEAD_MS * BUDGET_SAFETY_FACTOR,
);

/**
 * The timing one call works to. Every value the brake waits out is drawn from
 * an interval of this table, so the two profiles below are the whole difference
 * between a call that imitates a person and one that does not.
 */
export interface PaceProfile {
  /** What a result envelope calls this profile. */
  readonly name: 'human' | 'full';
  /** How long a single key stays down. */
  readonly keyHoldMs: readonly [number, number];
  /** The gap between the release of one key and the press of the next. */
  readonly keyIntervalMs: readonly [number, number];
  /** The pause taken before an action reaches the page. */
  readonly preActionPauseMs: readonly [number, number];
  /** The pause taken after the view has jumped to the target. */
  readonly scrollPauseMs: readonly [number, number];
  /** How long the mouse button stays down on a click. */
  readonly mouseHoldMs: readonly [number, number];
  /**
   * The gap between the release of one click and the press of the next inside a
   * double click.
   */
  readonly mouseClickGapMs: readonly [number, number];
  /** The gap between two points of the path the pointer travels. */
  readonly pointerStepGapMs: readonly [number, number];
  /**
   * Whether the pointer reaches its target along a path at all. Where it does
   * not, the only move dispatched is the one that puts it on the target.
   */
  readonly travelsPointer: boolean;
  /** The window waited out after an action has run. */
  readonly settleMs: readonly [number, number];
  /**
   * Whether a text field takes its value in one shot instead of keystroke by
   * keystroke. Nothing about a value set directly can be paced, which is why
   * this belongs to the profile rather than to the field.
   */
  readonly fillsInOneShot: boolean;
}

/** The default: every interval as a person produces it. */
export const PACE_HUMAN: PaceProfile = {
  name: 'human',
  keyHoldMs: [KEY_HOLD_MIN_MS, KEY_HOLD_MAX_MS],
  keyIntervalMs: [KEY_INTERVAL_MIN_MS, KEY_INTERVAL_MAX_MS],
  preActionPauseMs: [PRE_ACTION_PAUSE_MIN_MS, PRE_ACTION_PAUSE_MAX_MS],
  scrollPauseMs: [SCROLL_PAUSE_MIN_MS, SCROLL_PAUSE_MAX_MS],
  mouseHoldMs: [MOUSE_HOLD_MIN_MS, MOUSE_HOLD_MAX_MS],
  mouseClickGapMs: [MOUSE_CLICK_GAP_MIN_MS, MOUSE_CLICK_GAP_MAX_MS],
  pointerStepGapMs: [POINTER_STEP_GAP_MIN_MS, POINTER_STEP_GAP_MAX_MS],
  travelsPointer: true,
  settleMs: [SETTLE_MIN_MS, SETTLE_MAX_MS],
  fillsInOneShot: false,
};

/** The way out: no interval left, and fields take their value in one shot. */
export const PACE_FULL: PaceProfile = {
  name: 'full',
  keyHoldMs: [0, 0],
  keyIntervalMs: [0, 0],
  preActionPauseMs: [0, 0],
  scrollPauseMs: [0, 0],
  mouseHoldMs: [0, 0],
  mouseClickGapMs: [0, 0],
  pointerStepGapMs: [0, 0],
  travelsPointer: false,
  settleMs: [0, 0],
  fillsInOneShot: true,
};

/**
 * The profile the call currently in flight runs at. Calls serialize on the
 * process-wide tool mutex, so one profile at a time is the whole truth here;
 * `selectPace` is called by the funnel that holds that mutex.
 */
let activePace: PaceProfile = PACE_HUMAN;

/** The profile of the call in flight, which every paced value is drawn from. */
export function currentPace(): PaceProfile {
  return activePace;
}

/**
 * Puts one call's profile in place and hands back the restore, so a call cannot
 * leave its profile behind for the next one.
 */
export function selectPace(fullSpeed: boolean): () => void {
  const previous = activePace;
  activePace = fullSpeed ? PACE_FULL : PACE_HUMAN;
  return () => {
    activePace = previous;
  };
}

/**
 * How the switch travels inside the MCP request: as request metadata, not as a
 * tool argument. It is ours and upstream's tools know nothing of it, so it
 * appears in no tool schema, in no generated CLI option and in no argument the
 * caller has to have declared.
 */
export const FULL_SPEED_META_KEY = 'chromectl/fullSpeed';

/** Whether one request's metadata carries the switch. */
export function isFullSpeedRequest(meta?: Record<string, unknown>): boolean {
  return meta?.[FULL_SPEED_META_KEY] === true;
}

/**
 * Shape of every draw. A uniform value raised to this power lands near the
 * lower bound most of the time and reaches the upper one rarely — the shape a
 * typist produces, and the one a flat draw with its sharp cut at both ends does
 * not. The mean sits at `1 / (PACING_SKEW + 1)` of the interval, so a key gap
 * averages 41 ms of its 15–80 ms range, a hold 98 ms of its 70–140 ms, hence
 * about 139 ms per character, and a pre-action pause 430 ms.
 */
export const PACING_SKEW = 1.5;

/**
 * One draw from an interval, right-skewed. Every magnitude the brake works to
 * comes from here — the waits, and the stride and the curvature of the path the
 * pointer travels — so all of them share one shape and none repeats the
 * previous one by construction. A uniform choice of one out of n, which edge of
 * the viewport and which side a path bows to, is a coin flip and takes
 * `Math.random` directly.
 */
export function drawSkewed(min: number, max: number): number {
  return min + (max - min) * Math.random() ** PACING_SKEW;
}

/** The same draw for an interval of time, rounded to whole milliseconds. */
export function drawPacingMs(minMs: number, maxMs: number): number {
  return Math.round(drawSkewed(minMs, maxMs));
}

/**
 * Waits a fixed number of milliseconds. A wait of nothing is not scheduled at
 * all: at full speed every interval is zero, and a timer per keystroke would
 * put back a part of what the profile exists to remove.
 */
export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** Draws one interval, waits it out and reports what it waited. */
export async function pacedSleep(
  minMs: number,
  maxMs: number,
): Promise<number> {
  const ms = drawPacingMs(minMs, maxMs);
  await sleepMs(ms);
  return ms;
}

/** Draws from one interval of the profile the call in flight runs at. */
function drawFromPace(range: readonly [number, number]): number {
  return drawPacingMs(range[0], range[1]);
}

/** Waits out one interval of that profile and reports what it waited. */
function sleepAtPace(range: readonly [number, number]): Promise<number> {
  return pacedSleep(range[0], range[1]);
}

/** How long the next key stays down. */
export function drawKeyHoldMs(): number {
  return drawFromPace(activePace.keyHoldMs);
}

/** The gap between the release of one key and the press of the next. */
export function sleepKeyIntervalMs(): Promise<number> {
  return sleepAtPace(activePace.keyIntervalMs);
}

/** How long the mouse button stays down on the next paced click. */
export function drawMouseHoldMs(): number {
  return drawFromPace(activePace.mouseHoldMs);
}

/**
 * The gap between two clicks of one double click, waited out between the
 * release of the first and the press of the second.
 */
export function sleepMouseClickGapMs(): Promise<number> {
  return sleepAtPace(activePace.mouseClickGapMs);
}

/**
 * The pause a person spends before acting: reaching the next field, looking at
 * it, moving there. It is taken before the action begins, not after it.
 */
export function pauseBeforeAction(): Promise<number> {
  return sleepAtPace(activePace.preActionPauseMs);
}

/**
 * The same pause as a figure, for an action that spends part of it moving the
 * pointer to its target: the target's coordinates are not known when the pause
 * is drawn, so it is reserved here and waited out once the path is drawn and
 * what is left of it is known.
 */
export function drawPreActionPauseMs(): number {
  return drawFromPace(activePace.preActionPauseMs);
}

/** Whether the pointer reaches its target along a path at this pace. */
export function travelsPointer(): boolean {
  return activePace.travelsPointer;
}

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
  const stride = drawSkewed(POINTER_STRIDE_MIN_PX, POINTER_STRIDE_MAX_PX);
  const count = Math.min(
    POINTER_POINTS_MAX,
    Math.max(POINTER_POINTS_MIN, Math.round(distance / stride)),
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
    const gapMs = drawFromPace(activePace.pointerStepGapMs);
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

/**
 * The pause after the view has jumped to the target, taken before the action
 * that needed the target proceeds. `scrolled` says whether the page moved at
 * all: an element that was inside the viewport already costs nothing, because
 * nothing about the view changed for anyone watching it.
 */
export async function pauseAfterScroll(scrolled: boolean): Promise<number> {
  if (!scrolled) {
    return 0;
  }
  return await sleepAtPace(activePace.scrollPauseMs);
}

/**
 * The window that follows an action, waited out on top of the helper's own wait
 * for a navigation and for a DOM that stops mutating. Those two end the moment
 * the page goes quiet, which puts the next call a fixed ~100 ms after the last
 * mutation every time; this window is what a person spends taking in what the
 * page now shows. It is drawn from the profile of the call in flight, so at full
 * speed nothing of it is left — what the helper waits out for the page is
 * untouched by that and runs at every pace.
 */
export function settleAfterAction(): Promise<number> {
  return sleepAtPace(activePace.settleMs);
}

/**
 * Holds the minimum gap open between two navigations of the same target: the
 * remainder of `NAVIGATION_GAP_MAX_MS` since the previous one ended, or nothing
 * when that long has passed already or nothing has navigated yet. A fast page
 * load is not suspicious, a fast sequence of them is, and the sequence is the
 * one signal a site gets without running any script.
 */
export async function holdNavigationGap(
  previousNavigationEndedAtMs: number | undefined,
): Promise<number> {
  if (previousNavigationEndedAtMs === undefined) {
    return 0;
  }
  const remainingMs = Math.max(
    0,
    NAVIGATION_GAP_MAX_MS - (Date.now() - previousNavigationEndedAtMs),
  );
  await sleepMs(remainingMs);
  return remainingMs;
}

/** The arguments of one tool call, as they arrive over the daemon socket. */
type ToolArguments = Record<string, unknown>;

/** One entry of `fill_form`'s `elements` argument. */
interface FormElement {
  value?: unknown;
}

/** The work of one call, in the terms the budget is derived from. */
interface CallWork {
  /** Characters typed one by one. */
  characters: number;
  /**
   * Paced actions, each paying its own pre-action pause, the pause after the
   * jump that brings its target into view, the settle window behind it and the
   * helper's own windows around it.
   */
  actions: number;
  /**
   * Longest the call may sit waiting on a `timeout` the caller set itself. It
   * is not pacing and no profile shortens it: what it bounds is a page the call
   * waits for, so it counts at every speed.
   */
  waitMs: number;
}

/**
 * Counts code points rather than UTF-16 units, because the typing loop walks
 * the text code point by code point and sends one keystroke per code point.
 */
function characterCount(value: unknown): number {
  return typeof value === 'string' ? Array.from(value).length : 0;
}

/**
 * The wait one call's own `timeout` argument asks for. Every tool that takes
 * one takes it under that name and in milliseconds (`timeoutSchema`), so it is
 * read off the arguments rather than per tool: `wait_for` waits out a text that
 * may never appear, `navigate_page` and `new_page` a load that may never
 * finish, and all three may be told to wait longer than the floor grants.
 *
 * Anything the schema itself drops counts as nothing: zero and below select the
 * tool's own default, which is short enough to sit inside the fixed overhead.
 */
function callerWaitMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** What one tool call types, in how many separate actions, and what it waits. */
function callWork(tool: string | undefined, args: ToolArguments): CallWork {
  const waitMs = callerWaitMs(args.timeout);
  switch (tool) {
    case 'type_text':
      return {characters: characterCount(args.text), actions: 1, waitMs};
    case 'fill':
      return {characters: characterCount(args.value), actions: 1, waitMs};
    case 'fill_form': {
      const elements: FormElement[] = Array.isArray(args.elements)
        ? (args.elements as FormElement[])
        : [];
      const characters = elements.reduce(
        (total, element) => total + characterCount(element?.value),
        0,
      );
      return {characters, actions: Math.max(1, elements.length), waitMs};
    }
    default:
      return {characters: 0, actions: 1, waitMs};
  }
}

/**
 * How long one call may take. Called without a tool name it yields the budget
 * of a call that types nothing, which is what a daemon control message gets.
 *
 * A call at full speed pays for no pacing at all, so it falls back to the floor
 * whatever it types: what is left of it are the waits for the page, which the
 * floor has always covered. The one exception is a wait the caller asked for by
 * name — no profile makes a page arrive sooner, so that wait is counted at
 * either speed.
 */
export function callBudgetMs(
  tool?: string,
  args?: ToolArguments,
  fullSpeed = false,
): number {
  const {characters, actions, waitMs} = callWork(tool, args ?? {});
  const paced = fullSpeed
    ? 0
    : CALL_OVERHEAD_MS +
      actions * ACTION_OVERHEAD_MS +
      characters * CHARACTER_MAX_MS;
  return Math.max(
    MIN_CALL_BUDGET_MS,
    Math.ceil((paced + waitMs) * BUDGET_SAFETY_FACTOR),
  );
}

/**
 * What a layer outside the mutex has to grant: the wait for the browser plus
 * the work that follows it. Such a layer cannot see the moment the mutex is
 * acquired, so it has to cover both.
 *
 * The sum stays honest about which ceiling was hit. The wait is cut off at
 * `MUTEX_WAIT_CEILING_MS` by the funnel that holds the mutex, which reports
 * that case itself, so a call that runs out here has been working for the whole
 * budget and it is the work that ran over.
 */
export function queuedCallBudgetMs(
  tool?: string,
  args?: ToolArguments,
  fullSpeed = false,
): number {
  return MUTEX_WAIT_CEILING_MS + callBudgetMs(tool, args, fullSpeed);
}

/** The same budget for a layer that sits inside the one holding `outerMs`. */
export function innerBudgetMs(outerMs: number): number {
  return outerMs + INNER_BUDGET_SLACK_MS;
}
