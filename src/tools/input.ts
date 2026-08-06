/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

import {
  currentPace,
  drawKeyHoldMs,
  drawMouseHoldMs,
  pauseAfterScroll,
  pauseBeforeAction,
  sleepKeyIntervalMs,
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
 */
async function typePaced(
  keyboard: Keyboard,
  text: string,
  options: {continuesStream?: boolean} = {},
): Promise<void> {
  let gapOwed = options.continuesStream ?? false;
  for (const character of text) {
    if (gapOwed) {
      await sleepKeyIntervalMs();
    }
    gapOwed = true;
    const holdMs = drawKeyHoldMs();
    if (!isKeyboardKey(character)) {
      await sleepMs(holdMs);
      await keyboard.sendCharacter(character);
    } else if (SHIFTED_CHARACTERS.has(character)) {
      const shift: KeyInput = useRightShift ? 'ShiftRight' : 'ShiftLeft';
      useRightShift = !useRightShift;
      await keyboard.down(shift);
      try {
        await keyboard.press(character, {delay: holdMs});
      } finally {
        await keyboard.up(shift);
      }
    } else {
      await keyboard.press(character, {delay: holdMs});
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
 * Brings the pointer onto the element and presses the button, and hands the
 * release back. Everything a click needs before the page can act on it — the
 * scroll into view, the pause after a jump, the wait for a bounding box that
 * stops moving, the travel of the pointer and the span the button stays down —
 * happens here, because
 * the page sees a completed click only on the release and the release is what
 * the caller runs under the navigation expectation.
 *
 * The approach stays with `Locator.hover`, so the locator's viewport and
 * stability conditions still run; only the press and the release are taken
 * from the mouse directly, because `Locator.click` cannot hand its release
 * back. A double click is two presses with the hold on the last of them, which
 * is where `mouse.click` puts it as well.
 */
async function pressPaced(
  handle: ElementHandle<Element>,
  mouse: Mouse,
  clickCount: number,
): Promise<() => Promise<void>> {
  await approachInViewport(handle, async () => {
    await handle.asLocator().hover();
  });
  for (let count = 1; count < clickCount; count++) {
    await mouse.down(pressOptions(count));
    await mouse.up(pressOptions(count));
  }
  await mouse.down(pressOptions(clickCount));
  await sleepMs(drawMouseHoldMs());
  return async () => {
    await mouse.up(pressOptions(clickCount));
  };
}

/**
 * Selects everything the field holds, so the next keystroke types over it. This
 * is the clear step: no delete key, no scripted `value = ''`, and no length at
 * which it stops working.
 */
async function selectAllPaced(keyboard: Keyboard): Promise<void> {
  const modifier: KeyInput = process.platform === 'darwin' ? 'Meta' : 'Control';
  await keyboard.down(modifier);
  try {
    await sleepKeyIntervalMs();
    await keyboard.press('a', {delay: drawKeyHoldMs()});
  } finally {
    await keyboard.up(modifier);
  }
  await sleepKeyIntervalMs();
}

/**
 * Whether the element takes a keystroke stream, and whether it already holds
 * something to type over. The classification matches the one inside
 * `Locator.fill`, so everything that would have been set in one shot — a
 * `<select>`, a date, colour or range input — keeps taking that route.
 */
async function readTypeableField(
  handle: ElementHandle<Element>,
): Promise<{typeable: boolean; hasContent: boolean}> {
  return await handle.evaluate(element => {
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
      return {
        typeable: typeableTypes.includes(element.type),
        hasContent: element.value.length > 0,
      };
    }
    if (element instanceof HTMLTextAreaElement) {
      return {typeable: true, hasContent: element.value.length > 0};
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return {typeable: true, hasContent: element.innerText.length > 0};
    }
    return {typeable: false, hasContent: false};
  });
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
    let release: (() => Promise<void>) | undefined;
    try {
      const result = await request.page.waitForEventsAfterTrigger(async () => {
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
            const fallbackRelease = await pressPaced(handle, mouse, clickCount);
            await fallbackRelease();
          };
        }
        release = await pressPaced(handle, mouse, clickCount);
        return async () => {
          const pressed = release;
          release = undefined;
          await pressed?.();
        };
      });
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
        await mouse.up(pressOptions(clickCount)).catch(() => undefined);
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
    const result = await page.waitForEventsAfterAction(async () => {
      await page.pptrPage.mouse.click(request.params.x, request.params.y, {
        count: request.params.dblClick ? 2 : 1,
      });
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
      const result = await request.page.waitForEventsAfterAction(async () => {
        await handle.asLocator().hover();
      });
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
async function selectOption(
  handle: ElementHandle,
  aXNode: TextSnapshotNode,
  value: string,
) {
  let optionFound = false;
  for (const child of aXNode.children) {
    if (child.role === 'option' && child.name === value && child.value) {
      optionFound = true;
      using childHandle = await child.elementHandle();
      if (childHandle) {
        using childValueHandle = await childHandle.getProperty('value');

        const childValue = await childValueHandle.jsonValue();
        if (childValue) {
          await handle.asLocator().fill(childValue.toString());
        }

        break;
      }
    }
  }
  if (!optionFound) {
    throw new Error(`Could not find option with text "${value}"`);
  }
}

function hasOptionChildren(aXNode: TextSnapshotNode) {
  return aXNode.children.some(child => child.role === 'option');
}

/**
 * Decides how the element takes its value and runs everything that leads up to
 * the change: the pause before the field, the focus, the select-all over what
 * the field already holds and every keystroke but the last. What comes back is
 * the interaction that changes the element — the last keystroke, or the
 * one-shot set for a field that takes no keystrokes at all.
 */
async function buildFillAction(
  handle: ElementHandle<Element>,
  uid: string,
  value: string,
  page: ContextPage,
): Promise<() => Promise<void>> {
  // The pause belongs at the transition to this field: reaching it, looking
  // at it. `fill_form` enters here once per element, so every field pays it
  // once, before anything of its own runs.
  await pauseBeforeAction();
  const aXNode = page.getAXNodeByUid(uid);
  // We assume that combobox needs to be handled as select if it has
  // role='combobox' and option children.
  if (aXNode && aXNode.role === 'combobox' && hasOptionChildren(aXNode)) {
    return async () => {
      await selectOption(handle, aXNode, value);
    };
  }

  const isToggle = await handle.evaluate(el => {
    if (el instanceof HTMLInputElement) {
      return el.type === 'checkbox' || el.type === 'radio';
    }
    const role = el.getAttribute('role');
    return role === 'checkbox' || role === 'radio' || role === 'switch';
  });

  if (isToggle) {
    if (!['true', 'false'].includes(value)) {
      throw new Error(
        `Checkboxes, radio boxes and toggles require "true" or "false" value, but ${value} was used`,
      );
    }
    return async () => {
      await handle.asLocator().fill(value === 'true');
    };
  }

  const field = await readTypeableField(handle);
  if (!field.typeable || currentPace().fillsInOneShot) {
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
    return async () => {
      await handle
        .asLocator()
        .setTimeout(fillTimeout)
        .fill(value, {typingThreshold: 0});
    };
  }

  const keyboard = page.pptrPage.keyboard;
  await waitUntilReadyForTyping(handle);
  await handle.focus();
  if (field.hasContent) {
    await selectAllPaced(keyboard);
  }
  const {lead, last} = splitLastKeystroke(value);
  await typePaced(keyboard, lead);
  return async () => {
    await typePaced(keyboard, last, {continuesStream: lead.length > 0});
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
): Promise<() => Promise<void>> {
  let action: () => Promise<void>;
  try {
    action = await buildFillAction(handle, uid, value, page);
  } catch (error) {
    handleActionError(error, uid);
  }
  return async () => {
    try {
      await action();
    } catch (error) {
      handleActionError(error, uid);
    }
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
    const result = await page.waitForEventsAfterTrigger(() =>
      fillFormElement(handle, uid, request.params.value, page),
    );
    response.appendResponseLine(`Successfully filled out the element`);
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

    const result = await request.page.waitForEventsAfterAction(async () => {
      await fromHandle.drag(toHandle);
      await new Promise(resolve => setTimeout(resolve, 50));
      await toHandle.drop(fromHandle);
    });
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
    for (const element of request.params.elements) {
      using handle = await page.getElementByUid(element.uid);
      lastResult = await page.waitForEventsAfterTrigger(() =>
        fillFormElement(handle, element.uid, element.value, page),
      );
    }
    response.appendResponseLine(`Successfully filled out the form`);
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
      try {
        const [fileChooser] = await Promise.all([
          request.page.pptrPage.waitForFileChooser({timeout: 3000}),
          handle.asLocator().click(),
        ]);
        await fileChooser.accept([filePath]);
      } catch {
        throw new Error(
          `Failed to upload file. The element could not accept the file directly, and clicking it did not trigger a file chooser.`,
        );
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
    const tokens = parseKey(request.params.key);
    const [key, ...modifiers] = tokens;

    const result = await page.waitForEventsAfterAction(async () => {
      const heldModifiers: KeyInput[] = [];
      try {
        for (const modifier of modifiers) {
          await page.pptrPage.keyboard.down(modifier);
          heldModifiers.push(modifier);
        }
        await page.pptrPage.keyboard.press(key);
      } finally {
        // Release every modifier that was successfully pressed, even if a
        // later key event throws. Otherwise a failed press leaves modifiers
        // logically held down in the browser (see #2309).
        for (const modifier of heldModifiers.toReversed()) {
          await page.pptrPage.keyboard.up(modifier);
        }
      }
    });

    response.appendResponseLine(
      `Successfully pressed key: ${request.params.key}`,
    );
    response.attachWaitForResult(result);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
});
