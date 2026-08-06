/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by the chromectl fork.
 */

import process from 'node:process';

import {
  abandonIfBlocked,
  answerOrAbandon,
  currentInterruption,
  InteractionInterruptedError,
} from '../interruption.js';
import {
  currentPace,
  drawKeyHoldMs,
  drawMouseHoldMs,
  pauseAfterScroll,
  pauseBeforeAction,
  sleepKeyIntervalMs,
  sleepMouseClickGapMs,
  sleepMs,
} from '../pacing.js';
import {_keyDefinitions, zod} from '../third_party/index.js';
import type {
  ElementHandle,
  KeyInput,
  Keyboard,
  Mouse,
  MouseOptions,
} from '../third_party/index.js';
import type {TextSnapshotNode} from '../types.js';
import {parseKey} from '../utils/keyboard.js';
import {logger} from '../utils/logger.js';
import type {WaitForEventsResult} from '../WaitForHelper.js';

import {ToolCategory} from './categories.js';
import {fillDecisionNote, type FillDecision} from './fillDecision.js';
import type {ContextPage} from './ToolDefinition.js';
import {definePageTool} from './ToolDefinition.js';

const dblClickSchema = zod
  .boolean()
  .optional()
  .describe('Set to true for double clicks. Default is false.');

const includeSnapshotSchema = zod
  .boolean()
  .optional()
  .describe('Whether to include a snapshot in the response. Default is false.');

const submitKeySchema = zod
  .string()
  .optional()
  .describe(
    'Optional key to press after typing. E.g., "Enter", "Tab", "Escape"',
  );

/**
 * The characters the US layout reaches only with Shift held. The literal
 * entries of puppeteer's key table — the ones a per-character loop presses —
 * carry no shift mapping of their own, so the set is collected from the
 * code-named entries that do: every single-character `shiftKey` in the table.
 * Pressing one of these without Shift would deliver a key event no physical
 * keyboard produces, on every capital and on the `@` of every email address.
 */
const SHIFTED_CHARACTERS: ReadonlySet<string> = new Set(
  Object.values(_keyDefinitions)
    .map(definition => definition.shiftKey)
    .filter(
      (shiftKey): shiftKey is string =>
        typeof shiftKey === 'string' && shiftKey.length === 1,
    ),
);

/** Whether the key table can press this character as a key at all. */
function isKeyboardKey(character: string): character is KeyInput {
  return Object.hasOwn(_keyDefinitions, character);
}

/**
 * Which Shift key the next shifted character takes. A hand alternates the two
 * instead of reaching for the same one on every capital, and one keystroke
 * stream is typed in more than one piece, so the side has to outlive a single
 * call.
 */
let useRightShift = false;

/**
 * Types text the way a hand does: one key at a time, each held for a drawn
 * span, each separated from the next by a drawn gap. `keyboard.type` cannot
 * express both — its single `delay` is the hold, and the gap it leaves is zero.
 *
 * The loop walks code points, as puppeteer's own does, so a character outside
 * the basic plane is not torn into surrogate halves. Three cases follow,
 * because `keyboard.press` covers only the first: a plain key, a key that needs
 * Shift held around it, and a character the table does not know at all —
 * umlauts, `ß`, emoji — which goes in as text. That last one emits no key
 * events whatever the pace, and no choice of values changes it.
 *
 * `continuesStream` says that this text picks up an earlier piece of the same
 * stream, so the gap of the key before it is still owed and is waited out
 * before the first character.
 *
 * The stream stops where it stands once the page it types into has begun to
 * leave: the test sits at the gap between two keys, where the stream is idle
 * anyway, and reads a field rather than asking the browser anything. A dialog
 * cannot wait for that gap, because the keystroke that raised it is the one it
 * is holding, so every keystroke is dispatched under the signal that gives up
 * on a command the renderer will not answer.
 */
async function typePaced(
  keyboard: Keyboard,
  text: string,
  options: {continuesStream?: boolean} = {},
): Promise<void> {
  let gapOwed = options.continuesStream ?? false;
  for (const character of text) {
    if (currentInterruption()) {
      return;
    }
    if (gapOwed) {
      await sleepKeyIntervalMs();
    }
    gapOwed = true;
    const holdMs = drawKeyHoldMs();
    if (!isKeyboardKey(character)) {
      await sleepMs(holdMs);
      await abandonIfBlocked(keyboard.sendCharacter(character));
    } else if (SHIFTED_CHARACTERS.has(character)) {
      const shift: KeyInput = useRightShift ? 'ShiftRight' : 'ShiftLeft';
      useRightShift = !useRightShift;
      await abandonIfBlocked(keyboard.down(shift));
      try {
        await abandonIfBlocked(keyboard.press(character, {delay: holdMs}));
      } finally {
        await abandonIfBlocked(keyboard.up(shift));
      }
    } else {
      await abandonIfBlocked(keyboard.press(character, {delay: holdMs}));
    }
  }
}

