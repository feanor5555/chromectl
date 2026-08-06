/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by the chromectl fork.
 */

import type {parseArguments} from './bin/chrome-devtools-mcp-cli-options.js';
import type {McpContext} from './McpContext.js';
import type {McpPage} from './McpPage.js';
import type {DataFormat} from './McpResponse.js';
import {McpResponse} from './McpResponse.js';
import {
  holdNavigationGap,
  isFullSpeedRequest,
  MUTEX_WAIT_CEILING_MS,
  selectPace,
} from './pacing.js';
import {SlimMcpResponse} from './SlimMcpResponse.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {bucketizeLatency, buildContext} from './telemetry/transformation.js';
import type {CallToolResult} from './third_party/index.js';
import {zod} from './third_party/index.js';
import {
  labels,
  OFF_BY_DEFAULT_CATEGORIES,
  ToolCategory,
} from './tools/categories.js';
import type {
  DefinedPageTool,
  DevToolsData,
  ToolDefinition,
} from './tools/ToolDefinition.js';
import {pageIdSchema} from './tools/ToolDefinition.js';
import {logger} from './utils/logger.js';
import type {Mutex} from './third_party/index.js';

export function buildFlag(category: ToolCategory) {
  return `category${category.charAt(0).toUpperCase() + category.slice(1)}`;
}

function buildDisabledMessage(
  toolName: string,
  flag: string,
  categoryLabel?: string,
): string {
  const reason = categoryLabel
    ? `is in category ${categoryLabel} which`
    : `requires experimental feature ${flag} and`;

  return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}

function getCategoryStatus(
  category: ToolCategory,
  serverArgs: ReturnType<typeof parseArguments>,
): {categoryFlag?: string; disabled: boolean} {
  const categoryFlag = buildFlag(category);

  const flagValue = serverArgs[categoryFlag];

  const isDisabled = OFF_BY_DEFAULT_CATEGORIES.includes(category)
    ? !flagValue
    : flagValue === false;

  if (isDisabled) {
    return {
      categoryFlag,
      disabled: true,
    };
  }

  return {
    disabled: false,
  };
}

function getConditionStatus(
  condition: string,
  serverArgs: ReturnType<typeof parseArguments>,
): {conditionFlag?: string; disabled: boolean} {
  if (condition && !serverArgs[condition]) {
    return {conditionFlag: condition, disabled: true};
  }

  return {disabled: false};
}

function getToolStatusInfo(
  tool: ToolDefinition | DefinedPageTool,
  serverArgs: ReturnType<typeof parseArguments>,
): {disabled: boolean; reason?: string} {
  const category = tool.annotations.category;
  const categoryCheck = getCategoryStatus(category, serverArgs);

  if (category && categoryCheck.disabled) {
    if (!categoryCheck.categoryFlag) {
      throw new Error(
        'when the category is disabled there should always be a flag set',
      );
    }

    return {
      disabled: true,
      reason: buildDisabledMessage(
        tool.name,
        `--${categoryCheck.categoryFlag}`,
        labels[category!],
      ),
    };
  }

  for (const condition of tool.annotations.conditions || []) {
    const conditionCheck = getConditionStatus(condition, serverArgs);
    if (conditionCheck.disabled) {
      if (!conditionCheck.conditionFlag) {
        throw new Error(
          'when the condition is disabled there should always be a flag set',
        );
      }

      return {
        disabled: true,
        reason: buildDisabledMessage(
          tool.name,
          `--${conditionCheck.conditionFlag}`,
        ),
      };
    }
  }

  return {disabled: false};
}

function isPageScopedTool(
  tool: ToolDefinition | DefinedPageTool,
): tool is DefinedPageTool {
  return 'pageScoped' in tool && tool.pageScoped === true;
}

function formatArgumentNames(names: string[]): string {
  return names.map(name => `"${name}"`).join(', ');
}

function buildUnknownArgumentsMessage(
  toolName: string,
  unknownArgumentNames: string[],
  expectedArgumentNames: string[],
): string {
  const unknownLabel =
    unknownArgumentNames.length === 1 ? 'argument' : 'arguments';
  const expectedArguments = expectedArgumentNames.length
    ? `Expected arguments: ${formatArgumentNames(expectedArgumentNames)}.`
    : 'This tool does not accept any arguments.';
  const correction =
    unknownArgumentNames.length === 1 ? 'Remove it' : 'Remove them';

  return `Unknown ${unknownLabel} for tool "${toolName}": ${formatArgumentNames(unknownArgumentNames)}. ${expectedArguments} ${correction} and retry.`;
}

