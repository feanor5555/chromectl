/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  abandonIfBlocked,
  currentInterruption,
  observeInterruptions,
  observeRendererBlock,
} from '../src/interruption.js';

describe('the interruption check of a paced stream', () => {
  it('reports nothing while nobody is watching', () => {
    assert.strictEqual(currentInterruption(), undefined);
  });

  it('reads the state afresh on every test', () => {
    let reason: 'navigation' | 'dialog' | undefined;
    const restore = observeInterruptions(() => reason);

    try {
      assert.strictEqual(currentInterruption(), undefined);
      reason = 'navigation';
      assert.strictEqual(currentInterruption(), 'navigation');
      reason = 'dialog';
      assert.strictEqual(currentInterruption(), 'dialog');
    } finally {
      restore();
    }
  });

  it('leaves no check behind for the stage that follows', () => {
    const restore = observeInterruptions(() => 'navigation');
    restore();

    assert.strictEqual(currentInterruption(), undefined);
  });

  it('waits out a dispatch while nothing is blocking', async () => {
    let settled = false;

    await abandonIfBlocked(
      Promise.resolve().then(() => {
        settled = true;
      }),
    );

    assert.strictEqual(settled, true);
  });

  it('reports what a dispatch failed with while nothing is blocking', async () => {
    await assert.rejects(
      abandonIfBlocked(Promise.reject(new Error('dispatch refused'))),
      /dispatch refused/,
    );
  });

  it('gives up on a dispatch the paused renderer will not answer', async () => {
    let blocked!: () => void;
    const restore = observeRendererBlock(
      new Promise<void>(resolve => {
        blocked = resolve;
      }),
    );
    // The command the dialog holds: it is answered by nobody, and nothing can
    // cancel it.
    let abandonedFailed!: (error: Error) => void;
    const abandoned = new Promise<void>((_resolve, reject) => {
      abandonedFailed = reject;
    });

    try {
      let returned = false;
      const dispatch = abandonIfBlocked(abandoned).then(() => {
        returned = true;
      });
      await Promise.resolve();
      assert.strictEqual(returned, false);

      blocked();
      await dispatch;
      assert.strictEqual(returned, true);

      // The abandoned command fails later, when the connection gives up on it,
      // and nobody is waiting for it any more.
      abandonedFailed(new Error('the protocol timed out'));
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      restore();
    }
  });

  it('still reports a dispatch that failed before anything blocked', async () => {
    // A signal that never arrives: nothing pauses the renderer here.
    const restore = observeRendererBlock(
      new Promise<void>(() => {
        return;
      }),
    );

    try {
      await assert.rejects(
        abandonIfBlocked(Promise.reject(new Error('dispatch refused'))),
        /dispatch refused/,
      );
    } finally {
      restore();
    }
  });

  it('restores the check it displaced', () => {
    const restoreOuter = observeInterruptions(() => 'navigation');
    const restoreInner = observeInterruptions(() => 'dialog');

    try {
      assert.strictEqual(currentInterruption(), 'dialog');
      restoreInner();
      assert.strictEqual(currentInterruption(), 'navigation');
    } finally {
      restoreOuter();
    }
  });
});