/**
 * Splits a text into everything ahead of its last code point and that code
 * point. The last keystroke is the one that can set the page moving, so it is
 * the part that runs under the navigation expectation while the rest is typed
 * in front of it.
 */
function splitLastKeystroke(text: string): {lead: string; last: string} {
  const characters = Array.from(text);
  return {
    lead: characters.slice(0, -1).join(''),
    last: characters.at(-1) ?? '',
  };
}

/**
 * How often the button has been pressed at this spot, which is what turns a
 * second press into a double click. `mouse.down` and `mouse.up` pass the count
 * on to the browser, but puppeteer declares it only on the runtime object and
 * not in its public typings, so it is assembled here rather than at every call.
 */
function pressOptions(clickCount: number): Readonly<MouseOptions> {
  return {clickCount} as unknown as Readonly<MouseOptions>;
}

/**
 * Brings the pointer onto the element and presses the button, and leaves it
 * down for the caller to release. Everything a click needs before the page can
 * act on it — the scroll into view, the pause after a jump, the wait for a
 * bounding box that stops moving, the travel of the pointer and the span the
 * button stays down — happens here, because the page sees a completed click
 * only on the release and the release is what the caller runs under the
 * navigation expectation.
 *
 * The approach stays with `Locator.hover`, so the locator's viewport and
 * stability conditions still run; only the press and the release are taken
 * from the mouse directly, because `Locator.click` cannot hand its release
 * back.
 */
async function pressPaced(
  handle: ElementHandle<Element>,
  mouse: Mouse,
  clickCount: number,
): Promise<void> {
  await approachInViewport(handle, async () => {
    await handle.asLocator().hover();
  });
  await pressButtonPaced(mouse, clickCount);
}

/**
 * The same for a spot the caller names instead of an element. Nothing about a
 * pair of coordinates can be scrolled into view or waited for, so the pointer
 * travels there and the press follows.
 */
async function pressPacedAt(
  mouse: Mouse,
  x: number,
  y: number,
  clickCount: number,
): Promise<void> {
  await mouse.move(x, y);
  await pressButtonPaced(mouse, clickCount);
}

/**
 * The press itself, once the pointer stands on the spot, with the button left
 * down for the caller to release. A double click is two complete clicks: every
 * press of it holds the button for its own drawn span and a drawn gap separates
 * one click from the next, so neither half is a zero-length press and the two
 * are not sent in the same instant. `mouse.click` reaches neither of those —
 * its single `delay` is the dwell of the last press and it leaves the earlier
 * ones and the gap between them at zero.
 *
 * A click of the sequence that set the page moving is the last one: the test
 * sits in the gap before the next press, so no further button goes down on a
 * document that is leaving. What is left down then is nothing, and the release
 * the caller holds fails against a button that is not pressed — which is why
 * that release is run where such a failure is expected. A dialog is not waited
 * for at the gap but given up on where the press stands, because the press is
 * what it holds.
 */
async function pressButtonPaced(
  mouse: Mouse,
  clickCount: number,
): Promise<void> {
  for (let count = 1; count < clickCount; count++) {
    await abandonIfBlocked(mouse.down(pressOptions(count)));
    await sleepMs(drawMouseHoldMs());
    await abandonIfBlocked(mouse.up(pressOptions(count)));
    await sleepMouseClickGapMs();
    if (currentInterruption()) {
      return;
    }
  }
  await abandonIfBlocked(mouse.down(pressOptions(clickCount)));
  await sleepMs(drawMouseHoldMs());
}

/**
 * Selects everything the field holds, so the next keystroke types over it. This
 * is the clear step: no delete key, no scripted `value = ''`, and no length at
 * which it stops working.
 */
async function selectAllPaced(keyboard: Keyboard): Promise<void> {
  const modifier: KeyInput = process.platform === 'darwin' ? 'Meta' : 'Control';
  await abandonIfBlocked(keyboard.down(modifier));
  try {
    await sleepKeyIntervalMs();
    await abandonIfBlocked(keyboard.press('a', {delay: drawKeyHoldMs()}));
  } finally {
    await abandonIfBlocked(keyboard.up(modifier));
  }
  await sleepKeyIntervalMs();
}

/**
 * Undoes what an interaction left held once the wrapper around it has torn its
 * block signal down again — a button still pressed, a modifier still held. The
 * command is dispatched either way; what an open dialog changes is that nothing
 * waits for it, because the renderer answers it only once someone handles the
 * dialog and the interaction it belonged to is already decided.
 */
async function releaseAfterAction(
  page: ContextPage,
  release: () => Promise<unknown>,
): Promise<void> {
  const dispatched = release().catch(() => undefined);
  const dialog = page.getDialog();
  if (dialog && !dialog.handled) {
    return;
  }
  await dispatched;
}

/**
 * What the field is and what it already holds, measured against the value it is
 * to end up with.
 */
