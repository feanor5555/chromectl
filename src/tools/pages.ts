/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  dialogReadCeilingMs,
  pauseBeforeAction,
  settleAfterAction,
} from '../pacing.js';
import type {CdpPage} from '../third_party/index.js';
import {zod} from '../third_party/index.js';
import {logger} from '../utils/logger.js';

import {ToolCategory} from './categories.js';
import {
  CLOSE_PAGE_ERROR,
  definePageTool,
  defineTool,
  timeoutSchema,
} from './ToolDefinition.js';

export const listPages = defineTool(args => {
  return {
    name: 'list_pages',
    description: `Get a list of pages${args?.categoryExtensions ? ' including extension service workers' : ''} open in the browser.`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: true,
    },
    schema: {},
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (_request, response) => {
      response.setIncludePages(true);
      response.setListThirdPartyDeveloperTools();
      response.setListWebMcpTools();
    },
  };
});

export const selectPage = defineTool({
  name: 'select_page',
  description: `Select a page as a context for future tool calls.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    pageId: zod
      .number()
      .describe(
        `The ID of the page to select. Call ${listPages().name} to get available pages.`,
      ),
    bringToFront: zod
      .boolean()
      .optional()
      .describe('Whether to focus the page and bring it to the top.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const page = context.getPageById(request.params.pageId);
    context.selectPage(page);
    response.setIncludePages(true);
    response.setListThirdPartyDeveloperTools();
    response.setListWebMcpTools();
    if (request.params.bringToFront) {
      // Activating a tab is nothing the page notices: focus emulation is on for
      // every page, so the switch raises no `visibilitychange`, no `focus` and
      // no `blur`, `visibilityState` stays `visible` and the frame rate keeps
      // running. What the pace serves here is the caller's own rhythm — a
      // person reaches for a tab a moment after whatever they did before it,
      // and takes in what stands there before acting in it. The pause in front
      // is the one every other action takes, and the window behind it is that
      // moment. The helper's own waits stay out of this path: `select_page` is
      // meant to work while a dialog blocks the page, and a wait that runs on
      // the page's own JavaScript does not.
      await pauseBeforeAction();
      await page.pptrPage.bringToFront();
      await settleAfterAction();
    }
  },
});

export const closePage = defineTool({
  name: 'close_page',
  description: `Closes the page by its index. The last open page cannot be closed.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    pageId: zod
      .number()
      .describe('The ID of the page to close. Call list_pages to list pages.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    try {
      await context.closePage(request.params.pageId);
    } catch (err) {
      if (err.message === CLOSE_PAGE_ERROR) {
        response.appendResponseLine(err.message);
      } else {
        throw err;
      }
    }
    response.setIncludePages(true);
    response.setListThirdPartyDeveloperTools();
  },
});

export const newPage = defineTool(() => {
  return {
    name: 'new_page',
    description: `Open a new tab and load a URL. Use project URL if not specified otherwise.`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: false,
    },
    schema: {
      url: zod.string().describe('URL to load in a new page.'),
      background: zod
        .boolean()
        .optional()
        .describe(
          'Whether to open the page in the background without bringing it to the front. Default is false (foreground).',
        ),
      isolatedContext: zod
        .string()
        .optional()
        .describe(
          'If specified, the page is created in an isolated browser context with the given name. ' +
            'Pages in the same browser context share cookies and storage. ' +
            'Pages in different browser contexts are fully isolated.',
        ),
      ...timeoutSchema,
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
      const page = await context.newPage(
        request.params.background,
        request.params.isolatedContext,
      );

      await page.waitForEventsAfterAction(
        async () => {
          await page.pptrPage.goto(request.params.url, {
            timeout: request.params.timeout,
          });
        },
        {timeout: request.params.timeout},
      );

      response.setIncludePages(true);
      response.setListThirdPartyDeveloperTools();
    },
  };
});