/**
 * The tools that take the browser to another page by their very purpose. They
 * are the floor under the observed navigation, not the definition of one: a
 * navigation is recognised from what the wait around the action saw, and that
 * is a comparison of URLs, so a reload to the same address reports nothing and
 * would leave the next call ungapped. The set is held by name rather than by
 * `ToolCategory.NAVIGATION`, because that category also carries pure reads —
 * listing, selecting, closing and resizing a page — which navigate nothing.
 */
const NAVIGATING_TOOLS: ReadonlySet<string> = new Set([
  'navigate_page',
  'new_page',
]);

/**
 * The tools outside the input category that reach the page rather than only
 * reading what is already known about it.
 */
const PAGE_ACTING_TOOLS: ReadonlySet<string> = new Set([
  'navigate_page',
  'new_page',
  'evaluate_script',
]);

/**
 * Whether a call has to hold the gap in front of it. Nobody can know in advance
 * that a click will navigate, and a gap can only be held before an action, so
 * guaranteeing the distance between two navigations means holding the remainder
 * in front of every call that acts on the page. It costs nothing unless a
 * navigation has just ended — which is exactly the moment a person would not yet
 * have clicked. A call that only reads (listing pages, a snapshot, a
 * screenshot) changes nothing anybody could watch and is never held.
 */
function actsOnThePage(tool: ToolDefinition | DefinedPageTool): boolean {
  return (
    tool.annotations.category === ToolCategory.INPUT ||
    PAGE_ACTING_TOOLS.has(tool.name)
  );
}

/**
 * When the last navigating call of this process finished. One daemon serves one
 * target, so module state here is per target, which is the granularity the gap
 * is defined at. It survives across calls and is deliberately not per page: two
 * tabs of one browser are one browsing session to anyone watching it.
 */
let lastNavigationEndedAtMs: number | undefined;

/** The guard the tool mutex hands out. */
type ToolMutexGuard = Awaited<ReturnType<Mutex['acquire']>>;

/**
 * The one tool that must not queue behind the call it exists to rescue.
 *
 * The tool mutex is there so that two calls cannot drive one page at the same
 * time. `handle_dialog` drives nothing: it reads no page state, writes no file,
 * and its only contact with the page is `Page.handleJavaScriptDialog`, a
 * browser-level command that a renderer paused by a dialog does answer. Behind
 * the mutex it would wait out the very call the dialog is holding, which is the
 * whole ceiling of that call — measured at 50 s in a case whose only way out is
 * this tool.
 *
 * What it frees is the dialog, not the queue. The moment it is cleared the
 * renderer resumes and the CDP command that ran into the dialog is answered, so
 * that one keystroke or that one mouse release still lands on the page; the
 * blocked call then finishes on its own and only then hands the tool mutex on.
 * A caller waiting behind it is therefore released by the call ahead ending, not
 * by this one returning.
 */
const DIALOG_LATCH_TOOL = 'handle_dialog';

/**
 * What lets `handle_dialog` past the queue: a mutex of its own, so two of them
 * still serialize against each other, and the way to ask whether a browser
 * exists already.
 *
 * Both are needed together. Without a context the call would have to build the
 * browser first, which is process-wide work that must not run beside another
 * call doing the same, so a `handle_dialog` that arrives before any browser
 * exists takes the normal path — there is no dialog to clear on a browser that
 * was never started.
 */
export interface DialogLatch {
  /** The latch `handle_dialog` takes instead of the tool mutex. */
  readonly mutex: Mutex;
  /** Whether a browser and its context are already there. */
  readonly hasContext: () => boolean;
}

/**
 * Waits for the process-wide tool mutex and gives up after
 * `MUTEX_WAIT_CEILING_MS`, so a call queued behind a braked fill that holds the
 * browser for minutes ends with a statement instead of standing in line
 * forever.
 *
 * The queue is FIFO and offers no way out of it, so the place in it stays: the
 * guard that arrives after the ceiling is released the moment it arrives,
 * rather than being handed to nobody and locking the browser away for good.
 */
async function acquireWithinCeiling(
  toolMutex: Mutex,
): Promise<ToolMutexGuard | undefined> {
  const acquired = toolMutex.acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, MUTEX_WAIT_CEILING_MS);
  });
  const guard = await Promise.race([acquired, expired]);
  clearTimeout(timer);
  if (!guard) {
    void acquired.then(late => {
      late[Symbol.dispose]();
    });
  }
  return guard;
}

export class ToolHandler {
  readonly inputSchema: zod.ZodRawShape;
  readonly registeredInputSchema: zod.ZodTypeAny;
  readonly shouldRegister: boolean;
  private readonly disabledReason?: string;