interface TypeableField {
  /** Whether the element takes a keystroke stream at all. */
  typeable: boolean;
  /** Whether it holds anything that would have to be typed over. */
  hasContent: boolean;
  /** Whether it already holds exactly the value, so nothing is to be typed. */
  alreadyEqual: boolean;
  /**
   * How much of what it holds is a leading part of the value and can stay: the
   * length of the current content when the value continues it, otherwise 0.
   */
  keptPrefixLength: number;
  /**
   * Whether what was read is the rendered text rather than a value. It is, for
   * an editable element: the whole paced path works in the rendered domain, the
   * keystrokes produce rendered text and a typed newline is a block boundary no
   * value carries. Two contents that render alike therefore count as equal,
   * which is what the caller is told when nothing is typed.
   */
  readsRenderedText: boolean;
}

/**
 * Reads that classification off the element. It matches the one inside
 * `Locator.fill`, so everything that would have been set in one shot — a
 * `<select>`, a date, colour or range input — keeps taking that route, and the
 * three cases `Locator.fill` distinguishes for a field it types into survive on
 * the paced path: leave it alone, continue it, or type over it. The comparison
 * is made in the page so the field's current content, a password among them,
 * does not have to be carried out of it.
 */
async function readTypeableField(
  handle: ElementHandle<Element>,
  value: string,
): Promise<TypeableField> {
  return await answerOrAbandon(
    handle.evaluate((element, target): TypeableField => {
      const classify = (
        typeable: boolean,
        current: string,
        readsRenderedText = false,
      ): TypeableField => {
        const alreadyEqual = current === target;
        const continues =
          !alreadyEqual && current.length > 0 && target.startsWith(current);
        return {
          typeable,
          hasContent: current.length > 0,
          alreadyEqual,
          keptPrefixLength: continues ? current.length : 0,
          readsRenderedText,
        };
      };
      if (element instanceof HTMLInputElement) {
        const typeableTypes = [
          'text',
          'url',
          'tel',
          'search',
          'password',
          'number',
          'email',
        ];
        return classify(typeableTypes.includes(element.type), element.value);
      }
      if (element instanceof HTMLTextAreaElement) {
        return classify(true, element.value);
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return classify(true, element.innerText, true);
      }
      return {
        typeable: false,
        hasContent: false,
        alreadyEqual: false,
        keptPrefixLength: 0,
        readsRenderedText: false,
      };
    }, value),
  );
}

/**
 * What a checkbox, a radio button or a switch currently reads as. `mixed` is a
 * state no value matches — an indeterminate checkbox or an `aria-checked`
 * reading `mixed` — so a control in it is always clicked. The predicate is the
 * one inside `Locator.fill`, which the paced path no longer goes through.
 */
async function readToggleState(
  handle: ElementHandle<Element>,
): Promise<boolean | 'mixed'> {
  return await answerOrAbandon(
    handle.evaluate(element => {
      if (
        (element instanceof HTMLInputElement && element.indeterminate) ||
        element.getAttribute('aria-checked') === 'mixed'
      ) {
        return 'mixed';
      }
      return (
        (element instanceof HTMLInputElement && element.checked) ||
        element.getAttribute('aria-checked') === 'true'
      );
    }),
  );
}

/**
 * Puts the text entry cursor behind what the field already holds, so the
 * keystrokes that follow continue that text instead of landing in front of it.
 * Nothing about the content changes and no input event is emitted: a native
 * field takes the cursor from the assignment of the value it already has, and
 * an editable element takes it from a collapsed range over its own content.
 */
async function placeCaretAtEnd(handle: ElementHandle<Element>): Promise<void> {
  await abandonIfBlocked(
    handle.evaluate(element => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const current = element.value;
        element.value = '';
        element.value = current;
        return;
      }
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }),
  );
}

/**
 * A precondition of the interaction that did not hold in time. It carries the
 * condition in its own message, so the caller is told which one failed instead
 * of the timeout every locator failure ends in.
 */
class ElementNotReadyError extends Error {
  constructor(condition: string, cause: unknown) {
    super(`${condition} within the configured timeout.`, {cause});
  }
}

/**
 * Runs an approach that brings the element into the viewport and waits out the
 * pause that follows a jump. The page moves in one step — the locator ends in
 * `DOM.scrollIntoViewIfNeeded`, which produces no wheel events and no
 * intermediate positions — so what is paced is not the travel but the moment
 * after it, and only when the page moved at all.
 *
 * Whether it moved is the locator's own precondition, which it checks and keeps
 * to itself, so the same check is read here beforehand: one intersection test
 * against the viewport, taken in the prepare stage where the other preconditions
 * are checked too.
 */
async function approachInViewport(
  handle: ElementHandle<Element>,
  approach: () => Promise<void>,
): Promise<void> {
  const wasInViewport = await handle.isIntersectingViewport({threshold: 0});
  await approach();
  await pauseAfterScroll(!wasInViewport);
}

/**
 * Scrolls the element into the viewport and waits until it is there. The wait
 * is the locator's own; `scroll` without offsets writes nothing to the element
 * and is only the action that carries the condition, which is why the other
 * condition of that action is switched off.
 */
