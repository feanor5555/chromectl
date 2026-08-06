/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by the chromectl fork.
 */

import {DisposableStack} from './third_party/index.js';

export function replaceHtmlElementsWithUids(schema: JSONSchema7Definition) {
  if (typeof schema === 'boolean') {
    return;
  }

  let isHtmlElement = false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'x-mcp-type' && value === 'HTMLElement') {
      isHtmlElement = true;
      break;
    }
  }

  if (isHtmlElement) {
    schema.properties = {uid: {type: 'string'}};
    schema.required = ['uid'];
  }

  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      replaceHtmlElementsWithUids(schema.properties[key]);
    }
  }

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) {
        replaceHtmlElementsWithUids(item);
      }
    } else {
      replaceHtmlElementsWithUids(schema.items);
    }
  }

  if (schema.anyOf) {
    for (const s of schema.anyOf) {
      replaceHtmlElementsWithUids(s);
    }
  }
  if (schema.allOf) {
    for (const s of schema.allOf) {
      replaceHtmlElementsWithUids(s);
    }
  }
  if (schema.oneOf) {
    for (const s of schema.oneOf) {
      replaceHtmlElementsWithUids(s);
    }
  }
}

import {
  createTargetUniverse,
  type TargetUniverse,
} from './devtools/DevtoolsUtils.js';
import {
  abandonIfBlocked,
  InteractionInterruptedError,
  observeInterruptions,
  observeRendererBlock,
} from './interruption.js';
import {
  drawPreActionPauseMs,
  pauseBeforeAction,
  settleAfterAction,
  travelsPointer,
  type PointerPoint,
} from './pacing.js';
import {
  ConsoleCollector,
  NetworkCollector,
  type ListenerMap,
  type UncaughtError,
} from './PageCollector.js';
import {TextSnapshot} from './TextSnapshot.js';
import type {Locator} from './third_party/index.js';
import {
  PredefinedNetworkConditions,
  type CdpFrame,
  type CdpPage,
  type Dialog,
  type ElementHandle,
  type Frame,
  type Viewport,
  type WebMCPTool,
  type Protocol,
  type Page,
  type ConsoleMessage,
  type HTTPRequest,
  type DevTools,
  type JSONSchema7Definition,
} from './third_party/index.js';
import {takeSnapshot} from './tools/snapshot.js';
import type {ToolGroups} from './tools/thirdPartyDeveloper.js';
const DEFAULT_TIMEOUT = 5_000;
const NAVIGATION_TIMEOUT = 10_000;

/**
 * The navigation types the expectation over the trigger does not count. The set
 * is upstream's own (`WaitForHelper.waitForNavigationStarted`), kept identical
 * so the observation over the prepare stage reports what the window over the
 * trigger would have reported had the navigation started a moment later.
 */
const UNCOUNTED_NAVIGATION_TYPES: ReadonlySet<string> = new Set([
  'historySameDocument',
  'historyDifferentDocument',
  'sameDocument',
]);

/**
 * How long a navigation that started during the prepare stage is waited out.
 * The same figure the helper grants a navigation it saw itself, scaled by the
 * same network multiplier.
 */
const PREPARE_NAVIGATION_TIMEOUT = 3_000;

/**
 * The end of an interaction a dialog stopped. The renderer is paused while one
 * is open, so the input command that raised it is answered by nobody and
 * everything the stream still carried was never sent — but that one command is
 * dispatched and lands as soon as the dialog is handled, which is what the
 * caller has to know before it types the same thing again.
 */
function dialogInterruption(dialog: Dialog): InteractionInterruptedError {
  return new InteractionInterruptedError(
    `A dialog opened while the interaction was being carried out (${dialog.type()}: ${dialog.message()}). Nothing after the input that raised it was sent, and that input itself may still reach the page once the dialog is handled. The dialog is still open.`,
  );
}
import type {
  ContextPage,
  DevToolsData,
  Response,
} from './tools/ToolDefinition.js';
import type {
  EmulationSettings,
  GeolocationOptions,
  TextSnapshotNode,
} from './types.js';
import {logger} from './utils/logger.js';
import {
  getNetworkMultiplierFromString,
  WaitForHelper,
  type WaitForEventsResult,
  type DialogAction,
} from './WaitForHelper.js';

/**
 * Per-page state wrapper. Consolidates dialog, snapshot, emulation,
 * and metadata that were previously scattered across Maps in McpContext.
 *
 * Internal class consumed only by McpContext. Fields are public for direct
 * read/write access. The dialog field is private because it requires an
 * event listener lifecycle managed by the constructor/dispose pair.
 */
export class McpPage implements ContextPage {
  readonly pptrPage: Page;
  readonly id: number;

  // Snapshot
  textSnapshot: TextSnapshot | null = null;
  uniqueBackendNodeIdToMcpId = new Map<string, string>();
  extraHandles: ElementHandle[] = [];