export const navigatePage = definePageTool(() => {
  return {
    name: 'navigate_page',
    description: `Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: false,
    },
    schema: {
      type: zod
        .enum(['url', 'back', 'forward', 'reload'])
        .optional()
        .describe(
          'Navigate the page by URL, back or forward in history, or reload.',
        ),
      url: zod.string().optional().describe('Target URL (only type=url)'),
      ignoreCache: zod
        .boolean()
        .optional()
        .describe('Whether to ignore cache on reload.'),
      handleBeforeUnload: zod
        .enum(['accept', 'dismiss'])
        .optional()
        .describe(
          'Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.',
        ),
      initScript: zod
        .string()
        .optional()
        .describe(
          'A JavaScript script to be executed on each new document before any other scripts for the next navigation.',
        ),
      ...timeoutSchema,
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response) => {
      const page = request.page;
      // A guard that asks before the page is left is answered by this call, and
      // the moment spent reading it is our brake: it is added to the wait the
      // navigation is granted rather than taken out of it.
      const options = {
        timeout:
          (request.params.timeout ??
            page.pptrPage.getDefaultNavigationTimeout()) +
          dialogReadCeilingMs(),
      };

      if (!request.params.type && !request.params.url) {
        throw new Error('Either URL or a type is required.');
      }

      if (!request.params.type) {
        request.params.type = 'url';
      }

      let initScriptId: string | undefined;
      if (request.params.initScript) {
        const {identifier} = await page.pptrPage.evaluateOnNewDocument(
          request.params.initScript,
        );
        initScriptId = identifier;
      }

      try {
        const action = request.params.handleBeforeUnload ?? 'accept';
        const result = await page.waitForEventsAfterAction(
          async () => {
            switch (request.params.type) {
              case 'url':
                if (!request.params.url) {
                  throw new Error(
                    'A URL is required for navigation of type=url.',
                  );
                }
                try {
                  await page.pptrPage.goto(request.params.url, options);
                  response.appendResponseLine(
                    `Successfully navigated to ${request.params.url}.`,
                  );
                } catch (error) {
                  response.appendResponseLine(
                    `Unable to navigate in the selected page: ${error.message}.`,
                  );
                }
                break;
              case 'back':
                try {
                  await page.pptrPage.goBack(options);
                  response.appendResponseLine(
                    `Successfully navigated back to ${page.pptrPage.url()}.`,
                  );
                } catch (error) {
                  response.appendResponseLine(
                    `Unable to navigate back in the selected page: ${error.message}.`,
                  );
                }
                break;
              case 'forward':
                try {
                  await page.pptrPage.goForward(options);
                  response.appendResponseLine(
                    `Successfully navigated forward to ${page.pptrPage.url()}.`,
                  );
                } catch (error) {
                  response.appendResponseLine(
                    `Unable to navigate forward in the selected page: ${error.message}.`,
                  );
                }
                break;
              case 'reload':
                try {
                  await page.pptrPage.reload({
                    ...options,
                    ignoreCache: request.params.ignoreCache,
                  });
                  response.appendResponseLine(
                    `Successfully reloaded the page.`,
                  );
                } catch (error) {
                  response.appendResponseLine(
                    `Unable to reload the selected page: ${error.message}.`,
                  );
                }
                break;
            }
          },
          {
            timeout: request.params.timeout,
            answerBeforeUnload: action,
          },
        );
        if (result.dialogHandled) {
          response.appendResponseLine(
            `${action === 'dismiss' ? 'Dismissed' : 'Accepted'} a beforeunload dialog.`,
          );
          page.clearDialog();
        }
      } finally {
        if (initScriptId) {
          await page.pptrPage
            .removeScriptToEvaluateOnNewDocument(initScriptId)
            .catch(error => {
              logger?.(`Failed to remove init script`, error);
            });
        }
      }

      response.setIncludePages(true);
      response.setListThirdPartyDeveloperTools();
      response.setListWebMcpTools();
    },
  };
});

export const resizePage = definePageTool({
  name: 'resize_page',
  description: `Resizes the selected page's window so that the page has specified dimension`,
  annotations: {
    category: ToolCategory.EMULATION,
    readOnlyHint: false,
  },
  schema: {
    width: zod.number().describe('Page width'),
    height: zod.number().describe('Page height'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;

    try {
      const browser = page.pptrPage.browser();
      const windowId = await page.pptrPage.windowId();

      const bounds = await browser.getWindowBounds(windowId);

      if (bounds.windowState === 'fullscreen') {
        // Have to call this twice on Ubuntu when the window is in fullscreen mode.
        await browser.setWindowBounds(windowId, {windowState: 'normal'});
        await browser.setWindowBounds(windowId, {windowState: 'normal'});
      } else if (bounds.windowState !== 'normal') {
        await browser.setWindowBounds(windowId, {windowState: 'normal'});
      }
    } catch {
      // Window APIs are not supported on all platforms
    }
    await page.pptrPage.resize({
      contentWidth: request.params.width,
      contentHeight: request.params.height,
    });

    response.setIncludePages(true);
  },
});

export const handleDialog = definePageTool({
  name: 'handle_dialog',
  description: `If a browser dialog was opened, use this command to handle it`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum(['accept', 'dismiss'])
      .describe('Whether to dismiss or accept the dialog'),
    promptText: zod
      .string()
      .optional()
      .describe('Optional prompt text to enter into the dialog.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const page = request.page;
    const dialog = page.getDialog();
    if (!dialog) {
      throw new Error('No open dialog found');
    }

    switch (request.params.action) {
      case 'accept': {
        try {
          await dialog.accept(request.params.promptText);
        } catch (err) {
          // Likely already handled by the user outside of MCP.
          logger?.(err);
        }
        response.appendResponseLine('Successfully accepted the dialog');
        break;
      }
      case 'dismiss': {
        try {
          await dialog.dismiss();
        } catch (err) {
          // Likely already handled.
          logger?.(err);
        }
        response.appendResponseLine('Successfully dismissed the dialog');
        break;
      }
    }

    page.clearDialog();
    response.setIncludePages(true);
  },
});

export const getTabId = definePageTool({
  name: 'get_tab_id',
  description: `Get the tab ID of the page`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
    conditions: ['experimentalInteropTools'],
  },
  schema: {
    pageId: zod
      .number()
      .describe(
        `The ID of the page to get the tab ID for. Call ${listPages().name} to get available pages.`,
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const page = context.getPageById(request.params.pageId);
    const tabId = (page.pptrPage as unknown as CdpPage)._tabId;
    response.setTabId(tabId);
    response.appendResponseLine(`Tab ID: ${tabId}`);
  },
});