async function waitUntilInViewport(
  handle: ElementHandle<Element>,
): Promise<void> {
  try {
    await approachInViewport(handle, async () => {
      await handle.asLocator().setWaitForStableBoundingBox(false).scroll();
    });
  } catch (error) {
    throw new ElementNotReadyError(
      'The element did not scroll into the viewport',
      error,
    );
  }
}

/**
 * Waits until the element's bounding box is the same across two consecutive
 * animation frames, so nothing types into a field that is still moving.
 */
async function waitUntilBoundingBoxIsStable(
  handle: ElementHandle<Element>,
): Promise<void> {
  try {
    await handle.asLocator().setEnsureElementIsInTheViewport(false).scroll();
  } catch (error) {
    throw new ElementNotReadyError(
      'The bounding box of the element kept moving',
      error,
    );
  }
}

/**
 * Waits until a native form control has lost its `disabled` attribute. The
 * predicate is the one `Locator.click` and `Locator.fill` wait on, and
 * `filter` runs it through the same `waitForFunction` retry they use.
 */
async function waitUntilEnabled(handle: ElementHandle<Element>): Promise<void> {
  try {
    await handle
      .asLocator()
      .filter(element => {
        if (!(element instanceof HTMLElement)) {
          return true;
        }
        const isNativeFormControl = [
          'BUTTON',
          'INPUT',
          'SELECT',
          'TEXTAREA',
          'OPTION',
          'OPTGROUP',
        ].includes(element.nodeName);
        return !isNativeFormControl || !element.hasAttribute('disabled');
      })
      .waitHandle();
  } catch (error) {
    throw new ElementNotReadyError('The element stayed disabled', error);
  }
}

/**
 * Everything that has to hold before the first keystroke reaches a field: it is
 * in the viewport, it has stopped moving, and it is not disabled. `Locator.fill`
 * waits for these three and the paced path no longer goes through it, so they
 * are waited for here — one after the other, each on a locator carrying only its
 * own condition, so a failure names the condition that did not hold.
 */
async function waitUntilReadyForTyping(
  handle: ElementHandle<Element>,
): Promise<void> {
  await waitUntilInViewport(handle);
  await waitUntilBoundingBoxIsStable(handle);
  await waitUntilEnabled(handle);
}

/**
 * The element the keystrokes of `type_text` will land in. The tool names no
 * element and types into whatever the page has focused, so there is one only
 * when the page has focused something other than the document itself.
 */
async function focusedElement(
  page: ContextPage,
): Promise<ElementHandle<Element> | null> {
  const handle = await page.pptrPage.evaluateHandle((): Element | null => {
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active === document.documentElement
    ) {
      return null;
    }
    return active;
  });
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) {
    await handle.dispose();
  }
  return element;
}

function handleActionError(error: unknown, uid: string): never {
  if (error instanceof InteractionInterruptedError) {
    // Nothing about the element failed here: the page stopped the interaction,
    // and what stopped it is what the caller has to read.
    throw error;
  }
  logger?.('failed to act using a locator', error);
  const reason =
    error instanceof ElementNotReadyError
      ? error.message
      : 'The element did not become interactive within the configured timeout.';
  throw new Error(
    `Failed to interact with the element with uid ${uid}. ${reason}`,
    {
      cause: error,
    },
  );
}

async function selectNativeSelectOption(handle: ElementHandle<Element>) {
  using selectHandle = await handle.evaluateHandle(node => {
    if (!(node instanceof HTMLOptionElement)) {
      return null;
    }

    const select = node.closest('select');
    if (!select || select.multiple || select.disabled || node.disabled) {
      return null;
    }

    const parentElement = node.parentElement;
    if (
      parentElement instanceof HTMLOptGroupElement &&
      parentElement.disabled
    ) {
      return null;
    }

    return select;
  });

  using select = selectHandle.asElement() as ElementHandle<Element> | null;
  if (!select) {
    return false;
  }

  using valueHandle = await handle.getProperty('value');

  const value = await valueHandle.jsonValue();
  if (typeof value !== 'string') {
    return false;
  }
  await select.asLocator().fill(value);

  return true;
}