  // Emulation
  emulationSettings: EmulationSettings = {};

  // Metadata
  isolatedContextName?: string;
  #devtoolsUniverse?: TargetUniverse;

  // Dialog
  #dialog?: Dialog;
  #dialogHandler: (dialog: Dialog) => void;

  // Pointer
  #pointerPosition?: PointerPoint;
  #leadPauseMs?: number;

  thirdPartyDeveloperTools: ToolGroups = [];

  networkCollector: NetworkCollector;
  consoleCollector: ConsoleCollector;

  #hasNetworkBlockOrAllowlist: boolean;
  #locatorClass: typeof Locator;

  constructor(
    page: Page,
    id: number,
    options: {
      hasNetworkBlockOrAllowlist: boolean;
      locatorClass: typeof Locator;
      isolatedContextName?: string;
    },
  ) {
    this.#hasNetworkBlockOrAllowlist = options.hasNetworkBlockOrAllowlist;
    this.#locatorClass = options.locatorClass;
    this.pptrPage = page;
    this.id = id;
    this.isolatedContextName = options.isolatedContextName;
    this.#dialogHandler = (dialog: Dialog): void => {
      this.#dialog = dialog;
    };
    page.on('dialog', this.#dialogHandler);

    this.networkCollector = new NetworkCollector(page);
    this.consoleCollector = new ConsoleCollector(page, collect => {
      return {
        console: event => {
          collect(event);
        },
        uncaughtError: event => {
          collect(event);
        },
        devtoolsAggregatedIssue: event => {
          collect(event);
        },
      } as ListenerMap;
    });
  }

  async init(): Promise<void> {
    await Promise.allSettled([
      this.#initDevToolsUniverseNoThrow(),
      this.#initFocusEmulationNoThrow(),
    ]);
  }

