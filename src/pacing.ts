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
 * plus the worst case of the pauses and characters it types, plus a safety
 * margin of 1.5, and never less than the 60 s floor that ends a hung daemon.
 *
 * The figures the brake works to: a key stays down 70–140 ms, the gap to the
 * next press is 15–80 ms, and every paced action is preceded by a 250–700 ms
 * pause. A target the page had to jump to costs a further 1000–1200 ms before
 * the action follows. A 400–900 ms settle window follows the action, charged per
 * action like the pauses, because the wrapper that waits it out is entered once
 * per action and a form of many short fields is one call of many actions. Every
 * one of those intervals is drawn afresh through `drawPacingMs`, which is the
 * single place the brake takes a value from.
 *
 * A call passes two ceilings, not one, because it can stand in line before it
 * does anything: the wait for the process-wide tool mutex is capped by
 * `MUTEX_WAIT_CEILING_MS`, and `callBudgetMs` applies to the work that begins
 * once the mutex is held. Both are hard maximums, and neither can be spent by
 * the other.
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
 */
export const ACTION_OVERHEAD_MS =
  PRE_ACTION_PAUSE_MAX_MS +
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
 * One draw from an interval, right-skewed and rounded to whole milliseconds.
 * Every wait the brake takes comes from here, so all of them share one shape
 * and none repeats the previous one by construction.
 */
export function drawPacingMs(minMs: number, maxMs: number): number {
  const skewed = Math.random() ** PACING_SKEW;
  return Math.round(minMs + (maxMs - minMs) * skewed);
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

/** The paced work of one call. */
interface PacedWork {
  /** Characters typed one by one. */
  characters: number;
  /**
   * Paced actions, each paying its own pre-action pause, the pause after the
   * jump that brings its target into view, the settle window behind it and the
   * helper's own windows around it.
   */
  actions: number;
}

/**
 * Counts code points rather than UTF-16 units, because the typing loop walks
 * the text code point by code point and sends one keystroke per code point.
 */
function characterCount(value: unknown): number {
  return typeof value === 'string' ? Array.from(value).length : 0;
}

/** What one tool call types, and in how many separate actions. */
function pacedWork(tool: string | undefined, args: ToolArguments): PacedWork {
  switch (tool) {
    case 'type_text':
      return {characters: characterCount(args.text), actions: 1};
    case 'fill':
      return {characters: characterCount(args.value), actions: 1};
    case 'fill_form': {
      const elements: FormElement[] = Array.isArray(args.elements)
        ? (args.elements as FormElement[])
        : [];
      const characters = elements.reduce(
        (total, element) => total + characterCount(element?.value),
        0,
      );
      return {characters, actions: Math.max(1, elements.length)};
    }
    default:
      return {characters: 0, actions: 1};
  }
}

/**
 * How long one call may take. Called without a tool name it yields the budget
 * of a call that types nothing, which is what a daemon control message gets.
 *
 * A call at full speed pays for no pacing at all, so it falls back to the floor
 * whatever it types: what is left of it are the waits for the page, which the
 * floor has always covered.
 */
export function callBudgetMs(
  tool?: string,
  args?: ToolArguments,
  fullSpeed = false,
): number {
  if (fullSpeed) {
    return MIN_CALL_BUDGET_MS;
  }
  const {characters, actions} = pacedWork(tool, args ?? {});
  const work =
    CALL_OVERHEAD_MS +
    actions * ACTION_OVERHEAD_MS +
    characters * CHARACTER_MAX_MS;
  return Math.max(MIN_CALL_BUDGET_MS, Math.ceil(work * BUDGET_SAFETY_FACTOR));
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