  constructor(
    private readonly tool: ToolDefinition | DefinedPageTool,
    private readonly serverArgs: ReturnType<typeof parseArguments>,
    private readonly getContext: () => Promise<McpContext>,
    private readonly toolMutex: Mutex,
    private readonly dialogLatch?: DialogLatch,
  ) {
    const {disabled, reason} = getToolStatusInfo(tool, serverArgs);
    this.disabledReason = reason;
    this.shouldRegister = !(disabled && !serverArgs.viaCli);

    this.inputSchema =
      'pageScoped' in tool &&
      tool.pageScoped &&
      serverArgs.experimentalPageIdRouting &&
      !serverArgs.slim
        ? {...pageIdSchema, ...tool.schema}
        : tool.schema;
    this.registeredInputSchema = zod.object(this.inputSchema).passthrough();
  }

  /**
   * Whether this call takes the dialog latch rather than the tool mutex. The
   * daemon must not depend on a caller keeping the same exemption on its own
   * side, so the decision is made here, from the tool name and the state of the
   * browser.
   */
  private dialogLatchMutex(): Mutex | undefined {
    if (this.tool.name !== DIALOG_LATCH_TOOL) {
      return undefined;
    }
    const latch = this.dialogLatch;
    return latch?.hasContext() ? latch.mutex : undefined;
  }

  unknownArgumentNames(params: Record<string, unknown>): string[] {
    return Object.keys(params).filter(
      key => !Object.hasOwn(this.inputSchema, key),
    );
  }

