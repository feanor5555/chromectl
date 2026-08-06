/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  abandonIfBlocked,
  answerOrAbandon,
  currentInterruption,
  InteractionInterruptedError,
  observeInterruptions,
  observeRendererBlock,
} from '../src/interruption.js';
import {DISPATCH_DEADLINE_MS} from '../src/pacing.js';

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

describe('the deadline on one dispatch', () => {
  afterEach(() => {
    sinon.restore();
  });

  /** A command nobody ever answers. */
  function neverAnswered<T>(): Promise<T> {
    return new Promise<T>(() => {
      return;
    });
  }

  /** A block signal that never arrives, so only the deadline can end a wait. */
  function nothingBlocks(): () => void {
    return observeRendererBlock(
      new Promise<void>(() => {
        return;
      }),
    );
  }

  /** Runs one dispatch and lets the deadline pass. */
  async function exhaustTheDeadline(pending: Promise<unknown>) {
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const outcome = assert.rejects(pending, InteractionInterruptedError);
      await clock.tickAsync(DISPATCH_DEADLINE_MS);
      await outcome;
    } finally {
      clock.restore();
    }
  }

  it('ends a dispatch nobody answers, with nothing watching', async () => {
    await exhaustTheDeadline(abandonIfBlocked(neverAnswered()));
  });

  it('ends a dispatch nobody answers while a signal is installed', async () => {
    const restore = nothingBlocks();
    try {
      await exhaustTheDeadline(abandonIfBlocked(neverAnswered()));
    } finally {
      restore();
    }
  });

  it('ends a round trip nobody answers, with nothing watching', async () => {
    await exhaustTheDeadline(answerOrAbandon(neverAnswered()));
  });

  it('ends a round trip nobody answers while a signal is installed', async () => {
    const restore = nothingBlocks();
    try {
      await exhaustTheDeadline(answerOrAbandon(neverAnswered()));
    } finally {
      restore();
    }
  });

  it('says what happened rather than blaming the element', async () => {
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const outcome = assert.rejects(abandonIfBlocked(neverAnswered()), {
        message: new RegExp(
          `did not answer a command within ${DISPATCH_DEADLINE_MS} ms`,
        ),
      });
      await clock.tickAsync(DISPATCH_DEADLINE_MS);
      await outcome;
    } finally {
      clock.restore();
    }
  });

  it('hands back the answer of a round trip that came in time', async () => {
    assert.strictEqual(
      await answerOrAbandon(Promise.resolve('the value')),
      'the value',
    );
  });

  it('leaves no timer behind once the command was answered', async () => {
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      await abandonIfBlocked(Promise.resolve());
      await answerOrAbandon(Promise.resolve('the value'));

      assert.strictEqual(clock.countTimers(), 0);
    } finally {
      clock.restore();
    }
  });

  it('lets the dialog signal end the wait before the deadline does', async () => {
    let blocked!: () => void;
    const restore = observeRendererBlock(
      new Promise<void>(resolve => {
        blocked = resolve;
      }),
    );
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const dispatch = abandonIfBlocked(neverAnswered());
      blocked();
      await dispatch;

      // The deadline was taken down with the wait it was raced against.
      assert.strictEqual(clock.countTimers(), 0);
    } finally {
      clock.restore();
      restore();
    }
  });
});
