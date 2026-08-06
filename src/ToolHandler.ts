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
import type {ToolCategory} from './tools/categories.js';
import {labels, OFF_BY_DEFAULT_CATEGORIES} from './tools/categories.js';
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
 * The tools that take the browser to another page. The gap between two of them
 * is held open by name rather than by `ToolCategory.NAVIGATION`, because that
 * category also carries pure reads — listing, selecting, closing and resizing a
 * page — which navigate nothing and would be gapped for no reason.
 */
const NAVIGATING_TOOLS: ReadonlySet<string> = new Set([
  'navigate_page',
  'new_page',
]);

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
    using guard = await acquireWithinCeiling(this.toolMutex);
    if (!guard) {
      return {
        content: [
          {
            type: 'text',
            text: `Waited ${MUTEX_WAIT_CEILING_MS} ms for the browser and gave up: another call was still holding it. Nothing of this call reached the page — the ceiling hit is the wait for the browser, not the work budget, which had not started.`,
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
    const navigates = NAVIGATING_TOOLS.has(this.tool.name);
    const startTime = Date.now();
    let success = false;
    let devToolsData: DevToolsData | undefined;
    let pageUrl: string | undefined;
    let restorePace: (() => void) | undefined;
    try {
      // Inside the `try`, so the profile of this call is restored on every way
      // out — the gap waited out below is an `await` between the two.
      restorePace = selectPace(fullSpeed);
      if (navigates && !fullSpeed) {
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
      if (navigates) {
        // Recorded whatever the profile was: a navigation at full speed is
        // still the one the next braked navigation has to keep its gap from.
        lastNavigationEndedAtMs = Date.now();
      }
      restorePace?.();
    }
  }
}