export const click = definePageTool({
  name: 'click',
  description: `Clicks on the provided element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    dblClick: dblClickSchema,
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const uid = request.params.uid;
    using handle = await request.page.getElementByUid(uid);
    const aXNode = request.page.getAXNodeByUid(uid);
    const shouldSelectNativeOption =
      !request.params.dblClick && aXNode?.role === 'option';
    const mouse = request.page.pptrPage.mouse;
    const clickCount = request.params.dblClick ? 2 : 1;
    const releaseButton = async () => {
      await mouse.up(pressOptions(clickCount));
    };
    // Set before the first press, not after the last one: a `mouse.up` that
    // throws between the two clicks of a double click would otherwise leave the
    // button logically down for every later interaction with the page.
    let release: (() => Promise<void>) | undefined;
    try {
      const result = await request.page.waitForEventsAfterTrigger(
        async () => {
          // `Locator.hover` inside the press waits for the viewport and for a
          // bounding box that stops moving, but not for the element to be
          // enabled — the one condition `Locator.click` would add.
          await waitUntilEnabled(handle);
          if (shouldSelectNativeOption) {
            // Picking an option sets a value and paces nothing, so this branch
            // stays whole inside the window, the click it falls back to
            // included.
            return async () => {
              if (await selectNativeSelectOption(handle)) {
                return;
              }
              release = releaseButton;
              await pressPaced(handle, mouse, clickCount);
              release = undefined;
              await releaseButton();
            };
          }
          release = releaseButton;
          await pressPaced(handle, mouse, clickCount);
          return async () => {
            release = undefined;
            await releaseButton();
          };
        },
        {frame: handle.frame},
      );
      response.appendResponseLine(
        request.params.dblClick
          ? `Successfully double clicked on the element`
          : `Successfully clicked on the element`,
      );
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    } finally {
      // A press that never reached its release would leave the button down for
      // every later interaction with the page.
      if (release) {
        await releaseAfterAction(request.page, releaseButton);
      }
    }
  },
});

export const clickAt = definePageTool({
  name: 'click_at',
  description: `Clicks at the provided coordinates`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
    conditions: ['experimentalVision'],
  },
  schema: {
    x: zod.number().describe('The x coordinate'),
    y: zod.number().describe('The y coordinate'),
    dblClick: dblClickSchema,
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const mouse = page.pptrPage.mouse;
    const clickCount = request.params.dblClick ? 2 : 1;
    const releaseButton = async () => {
      await mouse.up(pressOptions(clickCount));
    };
    // Set before the first press, not after the last one: a `mouse.up` that
    // throws between the two clicks of a double click would otherwise leave the
    // button logically down for every later interaction with the page.
    let release: (() => Promise<void>) | undefined;
    try {
      const result = await page.waitForEventsAfterTrigger(async () => {
        release = releaseButton;
        await pressPacedAt(
          mouse,
          request.params.x,
          request.params.y,
          clickCount,
        );
        return async () => {
          release = undefined;
          await releaseButton();
        };
      });
      response.appendResponseLine(
        request.params.dblClick
          ? `Successfully double clicked at the coordinates`
          : `Successfully clicked at the coordinates`,
      );
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } finally {
      // A press that never reached its release would leave the button down for
      // every later interaction with the page.
      if (release) {
        await releaseAfterAction(page, releaseButton);
      }
    }
  },
});

export const hover = definePageTool({
  name: 'hover',
  description: `Hover over the provided element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const uid = request.params.uid;
    using handle = await request.page.getElementByUid(uid);
    try {
      const result = await request.page.waitForEventsAfterTrigger(
        async () => {
          // The pointer arrives the way it arrives for a paced click: the jump
          // that brings the element into view is waited out first, so the hover
          // itself is all that is left inside the navigation expectation. What a
          // hover sets off — a menu, a tooltip — is then waited for by the
          // window behind it rather than raced against the pause in front of it.
          await waitUntilInViewport(handle);
          return async () => {
            await handle.asLocator().hover();
          };
        },
        {frame: handle.frame},
      );
      response.appendResponseLine(`Successfully hovered over the element`);
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } catch (error) {
      handleActionError(error, uid);
    }
  },
});

// The AXNode for an option doesn't contain its `value`. We set text content of the option as value.
// If the form is a combobox, we need to find the correct option by its text value.
// To do that, loop through the children while checking which child's text matches the requested value (requested value is actually the text content).
// When the correct option is found, use the element handle to get the real value.
//
// Only the value is read here, and the element takes it by the same route as
// any other: what a combobox is in the DOM decides that route, not what it is
// in the accessibility tree. A `<select>` takes it in one shot, an
// `<input role="combobox">` — a search box, an autocomplete field — takes a
// keystroke stream and is paced like every other text field.
async function resolveOptionValue(
  aXNode: TextSnapshotNode,
  value: string,
): Promise<string | undefined> {
  let optionFound = false;
  for (const child of aXNode.children) {
    if (child.role === 'option' && child.name === value && child.value) {
      optionFound = true;
      using childHandle = await child.elementHandle();
      if (childHandle) {
        using childValueHandle = await childHandle.getProperty('value');

        const childValue = await childValueHandle.jsonValue();
        return childValue ? childValue.toString() : undefined;
      }
    }
  }
  if (!optionFound) {
    throw new Error(`Could not find option with text "${value}"`);
  }
  return undefined;
}

function hasOptionChildren(aXNode: TextSnapshotNode) {
  return aXNode.children.some(child => child.role === 'option');
}

/**
 * The interaction of a fill that has nothing to change. The caller waits for
 * one, and an element already holding its value is reached by not touching it.
 */
async function changeNothing(): Promise<void> {
  return;
}

/** One prepared fill: what it decided, and the interaction that carries it out. */
interface PreparedFill {
  decision: FillDecision;
  action: () => Promise<void>;
}

