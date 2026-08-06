/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a fill decided to do with the element, and what the response says about
 * it. Three of the six decisions write nothing, and a fill that writes nothing
 * is the one case a caller cannot see in the page afterwards: it looks exactly
 * like a fill that wrote what was asked for.
 *
 * It lives beside the input tools rather than in them, because everything a
 * module of tools exports is taken for a tool.
 */
export type FillDecision =
  /** The value went in keystroke by keystroke. */
  | 'typed'
  /** The value was set in one shot, as a field that takes no keystrokes does. */
  | 'one-shot'
  /** A checkbox, radio button or switch already read as the value. */
  | 'toggle-already-set'
  /** A field already held exactly the value. */
  | 'already-equal'
  /** An editable element already rendered exactly the value. */
  | 'already-equal-rendered'
  /** The named option exists on the combobox but carries no value of its own. */
  | 'option-without-value';

/**
 * What the response says about a decision, or nothing when the element took the
 * value and the plain success line covers it.
 */
export function fillDecisionNote(decision: FillDecision): string | undefined {
  switch (decision) {
    case 'typed':
    case 'one-shot':
      return undefined;
    case 'toggle-already-set':
      return 'The element already read as this value; it was not clicked.';
    case 'already-equal':
      return 'The element already held this value; nothing was typed.';
    case 'already-equal-rendered':
      return 'The element already held this value; nothing was typed. The comparison is on the rendered text, so content differing only in collapsed whitespace or a trailing line break counts as equal.';
    case 'option-without-value':
      return 'The option carrying this text has no value of its own; nothing was set.';
  }
}
