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
 * pause. The 400–900 ms settle window after an action waits for the page rather
 * than imitating a person and is part of the fixed overhead.
 *
 * Every layer one call passes through takes its deadline from here — the front,
 * the daemon socket and the MCP request inside the daemon — so the three cannot
 * drift apart. The inner layers add `INNER_BUDGET_SLACK_MS` on top, so the
 * outermost layer is the one whose timer fires first and reports.
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

/** Longest settle window after an action has run. */
export const SETTLE_MAX_MS = 900;

/** Longest gap held open before a call is allowed to navigate. */
export const NAVIGATION_GAP_MAX_MS = 2_000;

/**
 * `WaitForHelper`'s own windows, which run inside the same call: the stable-DOM
 * window, the navigation window and the navigation window armed before the
 * action.
 */
export const WAIT_FOR_HELPER_MAX_MS = 3_000 + 3_000 + 100;

/** Fixed overhead of any call, whatever it does and whatever it types. */
export const CALL_OVERHEAD_MS =
  SETTLE_MAX_MS + NAVIGATION_GAP_MAX_MS + WAIT_FOR_HELPER_MAX_MS;

/** Margin on top of the worst case, for everything not counted here. */
export const BUDGET_SAFETY_FACTOR = 1.5;

/**
 * No call is granted less than this. A call that types nothing keeps the
 * ceiling it has always had, and a daemon that hangs still ends.
 */
export const MIN_CALL_BUDGET_MS = 60_000;

/**
 * How much wider every inner ceiling is than the outer one it sits under. The
 * outermost timer has to fire first, otherwise an inner socket dies and the
 * caller is told about that instead of about the deadline it set.
 */
export const INNER_BUDGET_SLACK_MS = 10_000;

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
  /** Paced actions, each paying its own pre-action pause. */
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
 */
export function callBudgetMs(tool?: string, args?: ToolArguments): number {
  const {characters, actions} = pacedWork(tool, args ?? {});
  const work =
    CALL_OVERHEAD_MS +
    actions * PRE_ACTION_PAUSE_MAX_MS +
    characters * CHARACTER_MAX_MS;
  return Math.max(MIN_CALL_BUDGET_MS, Math.ceil(work * BUDGET_SAFETY_FACTOR));
}

/** The same budget for a layer that sits inside the one holding `outerMs`. */
export function innerBudgetMs(outerMs: number): number {
  return outerMs + INNER_BUDGET_SLACK_MS;
}