/**
 * Decides how the element takes its value and runs everything that leads up to
 * the change: the focus, whatever has to happen to what the field already holds
 * and every keystroke but the last. What comes back is the interaction that
 * changes the element — the last keystroke, the one-shot set for a field that
 * takes no keystrokes at all, or nothing when the field already holds the
 * value — together with the decision behind it, so a fill that writes nothing
 * says so instead of reporting a success that changed no page.
 */
async function buildFillAction(
  handle: ElementHandle<Element>,
  uid: string,
  requestedValue: string,
  page: ContextPage,
): Promise<PreparedFill> {
  // The pause at the transition to this field — reaching it, looking at it —
  // is taken by the wrapper this runs inside. `fill_form` enters that wrapper
  // once per element, so every field pays it once, before anything of its own
  // runs.
  const aXNode = page.getAXNodeByUid(uid);
  let value = requestedValue;
  // We assume that combobox needs to be handled as select if it has
  // role='combobox' and option children.
  if (aXNode && aXNode.role === 'combobox' && hasOptionChildren(aXNode)) {
    const optionValue = await resolveOptionValue(aXNode, requestedValue);
    if (optionValue === undefined) {
      // The option is there but carries no value of its own. Nothing to set.
      return {decision: 'option-without-value', action: changeNothing};
    }
    value = optionValue;
  }

  const isToggle = await answerOrAbandon(
    handle.evaluate(el => {
      if (el instanceof HTMLInputElement) {
        return el.type === 'checkbox' || el.type === 'radio';
      }
      const role = el.getAttribute('role');
      return role === 'checkbox' || role === 'radio' || role === 'switch';
    }),
  );

  if (isToggle) {
    if (!['true', 'false'].includes(value)) {
      throw new Error(
        `Checkboxes, radio boxes and toggles require "true" or "false" value, but ${value} was used`,
      );
    }
    const mouse = page.pptrPage.mouse;
    // A toggle takes its value from a click, so it takes the paced one.
    // `Locator.fill` waits for the element to be enabled before it clicks and
    // the approach inside the press does not, so that condition is waited for
    // here.
    await waitUntilEnabled(handle);
    const state = await readToggleState(handle);
    if (state === (value === 'true')) {
      // It already reads as it is meant to read. Clicking it would turn it off
      // and on again in front of anyone watching, for no change at all.
      return {decision: 'toggle-already-set', action: changeNothing};
    }
    // Everything the click needs runs here; the release is what the page sees
    // as the click and is the only part left for the navigation expectation.
    await pressPaced(handle, mouse, 1);
    return {
      decision: 'typed',
      action: async () => {
        await mouse.up(pressOptions(1));
      },
    };
  }

  // Only which route the field takes is decided here. What it currently holds
  // is read further down, directly before the first keystroke, because the
  // waits in between give the page time to change it.
  const {typeable} = await readTypeableField(handle, value);
  if (!typeable || currentPace().fillsInOneShot) {
    // Two cases take the one-shot route: a field that has no keystroke stream
    // to pace — a `<select>`, a date, a colour, a range — and every field at
    // full speed. `typingThreshold: 0` is what keeps `Locator.fill` from typing
    // a short value out character by character; the value is set directly and
    // the input and change events go with it. The locator waits for the
    // viewport, for a bounding box that has stopped moving and for the element
    // to be enabled, so this path holds the same preconditions as the paced one
    // without repeating them here.
    //
    // Increase timeout for longer input values.
    const timeoutPerChar = 10; // ms
    const fillTimeout =
      page.pptrPage.getDefaultTimeout() + value.length * timeoutPerChar;
    return {
      decision: 'one-shot',
      action: async () => {
        await handle
          .asLocator()
          .setTimeout(fillTimeout)
          .fill(value, {typingThreshold: 0});
      },
    };
  }

  const keyboard = page.pptrPage.keyboard;
  await waitUntilReadyForTyping(handle);
  // What the field holds is read again, immediately before the first keystroke.
  // The waits above take over a second on a field the page had to jump to, and
  // a field the page filled in during that time would otherwise be continued or
  // left alone against content that is no longer there.
  const content = await readTypeableField(handle, value);
  if (content.alreadyEqual) {
    // The field already reads as it is meant to read. Typing it again would
    // clear a filled-out form field and rebuild it keystroke by keystroke in
    // front of anyone watching, for no change at all.
    return {
      decision: content.readsRenderedText
        ? 'already-equal-rendered'
        : 'already-equal',
      action: changeNothing,
    };
  }
  await abandonIfBlocked(handle.focus());
  let text = value;
  if (content.keptPrefixLength > 0) {
    // What stands there is the beginning of what is wanted, so it stays and
    // only the rest is typed. Cutting by the length of the field's own content
    // cannot fall inside a surrogate pair: the value continues that content.
    await placeCaretAtEnd(handle);
    text = value.slice(content.keptPrefixLength);
  } else if (content.hasContent) {
    await selectAllPaced(keyboard);
    if (text === '') {
      // Emptying a field: no keystroke follows that could type over the
      // selection, so the selection is removed by the key a hand would reach
      // for. Without it the field would keep its old content while the call
      // reports the fill as done.
      return {
        decision: 'typed',
        action: async () => {
          await keyboard.press('Backspace', {delay: drawKeyHoldMs()});
        },
      };
    }
  }
  const {lead, last} = splitLastKeystroke(text);
  await typePaced(keyboard, lead);
  return {
    decision: 'typed',
    action: async () => {
      await typePaced(keyboard, last, {continuesStream: lead.length > 0});
    },
  };
}