  async #initFocusEmulationNoThrow(): Promise<void> {
    // We emulate a focused page for all pages to support multi-agent workflows.
    void this.pptrPage.emulateFocusedPage(true).catch(error => {
      logger?.('Error turning on focused page emulation', error);
    });
  }

  async #initDevToolsUniverseNoThrow(): Promise<void> {
    if (this.#devtoolsUniverse) {
      return undefined;
    }
    try {
      const session = await this.pptrPage.createCDPSession();
      this.#devtoolsUniverse = await createTargetUniverse(session);
    } catch (e) {
      logger?.('Failed to initialize DevTools universe', e);
    }
  }

  get devtoolsUniverse(): TargetUniverse | undefined {
    return this.#devtoolsUniverse;
  }

  /**
   * Where this page's pointer stands, as far as this process knows. It is kept
   * per page rather than per session, because puppeteer's own mouse state is
   * per page and a coordinate belongs to the document it was taken in.
   *
   * A navigation does not clear it — a physical pointer does not move because a
   * page loaded — so it is undefined only for a page nothing has moved on yet.
   */
  get pointerPosition(): PointerPoint | undefined {
    return this.#pointerPosition;
  }

  setPointerPosition(position: PointerPoint): void {
    this.#pointerPosition = {x: position.x, y: position.y};
  }

  /**
   * The pause reserved for an action that travels, handed over and cleared in
   * one go: what is left of it after the path's own duration is what the
   * traveller waits out, and an action that never asks for it pays nothing.
   */
  takeLeadPause(): number {
    const reserved = this.#leadPauseMs ?? 0;
    this.#leadPauseMs = undefined;
    return reserved;
  }

  getDialog(): Dialog | undefined {
    return this.#dialog;
  }

  clearDialog(): void {
    this.#dialog = undefined;
  }

  throwIfDialogOpen(): void {
    if (this.#dialog && !this.#dialog.handled) {
      throw new Error(
        `A dialog is open (${this.#dialog.type()}: ${this.#dialog.message()}).`,
      );
    }
  }

  getThirdPartyDeveloperTools(): ToolGroups {
    return this.thirdPartyDeveloperTools;
  }

  async getToolGroups(): Promise<ToolGroups> {
    // Check if there is a `devtoolstooldiscovery` event listener
    using windowHandle = await this.pptrPage.evaluateHandle(() => window);
    // @ts-expect-error internal API
    const client = this.pptrPage._client();
    const {listeners}: {listeners: Protocol.DOMDebugger.EventListener[]} =
      await client.send('DOMDebugger.getEventListeners', {
        objectId: windowHandle.remoteObject().objectId,
      });
    if (listeners.find(l => l.type === 'devtoolstooldiscovery') === undefined) {
      return [];
    }

    const toolGroups = await this.pptrPage.evaluate(() => {
      if (window.__dtmcp) {
        window.__dtmcp.toolGroups = [];
      }
      return new Promise<ToolGroups>(resolve => {
        const event = new CustomEvent('devtoolstooldiscovery');
        const groups: ToolGroups = [];
        // @ts-expect-error Adding custom property
        event.respondWith = toolGroup => {
          if (!window.__dtmcp) {
            window.__dtmcp = {};
          }
          if (!window.__dtmcp.toolGroups) {
            window.__dtmcp.toolGroups = [];
          }

          if (
            typeof toolGroup.name !== 'string' ||
            (toolGroup.description &&
              typeof toolGroup.description !== 'string') ||
            !Array.isArray(toolGroup.tools)
          ) {
            console.error('Invalid toolGroup:', toolGroup);
            return;
          }
          for (const tool of toolGroup.tools) {
            if (
              typeof tool.name !== 'string' ||
              typeof tool.description !== 'string' ||
              typeof tool.inputSchema !== 'object' ||
              typeof tool.execute !== 'function'
            ) {
              console.error('Invalid tool:', tool);
              return;
            }
          }

          window.__dtmcp.toolGroups.push(toolGroup);

          // When receiving a toolGroup for the first time, expose a simple execution helper
          if (!window.__dtmcp.executeTool) {
            window.__dtmcp.executeTool = async (toolName, args) => {
              if (
                !window.__dtmcp?.toolGroups ||
                window.__dtmcp.toolGroups.length === 0
              ) {
                throw new Error('No tools found on the page');
              }
              for (const group of window.__dtmcp.toolGroups) {
                const tool = group.tools?.find(t => t.name === toolName);
                if (tool) {
                  return await tool.execute(args);
                }
              }
              throw new Error(`Tool ${toolName} not found`);
            };
          }

          groups.push(toolGroup);
        };
        window.dispatchEvent(event);
        // If at least one toolGroup was added synchronously, resolve with the array.
        // Otherwise, use setTimeout to allow for any microtask/asynchronous respondWith calls, or resolve with an empty array.
        if (groups.length > 0) {
          resolve(groups);
        } else {
          setTimeout(() => {
            if (groups.length > 0) {
              resolve(groups);
            } else {
              resolve([]);
            }
          }, 0);
        }
      });
    });

    for (const group of toolGroups) {
      for (const tool of group.tools ?? []) {
        replaceHtmlElementsWithUids(tool.inputSchema);
      }
    }

    this.thirdPartyDeveloperTools = toolGroups;

    return toolGroups;
  }

  getWebMcpTools(): WebMCPTool[] {
    return this.pptrPage.webmcp.tools();
  }

  resolveCdpRequestId(cdpRequestId: string): number | undefined {
    if (!cdpRequestId) {
      logger?.('no network request');
      return;
    }
    const request = this.networkCollector.find(request => {
      // @ts-expect-error id is internal.
      return request.id === cdpRequestId;
    });
    if (!request) {
      logger?.('no network request for ' + cdpRequestId);
      return;
    }
    return this.networkCollector.getIdForResource(request);
  }

  getNetworkRequests(includePreservedRequests?: boolean): HTTPRequest[] {
    return this.networkCollector.getData(includePreservedRequests);
  }

  async getDevToolsPage(): Promise<Page | undefined> {
    try {
      if (await this.pptrPage.hasDevTools()) {
        return await this.pptrPage.openDevTools();
      }
      return undefined;
    } catch {
      // Prior to Chrome 144.0.7559.59, the command fails,
      // Some Electron apps still use older version
      // Fall back to not exposing DevTools at all.
      return undefined;
    }
  }

  getConsoleData(
    includePreservedMessages?: boolean,
  ): Array<ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError> {
    return this.consoleCollector.getData(includePreservedMessages);
  }

  getConsoleMessageById(
    id: number,
  ): ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError {
    return this.consoleCollector.getById(id);
  }

  getNetworkRequestById(reqid: number): HTTPRequest {
    return this.networkCollector.getById(reqid);
  }

  get networkConditions(): string | null {
    return this.emulationSettings.networkConditions ?? null;
  }

  get cpuThrottlingRate(): number {
    return this.emulationSettings.cpuThrottlingRate ?? 1;
  }

  get geolocation(): GeolocationOptions | null {
    return this.emulationSettings.geolocation ?? null;
  }

  get viewport(): Viewport | null {
    return this.emulationSettings.viewport ?? null;
  }

  get userAgent(): string | null {
    return this.emulationSettings.userAgent ?? null;
  }

  get colorScheme(): 'dark' | 'light' | null {
    return this.emulationSettings.colorScheme ?? null;
  }

  // Public for testability: tests spy on this method to verify throttle multipliers.
  createWaitForHelper(
    cpuMultiplier: number,
    networkMultiplier: number,
  ): WaitForHelper {
    return new WaitForHelper(this.pptrPage, cpuMultiplier, networkMultiplier);
  }

  /**
   * Runs one action and waits for what it set off. Everything that wraps an
   * action passes through here, which makes it the single place for the pause
   * before the action and the settle window after it — the pause covers every
   * wrapped tool at once, and neither of the two is inside `WaitForHelper`,
   * whose navigation expectation is armed the moment it is entered and would
   * count a sleep placed in front of the action against that window.
   */
  async waitForEventsAfterAction(
    action: () => Promise<unknown>,
    options?: {
      timeout?: number;
      handleDialog?:
        DialogAction | Partial<Record<Protocol.Page.DialogType, DialogAction>>;
    },
  ): Promise<WaitForEventsResult> {
    await pauseBeforeAction();
    return await this.#waitForEvents(action, options);
  }

  /** The helper's own wait, with the settle window behind it. */
  async #waitForEvents(
    action: () => Promise<unknown>,
    options?: {
      timeout?: number;
      handleDialog?:
        DialogAction | Partial<Record<Protocol.Page.DialogType, DialogAction>>;
    },
  ): Promise<WaitForEventsResult> {
    const helper = this.createWaitForHelper(
      this.cpuThrottlingRate,
      getNetworkMultiplierFromString(this.networkConditions),
    );
    const result = await helper.waitForEventsAfterAction(action, options);
    await settleAfterAction();
    return result;
  }

  /**
   * The same wait for an action that is built in two steps. `prepare` runs
   * everything that leads up to the interaction and hands that interaction
   * back; only what it hands back runs under the navigation expectation.
   *
   * The expectation is a window of about 100 ms, armed when the helper is
   * entered and decided by whether a navigation started inside it. Paced work
   * — a keystroke stream, the pause before a field, the pointer travelling to
   * a button and the span it stays pressed — lasts far longer than that, so an
   * action carrying it in front of its triggering interaction would expire the
   * window before the page began to navigate, and the call would return a page
   * that is still on its way. Splitting the action moves that work in front of
   * the window instead of widening the window to fit it.
   *
   * The pause before the action belongs in front of `prepare`, not in front of
   * the interaction it hands back: what the caller prepares is the approach to
   * the element and the keystrokes leading up to the last one, so a pause taken
   * after that would fall between the second-to-last and the last keystroke of
   * a stream, or between a press and its release.
   *
   * `pointerTravel` says that the prepare stage brings the pointer to its
   * target along a path. Part of that pause is then the travel itself, so it is
   * reserved rather than slept here and the prepare stage waits out what its
   * drawn path leaves of it.
   *
   * Everything the prepare stage does is visible to the page — the first click
   * of a double click, every keystroke of a fill but the last, the selection
   * that clears a field, the drag that picks an element up — so the page can
   * start navigating or raise a dialog while it runs, in front of the window
   * that only covers the trigger. Both are therefore watched for over the
   * prepare stage itself, and both stop the paced stream where it stands.
   *
   * The dialog is watched for over the trigger as well, one step further than
   * the prepare stage: it pauses the renderer, and the input command in flight
   * when it opens is answered only once someone handles it. Nothing of what the
   * trigger reports is lost by giving up on that command — a trigger's return
   * value is never read — and the dialog itself is what the helper and the
   * response report.
   *
   * `frame` is the frame the interaction addresses, so a navigation is counted
   * only where it concerns that interaction. Without a frame the main frame is
   * meant, which is what a tool naming no element acts on.
   */
  async waitForEventsAfterTrigger(
    prepare: () => Promise<() => Promise<unknown>>,
    options?: {
      timeout?: number;
      handleDialog?:
        DialogAction | Partial<Record<Protocol.Page.DialogType, DialogAction>>;
      frame?: Frame;
      pointerTravel?: boolean;
    },
  ): Promise<WaitForEventsResult> {
    if (options?.pointerTravel && travelsPointer()) {
      // The pause is what the pointer spends reaching the target, and the
      // target's coordinates are not known yet: it is reserved here and the
      // traveller waits out what its own path leaves of it.
      this.#leadPauseMs = drawPreActionPauseMs();
    } else {
      await pauseBeforeAction();
    }
    const urlBeforeAction = this.pptrPage.url();
    const block = this.#observeRendererBlock();
    try {
      const watch = this.#watchPrepareStage(options?.frame);
      let trigger: () => Promise<unknown>;
      try {
        trigger = await prepare();
      } catch (error) {
        const dialog = watch.openedDialog();
        if (dialog) {
          // Whatever the prepare stage failed at, the dialog is what stopped
          // it: nothing it asked the renderer was answered from the moment one
          // was open.
          throw dialogInterruption(dialog);
        }
        throw error;
      } finally {
        watch.stop();
      }

      const dialog = watch.openedDialog();
      if (dialog) {
        // The renderer is paused and no input tool hands the helper a dialog
        // action, so the dialog stays open and the trigger is not sent after
        // it: a keystroke dispatched into a paused renderer reaches nothing
        // until someone handles the dialog.
        throw dialogInterruption(dialog);
      }

      if (!watch.navigationStarted()) {
        return await this.#waitForEvents(
          () => abandonIfBlocked(trigger()),
          options,
        );
      }
      return await this.#finishAfterNavigationDuringPrepare(
        trigger,
        urlBeforeAction,
        watch.openedDialog,
      );
    } finally {
      // A reservation nothing travelled against is dropped rather than waited
      // out: the action is over, and a pause taken behind it is no pause before
      // anything.
      this.#leadPauseMs = undefined;
      block.stop();
    }
  }

  /**
   * Watches for the renderer being paused by a dialog, for as long as one
   * action dispatches anything. What the paced helpers take from it is a signal
   * rather than a state, because it has to arrive while a command is in flight:
   * that command is the one the dialog is holding.
   */
  #observeRendererBlock(): {stop: () => void} {
    let rendererBlocked: () => void;
    const blocked = new Promise<void>(resolve => {
      rendererBlocked = resolve;
    });
    const onDialog = (): void => {
      rendererBlocked();
    };
    this.pptrPage.on('dialog', onDialog);
    const restore = observeRendererBlock(blocked);
    return {
      stop: (): void => {
        restore();
        this.pptrPage.off('dialog', onDialog);
      },
    };
  }

  /**
   * Watches the prepare stage for the two things that make the rest of a paced
   * stream pointless or unsafe, and exposes them to that stream as one
   * interruption check.
   *
   * The navigation is read from the page's own session, so the observation
   * costs no round trip and needs no upstream file; the dialog is read from the
   * listener this class already keeps. Only a dialog that opened while the
   * watch ran counts, because a dialog left over from an earlier call is what
   * `throwIfDialogOpen` reports before the tool starts.
   *
   * The session reports the navigation of every frame the page holds, an ad
   * slot, an embedded video and a tracking frame included, and the watch runs
   * for as long as the paced stream does — seconds on a long value. Only the
   * frame the interaction addresses and the frames it sits in are therefore
   * counted: those are the documents a navigation takes away from under the
   * stream, and anything else navigating leaves it typing into the same field
   * it started in.
   */
  #watchPrepareStage(addressedFrame?: Frame): {
    stop: () => void;
    navigationStarted: () => boolean;
    openedDialog: () => Dialog | undefined;
  } {
    let navigationStarted = false;
    const dialogBefore = this.#dialog;
    const frameId = (frame: Frame): string =>
      (frame as unknown as CdpFrame)._id;
    const watchedFrameIds = new Set<string>([
      frameId(this.pptrPage.mainFrame()),
    ]);
    for (
      let frame: Frame | null = addressedFrame ?? null;
      frame;
      frame = frame.parentFrame()
    ) {
      watchedFrameIds.add(frameId(frame));
    }
    const client = (this.pptrPage as unknown as CdpPage)._client();
    const onFrameStartedNavigating = (
      event: Protocol.Page.FrameStartedNavigatingEvent,
    ): void => {
      if (!watchedFrameIds.has(event.frameId)) {
        return;
      }
      if (UNCOUNTED_NAVIGATION_TYPES.has(event.navigationType)) {
        return;
      }
      navigationStarted = true;
    };
    client.on('Page.frameStartedNavigating', onFrameStartedNavigating);

    const openedDialog = (): Dialog | undefined => {
      const dialog = this.#dialog;
      if (!dialog || dialog === dialogBefore || dialog.handled) {
        return undefined;
      }
      return dialog;
    };
    const restoreInterruptionCheck = observeInterruptions(() => {
      if (navigationStarted) {
        return 'navigation';
      }
      return openedDialog() ? 'dialog' : undefined;
    });

    return {
      stop: (): void => {
        restoreInterruptionCheck();
        client.off('Page.frameStartedNavigating', onFrameStartedNavigating);
      },
      navigationStarted: (): boolean => navigationStarted,
      openedDialog,
    };
  }

  /**
   * Ends an action whose page began to navigate before the trigger ran. The
   * helper is not entered at all: its expectation is armed when it is entered
   * and the navigation is already under way, so it would wait out its window
   * for a start that has happened and report nothing.
   *
   * The trigger is still run, so the bookkeeping the caller hung on it — a
   * mouse button left down for it to release — is completed. What it fails at
   * is the document that is leaving, which is why its failure is logged rather
   * than raised: the call's result is the navigation, not the last keystroke of
   * a page nobody will see again.
   *
   * What the call reports is what actually happened: a navigation the page
   * confirmed or a URL that changed, and nothing when the start led nowhere —
   * the gap the next call keeps is stamped off that report. The document it
   * returns on has to have stopped changing as well, the same condition the
   * helper's own wait ends on, so the next call does not act on a page that is
   * still being built.
   */
  async #finishAfterNavigationDuringPrepare(
    trigger: () => Promise<unknown>,
    urlBeforeAction: string,
    openedDialog: () => Dialog | undefined,
  ): Promise<WaitForEventsResult> {
    try {
      await abandonIfBlocked(trigger());
    } catch (error) {
      logger?.('the trigger failed on a page that was already leaving', error);
    }
    const dialog = openedDialog();
    if (dialog) {
      // A page that asks before it is left — the `beforeunload` prompt — holds
      // the navigation until someone answers, so there is nothing to wait out
      // and nothing to report but the dialog.
      throw dialogInterruption(dialog);
    }
    const networkMultiplier = getNetworkMultiplierFromString(
      this.networkConditions,
    );
    let navigationCompleted = false;
    try {
      await this.pptrPage.waitForNavigation({
        timeout: PREPARE_NAVIGATION_TIMEOUT * networkMultiplier,
      });
      navigationCompleted = true;
    } catch (error) {
      logger?.('no navigation completed after one had started', error);
    }
    try {
      await this.createWaitForHelper(
        this.cpuThrottlingRate,
        networkMultiplier,
      ).waitForStableDom();
    } catch (error) {
      logger?.('the DOM kept changing after the navigation', error);
    }
    await settleAfterAction();
    const urlAfterAction = this.pptrPage.url();
    if (!navigationCompleted && urlAfterAction === urlBeforeAction) {
      return {};
    }
    return {navigatedToUrl: urlAfterAction};
  }

  dispose(): void {
    this.pptrPage.off('dialog', this.#dialogHandler);
    this.networkCollector.dispose();
    this.consoleCollector.dispose();
  }

  async executeThirdPartyDeveloperTool(
    toolName: string,
    params: Record<string, unknown>,
    response: Response,
  ): Promise<void> {
    // Creates array of ElementHandles from the UIDs in the params.
    // We do not replace the uids with the ElementsHandles yet, because
    // the `evaluate` function only turns them into DOM elements if they
    // are passed as non-nested arguments.
    const handles: ElementHandle[] = [];
    for (const value of Object.values(params)) {
      if (
        value instanceof Object &&
        'uid' in value &&
        typeof value.uid === 'string' &&
        Object.keys(value).length === 1
      ) {
        handles.push(await this.getElementByUid(value.uid));
      }
    }

    const result = await this.pptrPage.evaluate(
      async (name, args, ...elements) => {
        // Replace the UIDs with DOM elements.
        for (const [key, value] of Object.entries(args)) {
          if (
            value instanceof Object &&
            'uid' in value &&
            typeof value.uid === 'string' &&
            Object.keys(value).length === 1
          ) {
            args[key] = elements.shift();
          }
        }

        if (!window.__dtmcp?.executeTool) {
          throw new Error('No tools found on the page');
        }

        const toolResult = await window.__dtmcp.executeTool(name, args);

        const stashDOMElement = (el: Element) => {
          if (!window.__dtmcp) {
            window.__dtmcp = {};
          }
          if (window.__dtmcp.stashedElements === undefined) {
            window.__dtmcp.stashedElements = [];
          }
          window.__dtmcp.stashedElements.push(el);
          return {
            stashedId: `stashed-${window.__dtmcp.stashedElements.length - 1}`,
          };
        };

        const ancestors: unknown[] = [];
        // Recursively walks the tool result:
        // - Replaces DOM elements with an ID and stashes the DOM element on the window object
        // - Replaces non-plain objects with a string representation of the object
        // - Replaces circular references with the string '<Circular reference>'
        // - Replaces functions with the string '<Function object>'
        const processToolResult = (
          data: unknown,
          parentEl?: unknown,
        ): unknown => {
          // 1. Handle DOM Elements
          if (data instanceof Element) {
            return stashDOMElement(data);
          }

          // 2. Handle Arrays
          if (Array.isArray(data)) {
            return data.map((item: unknown) =>
              processToolResult(item, parentEl),
            );
          }

          // 3. Handle Objects
          if (data !== null && typeof data === 'object') {
            while (ancestors.length > 0 && ancestors.at(-1) !== parentEl) {
              ancestors.pop();
            }
            if (ancestors.includes(data)) {
              return '<Circular reference>';
            }
            ancestors.push(data);

            // If not a plain object, return a string representation of the object
            if (Object.getPrototypeOf(data) !== Object.prototype) {
              return `<${data.constructor.name} instance>`;
            }

            const processedObj: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(data)) {
              processedObj[key] = processToolResult(value, data);
            }
            return processedObj;
          }

          // 4. Handle Functions
          if (typeof data === 'function') {
            return '<Function object>';
          }

          // 5. Return primitives (strings, numbers, booleans) as-is
          return data;
        };

        return {
          result: processToolResult(toolResult),
          stashed: window.__dtmcp?.stashedElements?.length ?? 0,
        };
      },
      toolName,
      params,
      ...handles,
    );

    const elementHandles: ElementHandle[] = [];
    for (let i = 0; i < (result.stashed ?? 0); i++) {
      const elementHandle = await this.pptrPage.evaluateHandle(index => {
        const el = window.__dtmcp?.stashedElements?.[index];
        if (!el) {
          throw new Error(`Stashed element at index ${index} not found`);
        }
        return el;
      }, i);
      elementHandles.push(elementHandle);
    }

    await this.pptrPage.evaluate(() => {
      if (window.__dtmcp) {
        window.__dtmcp.stashedElements = undefined;
      }
    });

    if (elementHandles.length) {
      using stack = new DisposableStack();
      for (const handle of this.extraHandles) {
        stack.use(handle);
      }
      this.textSnapshot = await TextSnapshot.create(this, {
        extraHandles: elementHandles,
      });
      response.includeSnapshot();
    }

    const cdpElementIds = await Promise.all(
      elementHandles.map(async (elementHandle, index) => {
        const backendNodeId = await elementHandle.backendNodeId();
        if (!backendNodeId) {
          logger?.(
            `No backendNodeId for stashed DOM element with index ${index}`,
          );
          return `stashed-${index}`;
        }
        const cdpElementId =
          this.textSnapshot?.resolveCdpElementId(backendNodeId);
        if (!cdpElementId) {
          logger?.(
            `Could not get cdpElementId for backend node ${backendNodeId}`,
          );
          return `stashed-${index}`;
        }
        return cdpElementId;
      }),
    );

    const recursivelyReplaceStashedElements = (node: unknown): unknown => {
      if (Array.isArray(node)) {
        return node.map(x => recursivelyReplaceStashedElements(x));
      }
      if (node !== null && typeof node === 'object') {
        if (
          'stashedId' in node &&
          typeof node.stashedId === 'string' &&
          node.stashedId.startsWith('stashed-') &&
          Object.keys(node).length === 1
        ) {
          const index = parseInt(node.stashedId.split('-')[1]);
          return {uid: cdpElementIds[index]};
        }
        const resultObj: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
          resultObj[key] = recursivelyReplaceStashedElements(value);
        }
        return resultObj;
      }
      return node;
    };

    const resultWithUids = recursivelyReplaceStashedElements(result.result);
    response.appendResponseLine(JSON.stringify(resultWithUids, null, 2));
  }

  async getElementByUid(uid: string): Promise<ElementHandle<Element>> {
    if (!this.textSnapshot) {
      throw new Error(
        `No snapshot found for page ${this.id ?? '?'}. Use ${takeSnapshot.name} to capture one.`,
      );
    }
    const node = this.textSnapshot.idToNode.get(uid);
    if (!node) {
      throw new Error(`Element uid "${uid}" not found on page ${this.id}.`);
    }
    return this.#resolveElementHandle(node, uid);
  }

  async #resolveElementHandle(
    node: TextSnapshotNode,
    uid: string,
  ): Promise<ElementHandle<Element>> {
    const message = `Element with uid ${uid} no longer exists on the page.`;
    try {
      const handle = await node.elementHandle();
      if (!handle) {
        throw new Error(message);
      }
      return handle;
    } catch (error) {
      throw new Error(message, {
        cause: error,
      });
    }
  }

  getAXNodeByUid(uid: string) {
    return this.textSnapshot?.idToNode.get(uid);
  }

  async getDevToolsData(): Promise<DevToolsData> {
    try {
      logger?.('Getting DevTools UI data');
      const devtoolsPage = await this.getDevToolsPage();
      if (!devtoolsPage) {
        logger?.('No DevTools page detected');
        return {};
      }
      const {cdpRequestId, cdpBackendNodeId} = await devtoolsPage.evaluate(
        async () => {
          // @ts-expect-error no types
          const UI = await import('/bundled/ui/legacy/legacy.js');
          // @ts-expect-error no types
          const SDK = await import('/bundled/core/sdk/sdk.js');
          const request = UI.Context.Context.instance().flavor(
            SDK.NetworkRequest.NetworkRequest,
          );
          const node = UI.Context.Context.instance().flavor(
            SDK.DOMModel.DOMNode,
          );
          return {
            cdpRequestId: request?.requestId(),
            cdpBackendNodeId: node?.backendNodeId(),
          };
        },
      );
      return {cdpBackendNodeId, cdpRequestId};
    } catch (err) {
      logger?.('error getting devtools data', err);
    }
    return {};
  }

  async restoreEmulation() {
    const currentSetting = this.emulationSettings;
    await this.emulate(currentSetting);
  }

  async emulate(options: {
    networkConditions?: string;
    cpuThrottlingRate?: number;
    geolocation?: GeolocationOptions;
    userAgent?: string;
    colorScheme?: 'dark' | 'light' | 'auto';
    viewport?: Viewport;
    extraHttpHeaders?: Record<string, string> | undefined;
  }): Promise<void> {
    const page = this.pptrPage;
    const newSettings: EmulationSettings = {...this.emulationSettings};

    // Skip network emulation if blocklist/allowlist is configured, as it conflicts with blocking rules in Puppeteer.
    if (this.#hasNetworkBlockOrAllowlist) {
      if (options.networkConditions !== undefined) {
        throw new Error(
          'Network throttling is not supported when network blocking (allowlist/blocklist) is configured.',
        );
      }
    } else if (!options.networkConditions) {
      await page.emulateNetworkConditions(null);
      delete newSettings.networkConditions;
    } else if (options.networkConditions === 'Offline') {
      await page.emulateNetworkConditions({
        offline: true,
        download: 0,
        upload: 0,
        latency: 0,
      });
      newSettings.networkConditions = 'Offline';
    } else if (options.networkConditions in PredefinedNetworkConditions) {
      const networkCondition =
        PredefinedNetworkConditions[
          options.networkConditions as keyof typeof PredefinedNetworkConditions
        ];
      await page.emulateNetworkConditions(networkCondition);
      newSettings.networkConditions = options.networkConditions;
    }

    const secondarySession = this.devtoolsUniverse?.session;
    if (!options.cpuThrottlingRate) {
      await page.emulateCPUThrottling(1);
      if (secondarySession) {
        await secondarySession.send('Emulation.setCPUThrottlingRate', {
          rate: 1,
        });
      }
      delete newSettings.cpuThrottlingRate;
    } else {
      await page.emulateCPUThrottling(options.cpuThrottlingRate);
      if (secondarySession) {
        await secondarySession.send('Emulation.setCPUThrottlingRate', {
          rate: options.cpuThrottlingRate,
        });
      }
      newSettings.cpuThrottlingRate = options.cpuThrottlingRate;
    }

    if (!options.geolocation) {
      await page.setGeolocation({latitude: 0, longitude: 0});
      delete newSettings.geolocation;
    } else {
      await page.setGeolocation(options.geolocation);
      newSettings.geolocation = options.geolocation;
    }

    if (!options.userAgent) {
      await page.setUserAgent({userAgent: undefined});
      delete newSettings.userAgent;
    } else {
      await page.setUserAgent({userAgent: options.userAgent});
      newSettings.userAgent = options.userAgent;
    }

    if (!options.colorScheme || options.colorScheme === 'auto') {
      await page.emulateMediaFeatures([
        {name: 'prefers-color-scheme', value: ''},
      ]);
      delete newSettings.colorScheme;
    } else {
      await page.emulateMediaFeatures([
        {name: 'prefers-color-scheme', value: options.colorScheme},
      ]);
      newSettings.colorScheme = options.colorScheme;
    }

    if (!options.viewport) {
      delete newSettings.viewport;
    } else {
      const defaults = {
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: false,
      };
      newSettings.viewport = {...defaults, ...options.viewport};
    }

    if (options.extraHttpHeaders !== undefined) {
      await page.setExtraHTTPHeaders(options.extraHttpHeaders);
      newSettings.extraHttpHeaders = options.extraHttpHeaders;
      if (Object.keys(options.extraHttpHeaders).length === 0) {
        delete newSettings.extraHttpHeaders;
      }
    }

    this.emulationSettings = Object.keys(newSettings).length ? newSettings : {};

    this.updateTimeouts();

    // This should happen after updating the page timeouts.
    // Setting the viewport can trigger a reload which we don't want to timeout.
    await page.setViewport(newSettings.viewport ?? null);
  }

  updateTimeouts() {
    // For waiters 5sec timeout should be sufficient.
    // Increased in case we throttle the CPU
    const cpuMultiplier = this.cpuThrottlingRate;
    this.pptrPage.setDefaultTimeout(DEFAULT_TIMEOUT * cpuMultiplier);
    // 10sec should be enough for the load event to be emitted during
    // navigations.
    // Increased in case we throttle the network requests or the CPU
    const networkMultiplier = getNetworkMultiplierFromString(
      this.networkConditions,
    );
    this.pptrPage.setDefaultNavigationTimeout(
      NAVIGATION_TIMEOUT * networkMultiplier * cpuMultiplier,
    );
  }

  waitForTextOnPage(text: string[], timeout?: number): Promise<Element> {
    const frames = this.pptrPage.frames();

    let locator = this.#locatorClass.race(
      frames.flatMap(frame =>
        text.flatMap(value => [
          frame.locator(`aria/${value}`),
          frame.locator(`text/${value}`),
        ]),
      ),
    );

    if (timeout) {
      locator = locator.setTimeout(timeout);
    }

    return locator.wait();
  }

  /**
   * We need to ignore favicon request as they make our test flaky
   */
  async setUpNetworkCollectorForTesting() {
    this.networkCollector.dispose();
    this.networkCollector = new NetworkCollector(
      this.pptrPage,
      undefined,
      collect => {
        return {
          request: req => {
            if (req.url().includes('favicon.ico')) {
              return;
            }
            collect(req);
          },
        } as ListenerMap;
      },
    );
  }
}