  /**
   * Runs one tool call. `meta` is the metadata of the MCP request, which is
   * where the full-speed switch travels: it is a property of the call, not an
   * argument of the tool, so it reaches this funnel without appearing in any
   * tool's schema.
   */
  async handle(
    params: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (this.disabledReason) {
      return {
        content: [
          {
            type: 'text',
            text: this.disabledReason,
          },
        ],
        isError: true,
      };
    }

    const unknownArgumentNames = this.unknownArgumentNames(params);
    if (unknownArgumentNames.length) {
      return {
        content: [
          {
            type: 'text',
            text: buildUnknownArgumentsMessage(
              this.tool.name,
              unknownArgumentNames,
              Object.keys(this.inputSchema),
            ),
          },
        ],
        isError: true,
      };
    }

    // The wait for the browser has its own ceiling, and the work budget the
    // outer layers grant starts only here, once the mutex is held. A call that
    // never got that far says so, so the caller can tell the two apart.
    //
    // The guard is held with `using`, so no path out of this method releases
    // the browser late: a throw on the way to the work below would otherwise
    // leave the process-wide mutex held and every later call would wait out
    // `MUTEX_WAIT_CEILING_MS` and fail.
    //
    // Which mutex is waited for is the one thing that differs per call:
    // `handle_dialog` takes the dialog latch, so the call that can free a
    // wedged browser does not stand in line behind it (`DIALOG_LATCH_TOOL`).
    // The ceiling applies to either, so no call waits for a mutex forever.
    const dialogLatch = this.dialogLatchMutex();
    using guard = await acquireWithinCeiling(dialogLatch ?? this.toolMutex);
    if (!guard) {
      const holder = dialogLatch
        ? 'another dialog call was still being handled'
        : 'another call was still holding it';
      return {
        content: [
          {
            type: 'text',
            text: `Waited ${MUTEX_WAIT_CEILING_MS} ms for the browser and gave up: ${holder}. Nothing of this call reached the page — the ceiling hit is the wait for the browser, not the work budget, which had not started.`,
          },
        ],
        isError: true,
      };
    }
    // The pace is put in place here because this is the one funnel every call
    // passes and it holds the process-wide mutex, so the profile of the call in
    // flight cannot be read by another. It is not narrowed to one category: the
    // pause before an action is taken by every wrapped tool, a navigation among
    // them, so a switch that only reached the input category would leave a
    // paced value standing at full speed.
    const fullSpeed = isFullSpeedRequest(meta);
    const startTime = Date.now();
    let success = false;
    let navigated = false;
    let devToolsData: DevToolsData | undefined;
    let pageUrl: string | undefined;
    let restorePace: (() => void) | undefined;
    try {
      // Inside the `try`, so the profile of this call is restored on every way
      // out — the gap waited out below is an `await` between the two.
      restorePace = selectPace(fullSpeed);
      if (actsOnThePage(this.tool) && !fullSpeed) {
        // Held under the mutex, like every other paced wait: a gap the next
        // call could walk through is no gap.
        await holdNavigationGap(lastNavigationEndedAtMs);
      }
      logger?.(
        `${this.tool.name} request: ${JSON.stringify(params, null, '  ')}`,
      );
      const context = await this.getContext();
      logger?.(`${this.tool.name} context: resolved`);
      const response = this.serverArgs.slim
        ? new SlimMcpResponse(this.serverArgs)
        : new McpResponse(this.serverArgs);

      response.setRedactNetworkHeaders(this.serverArgs.redactNetworkHeaders);
      if (context.consumeReconnectNotice()) {
        response.setReconnectNotice();
      }
      let page: McpPage | undefined;
      try {
        if (this.tool.verifyFilesSchema) {
          for (const key of this.tool.verifyFilesSchema) {
            const filePath = params[key];
            await context.validatePath(filePath as string);
          }
        }
        if (isPageScopedTool(this.tool)) {
          const pageId =
            typeof params.pageId === 'number' ? params.pageId : undefined;
          page =
            this.serverArgs.experimentalPageIdRouting &&
            pageId !== undefined &&
            !this.serverArgs.slim
              ? context.getPageById(pageId)
              : context.getSelectedMcpPage();
          response.setPage(page);
          if (this.tool.blockedByDialog) {
            page.throwIfDialogOpen();
          }
          await this.tool.handler(
            {
              params,
              page,
            },
            response,
            context,
          );
        } else {
          await this.tool.handler(
            {
              params,
            },
            response,
            context,
          );
        }
      } catch (err) {
        response.setError(err);
      }
      devToolsData = await context.getDevToolsData(page);
      const targetPage = page ?? context.getSelectedMcpPage();
      if (targetPage?.pptrPage?.isClosed() === false) {
        pageUrl = targetPage.pptrPage.url();
      }
      // Resolve data format: --experimentalDataFormat takes precedence, fall back to legacy --experimentalToonFormat
      let dataFormat: DataFormat = 'default';
      if (this.serverArgs.experimentalDataFormat) {
        dataFormat = this.serverArgs.experimentalDataFormat as DataFormat;
      } else if (this.serverArgs.experimentalToonFormat) {
        dataFormat = 'toon';
      }

      const {content, structuredContent} = await response.handle(
        context,
        dataFormat,
      );
      // What the next call keeps its gap from: the navigation the wait around
      // the action actually observed, whatever tool set it off, and a tool that
      // navigates by its purpose even when the URL it arrived at is the one it
      // left. A call that failed navigated nothing and delays no one.
      //
      // `navigatedToUrl` is derived from a plain comparison of the URL before
      // and after the action, which a hash change and a `pushState` satisfy
      // while the watch over the prepare stage counts neither as a navigation
      // (`UNCOUNTED_NAVIGATION_TYPES`). The two definitions differ, and the
      // wider one is stamped from on purpose: a click on an in-page anchor is
      // therefore reported as a navigation and costs the next acting call one
      // navigation gap, at most `NAVIGATION_GAP_MAX_MS`. That is the whole cost
      // — no input is lost and none is sent twice — and it is paid to keep the
      // stamp on what a watcher would see as a page change, rather than on what
      // one CDP event type happened to be called.
      navigated =
        Boolean(response.attachedWaitForResult?.navigatedToUrl) ||
        (NAVIGATING_TOOLS.has(this.tool.name) && !response.error);
      const result: CallToolResult & {
        structuredContent?: Record<string, unknown>;
      } = {
        content,
      };
      if (response.error) {
        result.isError = true;
      }
      success = true;
      if (this.serverArgs.experimentalStructuredContent) {
        result.structuredContent = structuredContent as Record<string, unknown>;
      }
      return result;
    } catch (err) {
      logger?.(`${this.tool.name} error:`, err, err?.stack);
      let errorText = err && 'message' in err ? err.message : String(err);
      if ('cause' in err && err.cause) {
        errorText += `\nCause: ${err.cause.message}`;
      }
      return {
        content: [
          {
            type: 'text',
            text: errorText,
          },
        ],
        isError: true,
      };
    } finally {
      const context = buildContext(devToolsData, pageUrl);
      void ClearcutLogger.get()?.logToolInvocation({
        toolName: this.tool.name,
        params,
        schema: this.inputSchema,
        success,
        latencyMs: bucketizeLatency(Date.now() - startTime),
        context,
      });
      if (navigated) {
        // Recorded whatever the profile was: a navigation at full speed is
        // still the one the next braked call has to keep its gap from.
        lastNavigationEndedAtMs = Date.now();
      }
      restorePace?.();
    }
  }
}