/**
 * The same, with every failure reported against the element the caller named,
 * whether it happens while the field is being prepared or while the change
 * itself runs.
 */
async function fillFormElement(
  handle: ElementHandle<Element>,
  uid: string,
  value: string,
  page: ContextPage,
): Promise<PreparedFill> {
  let prepared: PreparedFill;
  try {
    prepared = await buildFillAction(handle, uid, value, page);
  } catch (error) {
    handleActionError(error, uid);
  }
  return {
    decision: prepared.decision,
    action: async () => {
      try {
        await prepared.action();
      } catch (error) {
        handleActionError(error, uid);
      }
    },
  };
}

export const fill = definePageTool({
  name: 'fill',
  description: `Type text into an input, text area or select an option from a <select> element.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    value: zod
      .string()
      .describe(
        'The value to fill in. "true" or "false" for checkboxes and toggles, "true" for radio buttons.',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const uid = request.params.uid;
    using handle = await page.getElementByUid(uid);
    let decision: FillDecision = 'typed';
    const result = await page.waitForEventsAfterTrigger(
      async () => {
        const prepared = await fillFormElement(
          handle,
          uid,
          request.params.value,
          page,
        );
        decision = prepared.decision;
        return prepared.action;
      },
      {frame: handle.frame},
    );
    response.appendResponseLine(
      fillDecisionNote(decision) ?? `Successfully filled out the element`,
    );
    response.attachWaitForResult(result);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const typeText = definePageTool({
  name: 'type_text',
  description: `Type text using keyboard into a previously focused input`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    text: zod.string().describe('The text to type'),
    submitKey: submitKeySchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const keyboard = page.pptrPage.keyboard;
    const {text, submitKey} = request.params;
    const result = await page.waitForEventsAfterTrigger(async () => {
      using target = await focusedElement(page);
      if (target) {
        try {
          await waitUntilReadyForTyping(target);
        } catch (error) {
          throw new Error(
            `Failed to type into the focused element. ${error instanceof Error ? error.message : String(error)}`,
            {cause: error},
          );
        }
      }
      if (submitKey) {
        await typePaced(keyboard, text);
        // A person reads back what they typed before submitting it.
        await pauseBeforeAction();
        return async () => {
          await keyboard.press(submitKey as KeyInput, {delay: drawKeyHoldMs()});
        };
      }
      const {lead, last} = splitLastKeystroke(text);
      await typePaced(keyboard, lead);
      return async () => {
        await typePaced(keyboard, last, {continuesStream: lead.length > 0});
      };
    });
    response.appendResponseLine(
      `Typed text "${request.params.text}${request.params.submitKey ? ` + ${request.params.submitKey}` : ''}"`,
    );
    response.attachWaitForResult(result);
  },
});

export const drag = definePageTool({
  name: 'drag',
  description: `Drag an element onto another element`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    from_uid: zod.string().describe('The uid of the element to drag'),
    to_uid: zod.string().describe('The uid of the element to drop into'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    using fromHandle = await request.page.getElementByUid(
      request.params.from_uid,
    );
    using toHandle = await request.page.getElementByUid(request.params.to_uid);

    const result = await request.page.waitForEventsAfterTrigger(
      async () => {
        // Both ends can be off screen, and the drag brings each of them into
        // view in one jump: the source before the button goes down, the target
        // while it is held.
        const wasInViewport =
          (await fromHandle.isIntersectingViewport({threshold: 0})) &&
          (await toHandle.isIntersectingViewport({threshold: 0}));
        await fromHandle.drag(toHandle);
        // Drag-and-drop mechanics rather than pace: the browser needs a moment
        // between the two drag events, at any speed.
        await new Promise(resolve => setTimeout(resolve, 50));
        // The pointer now stands on the target with the button down. What a
        // person spends here is taking in the view the drag jumped to and
        // holding the element a moment before letting go of it.
        await pauseAfterScroll(!wasInViewport);
        await sleepMs(drawMouseHoldMs());
        return async () => {
          await toHandle.drop(fromHandle);
        };
      },
      // The drop is what the page acts on, so the target's frame is the one
      // the interaction addresses.
      {frame: toHandle.frame},
    );
    response.appendResponseLine(`Successfully dragged an element`);
    response.attachWaitForResult(result);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const fillForm = definePageTool({
  name: 'fill_form',
  description: `Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. ALWAYS prefer this tool over multiple individual 'fill' or 'click' calls when interacting with forms. It is significantly faster, more reliable, and reduces turn count. Example: Fill username, password, and check "Remember Me" in one call.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    elements: zod
      .array(
        // eslint-disable-next-line @local/enforce-zod-schema
        zod.object({
          uid: zod.string().describe('The uid of the element to fill out'),
          value: zod
            .string()
            .describe(
              'Value for the element. "true" or "false" for checkboxes and toggles, "true" for radio buttons.',
            ),
        }),
      )
      .describe('Elements from snapshot to fill out.'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    let lastResult: WaitForEventsResult = {};
    const notes: string[] = [];
    for (const element of request.params.elements) {
      using handle = await page.getElementByUid(element.uid);
      let decision: FillDecision = 'typed';
      lastResult = await page.waitForEventsAfterTrigger(
        async () => {
          const prepared = await fillFormElement(
            handle,
            element.uid,
            element.value,
            page,
          );
          decision = prepared.decision;
          return prepared.action;
        },
        {frame: handle.frame},
      );
      const note = fillDecisionNote(decision);
      if (note) {
        notes.push(`${element.uid}: ${note}`);
      }
    }
    response.appendResponseLine(`Successfully filled out the form`);
    // Only the elements that took nothing are named: a form of many fields
    // would otherwise repeat a success line per field that says nothing.
    for (const note of notes) {
      response.appendResponseLine(note);
    }
    response.attachWaitForResult(lastResult);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});

export const uploadFile = definePageTool({
  name: 'upload_file',
  description: 'Upload a file through a provided element.',
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of the file input element or an element that will open file chooser on the page from the page content snapshot',
      ),
    filePath: zod.string().describe('The local path of the file to upload'),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: ['filePath'],
  handler: async (request, response) => {
    const {uid, filePath} = request.params;
    using handle = (await request.page.getElementByUid(
      uid,
    )) as ElementHandle<HTMLInputElement>;

    try {
      await handle.uploadFile(filePath);
    } catch {
      // Some sites use a proxy element to trigger file upload instead of
      // a type=file element. In this case, we want to default to
      // Page.waitForFileChooser() and upload the file this way.
      const mouse = request.page.pptrPage.mouse;
      // Set before the press, so a failure anywhere after it still releases
      // the button instead of leaving it down for every later interaction.
      let buttonIsDown = false;
      try {
        // The approach and the press run in front of `Promise.all`, because
        // the chooser's 3 s budget starts when that is entered: a paced
        // approach inside it would spend a large part of the budget before the
        // release that opens the dialog, and the upload would fail as if the
        // page had never offered a chooser.
        buttonIsDown = true;
        await pressPaced(handle, mouse, 1);
        const [fileChooser] = await Promise.all([
          request.page.pptrPage.waitForFileChooser({timeout: 3000}),
          (async () => {
            await mouse.up(pressOptions(1));
            buttonIsDown = false;
          })(),
        ]);
        await fileChooser.accept([filePath]);
      } catch {
        throw new Error(
          `Failed to upload file. The element could not accept the file directly, and clicking it did not trigger a file chooser.`,
        );
      } finally {
        if (buttonIsDown) {
          await mouse.up(pressOptions(1)).catch(() => undefined);
        }
      }
    }
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
    response.appendResponseLine(`File uploaded from ${filePath}.`);
  },
});

