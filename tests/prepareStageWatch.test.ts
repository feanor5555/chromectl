/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {
  currentInterruption,
  type InterruptionReason,
} from '../src/interruption.js';
import {McpPage} from '../src/McpPage.js';
import {selectPace} from '../src/pacing.js';
import {Locator, type Frame, type Page} from '../src/third_party/index.js';
import type {WaitForHelper} from '../src/WaitForHelper.js';

const PAGE_URL = 'https://example.test/form';

/** A frame of the fake page: an id and the chain it hangs in. */
function fakeFrame(id: string, parent?: Frame): Frame {
  const frame = {
    _id: id,
    parentFrame: () => parent ?? null,
  };
  return frame as unknown as Frame;
}

/**
 * A page that answers nothing but what the prepare-stage watch reads from it:
 * its session, its main frame and its URL. The navigation events the watch
 * filters are emitted on that session by the test itself, so no browser and no
 * real document is needed to decide which of them counts.
 */
function createFakePage(url = PAGE_URL): {
  mcpPage: McpPage;
  session: EventEmitter;
  mainFrame: Frame;
  navigationResult: {resolves: boolean};
} {
  const session = new EventEmitter();
  Object.assign(session, {
    target: () => ({_targetId: 'fake-target'}),
  });
  const mainFrame = fakeFrame('main-frame');
  const navigationResult = {resolves: true};
  const page = new EventEmitter();
  Object.assign(page, {
    _client: () => session,
    mainFrame: () => mainFrame,
    url: () => url,
    waitForNavigation: async () => {
      if (!navigationResult.resolves) {
        throw new Error('Navigation timeout of 3000 ms exceeded');
      }
      return undefined;
    },
  });

  const mcpPage = new McpPage(page as unknown as Page, 1, {
    hasNetworkBlockOrAllowlist: false,
    locatorClass: Locator,
  });
  // Neither the helper's own wait nor the stable-DOM wait has a page to run
  // against here; what the tests read is which frame the watch counted.
  mcpPage.createWaitForHelper = () =>
    ({
      waitForEventsAfterAction: async (action: () => Promise<unknown>) => {
        await action();
        return {};
      },
      waitForStableDom: async () => undefined,
    }) as unknown as WaitForHelper;

  return {mcpPage, session, mainFrame, navigationResult};
}

function startNavigating(session: EventEmitter, frameId: string): void {
  session.emit('Page.frameStartedNavigating', {
    frameId,
    url: 'https://example.test/next',
    navigationType: 'differentDocument',
  });
}

describe('the navigation watched over a paced interaction', () => {
  it('types on while a frame the interaction does not address navigates', async () => {
    const {mcpPage, session} = createFakePage();
    const restorePace = selectPace(true);
    let seenWhilePreparing: InterruptionReason | undefined;

    try {
      const result = await mcpPage.waitForEventsAfterTrigger(async () => {
        // An ad slot, an embedded video, a tracking frame: the page carries
        // them and they load while the stream types.
        startNavigating(session, 'ad-slot-frame');
        seenWhilePreparing = currentInterruption();
        return async () => undefined;
      });

      assert.strictEqual(seenWhilePreparing, undefined);
      assert.strictEqual(result.navigatedToUrl, undefined);
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });

  it('stops where it stands when the main frame navigates', async () => {
    const {mcpPage, session} = createFakePage();
    const restorePace = selectPace(true);
    let seenWhilePreparing: InterruptionReason | undefined;

    try {
      const result = await mcpPage.waitForEventsAfterTrigger(async () => {
        startNavigating(session, 'main-frame');
        seenWhilePreparing = currentInterruption();
        return async () => undefined;
      });

      assert.strictEqual(seenWhilePreparing, 'navigation');
      assert.strictEqual(result.navigatedToUrl, PAGE_URL);
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });

  it('stops when the frame the interaction addresses navigates', async () => {
    const {mcpPage, session, mainFrame} = createFakePage();
    const restorePace = selectPace(true);
    const addressedFrame = fakeFrame('form-frame', mainFrame);
    let seenWhilePreparing: InterruptionReason | undefined;

    try {
      await mcpPage.waitForEventsAfterTrigger(
        async () => {
          startNavigating(session, 'form-frame');
          seenWhilePreparing = currentInterruption();
          return async () => undefined;
        },
        {frame: addressedFrame},
      );

      assert.strictEqual(seenWhilePreparing, 'navigation');
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });

  it('stops when the frame the addressed one sits in navigates', async () => {
    const {mcpPage, session, mainFrame} = createFakePage();
    const restorePace = selectPace(true);
    const addressedFrame = fakeFrame('form-frame', mainFrame);
    let seenWhilePreparing: InterruptionReason | undefined;

    try {
      await mcpPage.waitForEventsAfterTrigger(
        async () => {
          startNavigating(session, 'main-frame');
          seenWhilePreparing = currentInterruption();
          return async () => undefined;
        },
        {frame: addressedFrame},
      );

      assert.strictEqual(seenWhilePreparing, 'navigation');
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });

  it('types on while a frame beside the addressed one navigates', async () => {
    const {mcpPage, session, mainFrame} = createFakePage();
    const restorePace = selectPace(true);
    const addressedFrame = fakeFrame('form-frame', mainFrame);
    let seenWhilePreparing: InterruptionReason | undefined;

    try {
      await mcpPage.waitForEventsAfterTrigger(
        async () => {
          startNavigating(session, 'ad-slot-frame');
          seenWhilePreparing = currentInterruption();
          return async () => undefined;
        },
        {frame: addressedFrame},
      );

      assert.strictEqual(seenWhilePreparing, undefined);
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });

  it('counts no navigation for a same-document one', async () => {
    const {mcpPage, session} = createFakePage();
    const restorePace = selectPace(true);
    let seenWhilePreparing: InterruptionReason | undefined;

    try {
      await mcpPage.waitForEventsAfterTrigger(async () => {
        session.emit('Page.frameStartedNavigating', {
          frameId: 'main-frame',
          url: `${PAGE_URL}#section`,
          navigationType: 'sameDocument',
        });
        seenWhilePreparing = currentInterruption();
        return async () => undefined;
      });

      assert.strictEqual(seenWhilePreparing, undefined);
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });

  it('reports no navigation when the one that started never arrived', async () => {
    const {mcpPage, session, navigationResult} = createFakePage();
    const restorePace = selectPace(true);
    navigationResult.resolves = false;

    try {
      const result = await mcpPage.waitForEventsAfterTrigger(async () => {
        startNavigating(session, 'main-frame');
        return async () => undefined;
      });

      assert.deepStrictEqual(result, {});
    } finally {
      restorePace();
      mcpPage.dispose();
    }
  });
});
