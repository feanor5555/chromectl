/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {parseArguments} from '../src/bin/chrome-devtools-mcp-cli-options.js';
import {McpContext} from '../src/McpContext.js';
import {McpPage} from '../src/McpPage.js';
import {
  currentPace,
  FULL_SPEED_META_KEY,
  MUTEX_WAIT_CEILING_MS,
  NAVIGATION_GAP_MAX_MS,
  PACE_FULL,
  PACE_HUMAN,
} from '../src/pacing.js';
import {ClearcutLogger} from '../src/telemetry/ClearcutLogger.js';
import {zod} from '../src/third_party/index.js';
import {ToolHandler} from '../src/ToolHandler.js';
import {ToolCategory} from '../src/tools/categories.js';
import type {
  DefinedPageTool,
  ToolDefinition,
} from '../src/tools/ToolDefinition.js';
import {Mutex} from '../src/third_party/index.js';

describe('ToolHandler', () => {
  afterEach(() => {
    sinon.restore();
    ClearcutLogger.resetForTesting();
  });

  it('calls page getter for page scoped tools', async () => {
    let handlerCalled = false;
    const tool: DefinedPageTool = {
      name: 'page_tool',
      description: 'A page scoped tool',
      annotations: {
        category: ToolCategory.INPUT,
        readOnlyHint: false,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      pageScoped: true,
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    const mockPage = sinon.createStubInstance(McpPage);
    mockContext.getSelectedMcpPage.returns(mockPage);

    const toolMutex = new Mutex();
    const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
    });

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    assert.strictEqual(toolHandler.shouldRegister, true);
    await toolHandler.handle({});

    assert.strictEqual(mockContext.getSelectedMcpPage.calledOnce, true);
    assert.strictEqual(handlerCalled, true);
  });

  it('does not pass page to handler for non-page scoped tools', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'global_tool',
      description: 'A global tool',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);

    const toolMutex = new Mutex();
    const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
    });

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    assert.strictEqual(toolHandler.shouldRegister, true);
    const result = await toolHandler.handle({});

    assert.strictEqual(mockContext.getDevToolsData.calledOnce, true);
    assert.strictEqual(mockContext.getSelectedMcpPage.calledOnce, true);
    assert.strictEqual(mockContext.getPageById.called, false);
    assert.strictEqual(handlerCalled, true);
    assert.strictEqual(result.isError, undefined);
  });

  it('appends correct context to tool call logs', async () => {
    const baseTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        return;
      },
    };

    const testCases: Array<{
      tool: ToolDefinition | DefinedPageTool;
      devToolsData: Record<string, unknown>;
      pageUrl?: string;
      expectedContext: Record<string, unknown>;
    }> = [
      {
        tool: {
          ...baseTool,
          name: 'page_tool',
          pageScoped: true,
        },
        devToolsData: {cdpBackendNodeId: 1},
        pageUrl: 'http://localhost:9222/',
        expectedContext: {
          is_devtools_open: true,
          is_localhost: true,
          devtools_data: {
            is_dom_element_selected: true,
          },
        },
      },
      {
        tool: {
          ...baseTool,
          name: 'global_tool',
        },
        devToolsData: {},
        pageUrl: undefined,
        expectedContext: {
          is_devtools_open: false,
        },
      },
    ];

    for (const testCase of testCases) {
      let handlerCalled = false;
      testCase.tool.handler = async () => {
        handlerCalled = true;
      };

      const mockContext = sinon.createStubInstance(McpContext);
      mockContext.getDevToolsData.resolves(testCase.devToolsData);
      if (testCase.pageUrl) {
        const mockPage = {
          pptrPage: {
            isClosed: () => false,
            url: () => testCase.pageUrl,
          },
        } as unknown as McpPage;
        mockContext.getSelectedMcpPage.returns(mockPage);
      }

      const logSpy = sinon.spy();
      sinon.stub(ClearcutLogger, 'get').returns({
        logToolInvocation: logSpy,
      } as unknown as ClearcutLogger);

      const toolMutex = new Mutex();
      const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
      });

      const toolHandler = new ToolHandler(
        testCase.tool,
        serverArgs,
        async () => mockContext,
        toolMutex,
      );

      await toolHandler.handle({});

      assert.strictEqual(logSpy.calledOnce, true);
      assert.deepStrictEqual(
        logSpy.firstCall.args[0].context,
        testCase.expectedContext,
      );
      assert.strictEqual(handlerCalled, true);

      sinon.restore();
      ClearcutLogger.resetForTesting();
    }
  });

  it('reports unknown registered tool arguments clearly', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'lenient_tool',
      description: 'A tool with a required argument',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {
        url: zod.string(),
      },
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);

    const toolMutex = new Mutex();
    const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
    });

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    const params = {url: 'https://example.com', description: 'open the page'};
    assert.strictEqual(
      toolHandler.registeredInputSchema.safeParse(params).success,
      true,
    );

    const result = await toolHandler.handle(params);

    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0].type === 'text' ? result.content[0].text : '',
      /Unknown argument for tool "lenient_tool": "description"\. Expected arguments: "url"\./,
    );
    assert.strictEqual(handlerCalled, false);
  });

  describe('the full-speed switch', () => {
    function paceReportingTool(category: ToolCategory) {
      const seen: Array<ReturnType<typeof currentPace>> = [];
      const tool: ToolDefinition = {
        name: 'pace_tool',
        description: 'A tool that reports the pace it ran at',
        annotations: {
          category,
          readOnlyHint: true,
        },
        schema: {},
        blockedByDialog: false,
        verifyFilesSchema: [],
        handler: async () => {
          seen.push(currentPace());
        },
      };

      const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
      });
      const handler = new ToolHandler(
        tool,
        serverArgs,
        async () => sinon.createStubInstance(McpContext),
        new Mutex(),
      );
      return {handler, seen};
    }

    it('reaches an input tool through the request metadata', async () => {
      const {handler, seen} = paceReportingTool(ToolCategory.INPUT);

      await handler.handle({});
      await handler.handle({}, {});
      await handler.handle({}, {[FULL_SPEED_META_KEY]: true});

      assert.deepStrictEqual(seen, [PACE_HUMAN, PACE_HUMAN, PACE_FULL]);
    });

    it('reaches a tool of any other category just the same', async () => {
      const {handler, seen} = paceReportingTool(ToolCategory.NAVIGATION);

      await handler.handle({});
      await handler.handle({}, {[FULL_SPEED_META_KEY]: true});

      assert.deepStrictEqual(seen, [PACE_HUMAN, PACE_FULL]);
    });

    it('does not outlive the call that set it', async () => {
      const {handler} = paceReportingTool(ToolCategory.INPUT);

      await handler.handle({}, {[FULL_SPEED_META_KEY]: true});

      assert.strictEqual(currentPace(), PACE_HUMAN);
    });
  });

  describe('the wait for the browser', () => {
    function queuedTool(toolMutex: Mutex) {
      let handlerCalled = false;
      const tool: ToolDefinition = {
        name: 'queued_tool',
        description: 'A tool that has to wait its turn',
        annotations: {
          category: ToolCategory.INPUT,
          readOnlyHint: false,
        },
        schema: {},
        blockedByDialog: false,
        verifyFilesSchema: [],
        handler: async () => {
          handlerCalled = true;
        },
      };

      const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
      });
      const handler = new ToolHandler(
        tool,
        serverArgs,
        async () => sinon.createStubInstance(McpContext),
        toolMutex,
      );
      return {handler, wasCalled: () => handlerCalled};
    }

    /** Runs one call while the mutex is held and lets the ceiling pass. */
    async function callAndExhaustTheWait(handler: ToolHandler) {
      const clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
      });
      try {
        const pending = handler.handle({});
        await clock.tickAsync(MUTEX_WAIT_CEILING_MS);
        return await pending;
      } finally {
        clock.restore();
      }
    }

    /** Whether the mutex can be taken within a grace period. */
    async function acquiresWithin(
      toolMutex: Mutex,
      ms: number,
    ): Promise<boolean> {
      const acquired = toolMutex.acquire();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const taken = await Promise.race([
        acquired.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => {
            resolve(false);
          }, ms);
        }),
      ]);
      clearTimeout(timer);
      if (taken) {
        (await acquired)[Symbol.dispose]();
      }
      return taken;
    }

    it('gives up after the ceiling and names the ceiling it hit', async () => {
      const toolMutex = new Mutex();
      const held = await toolMutex.acquire();
      const {handler, wasCalled} = queuedTool(toolMutex);

      const result = await callAndExhaustTheWait(handler);
      held[Symbol.dispose]();

      assert.strictEqual(result.isError, true);
      const text =
        result.content[0].type === 'text' ? result.content[0].text : '';
      assert.match(text, /Waited 180000 ms for the browser/);
      assert.match(text, /not the work budget/);
      assert.strictEqual(wasCalled(), false);
    });

    it('does not wait at all while the browser is free', async () => {
      const toolMutex = new Mutex();
      const {handler, wasCalled} = queuedTool(toolMutex);

      const result = await handler.handle({});

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(wasCalled(), true);
      assert.strictEqual(await acquiresWithin(toolMutex, 500), true);
    });

    it('leaves the browser usable for the next call after it gave up', async () => {
      const toolMutex = new Mutex();
      const held = await toolMutex.acquire();
      const {handler} = queuedTool(toolMutex);

      const result = await callAndExhaustTheWait(handler);
      assert.strictEqual(result.isError, true);

      // The place in the FIFO queue stays after the call gave up, so the mutex
      // is handed to it once more and has to come straight back.
      held[Symbol.dispose]();
      assert.strictEqual(await acquiresWithin(toolMutex, 500), true);
    });
  });

  it('sets shouldRegister to false and returns disabled reason when category is disabled', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'disabled_tool',
      description: 'A disabled tool',
      annotations: {
        category: ToolCategory.EMULATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    const toolMutex = new Mutex();
    const serverArgs = parseArguments(
      '1.0.0',
      ['node', 'script.js', '--categoryEmulation=false'],
      {CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true'},
    );

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    assert.strictEqual(toolHandler.shouldRegister, false);

    const result = await toolHandler.handle({});
    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0].type === 'text' ? result.content[0].text : '',
      /is currently disabled/,
    );
    assert.strictEqual(handlerCalled, false);
  });

  // Last in the file on purpose: the moment of the last navigation is process
  // state, and every call these tests stamp it with would hold up the next test
  // in this file for the remainder of the gap.
  describe('the gap in front of the next call', () => {
    function gapTool(options: {
      name: string;
      category: ToolCategory;
      navigatedToUrl?: string;
      fails?: boolean;
    }) {
      const tool: ToolDefinition = {
        name: options.name,
        description: 'A tool that reports what it did to the page',
        annotations: {
          category: options.category,
          readOnlyHint: false,
        },
        schema: {},
        blockedByDialog: false,
        verifyFilesSchema: [],
        handler: async (_request, response) => {
          if (options.fails) {
            throw new Error('the page could not be reached');
          }
          if (options.navigatedToUrl) {
            response.attachWaitForResult({
              navigatedToUrl: options.navigatedToUrl,
            });
          }
        },
      };

      const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
      });
      return new ToolHandler(
        tool,
        serverArgs,
        async () => sinon.createStubInstance(McpContext),
        new Mutex(),
      );
    }

    /**
     * Runs one call and reports whether it got through without the gap being
     * waited out. Only the timers are faked, so the moment a navigation is
     * stamped with stays the real one.
     */
    async function completesWithoutTheGap(
      handler: ToolHandler,
    ): Promise<boolean> {
      const clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
      });
      try {
        let completed = false;
        const pending = handler.handle({}).then(result => {
          completed = true;
          return result;
        });
        await clock.tickAsync(0);
        const withoutWaiting = completed;
        await clock.tickAsync(NAVIGATION_GAP_MAX_MS);
        await pending;
        return withoutWaiting;
      } finally {
        clock.restore();
      }
    }

    it('is not held after a navigating call that failed', async () => {
      const failed = gapTool({
        name: 'navigate_page',
        category: ToolCategory.NAVIGATION,
        fails: true,
      });
      const result = await failed.handle({});
      assert.strictEqual(result.isError, true);

      const click = gapTool({name: 'click', category: ToolCategory.INPUT});
      assert.strictEqual(await completesWithoutTheGap(click), true);
    });

    it('is held in front of an input call after an observed navigation', async () => {
      const clickThrough = gapTool({
        name: 'click',
        category: ToolCategory.INPUT,
        navigatedToUrl: 'https://example.com/next',
      });
      await clickThrough.handle({});

      const click = gapTool({name: 'click', category: ToolCategory.INPUT});
      assert.strictEqual(await completesWithoutTheGap(click), false);
    });

    it('is not held in front of a call that only reads', async () => {
      const navigated = gapTool({
        name: 'navigate_page',
        category: ToolCategory.NAVIGATION,
        navigatedToUrl: 'https://example.com/next',
      });
      await navigated.handle({});

      const snapshot = gapTool({
        name: 'take_snapshot',
        category: ToolCategory.NAVIGATION,
      });
      assert.strictEqual(await completesWithoutTheGap(snapshot), true);
    });
  });
});