export const pressKey = definePageTool({
  name: 'press_key',
  description: `Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    key: zod
      .string()
      .describe(
        'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta',
      ),
    includeSnapshot: includeSnapshotSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const keyboard = page.pptrPage.keyboard;
    const tokens = parseKey(request.params.key);
    const [key, ...modifiers] = tokens;
    const heldModifiers: KeyInput[] = [];

    try {
      // The modifiers are reached for one after the other, with a gap between
      // them, and the key itself is what the page acts on: the combination is
      // therefore prepared and only the key press runs under the navigation
      // expectation. A key can raise a dialog like any other input — Enter in a
      // form, a shortcut behind a `confirm` — so every dispatch here is given up
      // on the moment the renderer stops answering.
      const result = await page.waitForEventsAfterTrigger(async () => {
        for (const modifier of modifiers) {
          await abandonIfBlocked(keyboard.down(modifier));
          heldModifiers.push(modifier);
          // A hand reaches for one modifier after the other and then for the
          // key, so a gap separates every press from the next.
          await sleepKeyIntervalMs();
        }
        return async () => {
          await keyboard.press(key, {delay: drawKeyHoldMs()});
        };
      });

      response.appendResponseLine(
        `Successfully pressed key: ${request.params.key}`,
      );
      response.attachWaitForResult(result);
      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } finally {
      // Release every modifier that was successfully pressed, even if a later
      // key event throws. Otherwise a failed press leaves modifiers logically
      // held down in the browser (see #2309).
      for (const modifier of heldModifiers.toReversed()) {
        await releaseAfterAction(page, () => keyboard.up(modifier));
      }
    }
  },
});
