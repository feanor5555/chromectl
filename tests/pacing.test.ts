/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {
  BUDGET_SAFETY_FACTOR,
  CALL_OVERHEAD_MS,
  callBudgetMs,
  CHARACTER_MAX_MS,
  currentPace,
  drawKeyHoldMs,
  drawMouseHoldMs,
  drawPacingMs,
  FULL_SPEED_META_KEY,
  isFullSpeedRequest,
  KEY_HOLD_MAX_MS,
  KEY_HOLD_MIN_MS,
  KEY_INTERVAL_MAX_MS,
  KEY_INTERVAL_MIN_MS,
  MIN_CALL_BUDGET_MS,
  MOUSE_HOLD_MAX_MS,
  MOUSE_HOLD_MIN_MS,
  MUTEX_WAIT_CEILING_MS,
  PACE_FULL,
  PACE_HUMAN,
  PACING_SKEW,
  pacedSleep,
  pauseAfterScroll,
  pauseBeforeAction,
  queuedCallBudgetMs,
  PRE_ACTION_PAUSE_MAX_MS,
  PRE_ACTION_PAUSE_MIN_MS,
  SCROLL_PAUSE_MAX_MS,
  SCROLL_PAUSE_MIN_MS,
  selectPace,
  settleAfterAction,
  SETTLE_MAX_MS,
  SETTLE_MIN_MS,
  sleepKeyIntervalMs,
  sleepMs,
  WAIT_FOR_HELPER_MAX_MS,
} from '../src/pacing.js';

const SAMPLE_COUNT = 20_000;

function draw(count: number, minMs: number, maxMs: number): number[] {
  return Array.from({length: count}, () => drawPacingMs(minMs, maxMs));
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe('pacing', () => {
  describe('drawPacingMs', () => {
    it('stays inside the interval', () => {
      for (const [minMs, maxMs] of [
        [KEY_HOLD_MIN_MS, KEY_HOLD_MAX_MS],
        [KEY_INTERVAL_MIN_MS, KEY_INTERVAL_MAX_MS],
        [PRE_ACTION_PAUSE_MIN_MS, PRE_ACTION_PAUSE_MAX_MS],
        [SCROLL_PAUSE_MIN_MS, SCROLL_PAUSE_MAX_MS],
        [MOUSE_HOLD_MIN_MS, MOUSE_HOLD_MAX_MS],
      ]) {
        for (const value of draw(SAMPLE_COUNT, minMs, maxMs)) {
          assert.ok(
            value >= minMs && value <= maxMs,
            `${value} outside ${minMs}..${maxMs}`,
          );
        }
      }
    });

    it('reaches both ends of the interval', () => {
      const random = sinon.stub(Math, 'random');
      try {
        random.returns(0);
        assert.strictEqual(drawPacingMs(15, 80), 15);
        random.returns(1);
        assert.strictEqual(drawPacingMs(15, 80), 80);
      } finally {
        random.restore();
      }
    });

    it('returns the bound of an empty interval', () => {
      assert.strictEqual(drawPacingMs(70, 70), 70);
    });

    it('draws right-skewed: most values sit near the lower bound', () => {
      const values = draw(
        SAMPLE_COUNT,
        KEY_INTERVAL_MIN_MS,
        KEY_INTERVAL_MAX_MS,
      );
      const span = KEY_INTERVAL_MAX_MS - KEY_INTERVAL_MIN_MS;
      const belowMiddle = values.filter(
        value => value < KEY_INTERVAL_MIN_MS + span / 2,
      ).length;
      const inTail = values.filter(
        value => value > KEY_INTERVAL_MIN_MS + span * 0.8,
      ).length;

      // A flat draw would put half of them below the middle and a fifth in the
      // top fifth of the range.
      assert.ok(
        belowMiddle / values.length > 0.6,
        `only ${belowMiddle} of ${values.length} below the middle`,
      );
      assert.ok(
        inTail / values.length < 0.15 && inTail > 0,
        `${inTail} of ${values.length} in the tail`,
      );
    });

    it('centres where the skew puts it', () => {
      const expectedFraction = 1 / (PACING_SKEW + 1);
      for (const [minMs, maxMs] of [
        [KEY_HOLD_MIN_MS, KEY_HOLD_MAX_MS],
        [KEY_INTERVAL_MIN_MS, KEY_INTERVAL_MAX_MS],
        [PRE_ACTION_PAUSE_MIN_MS, PRE_ACTION_PAUSE_MAX_MS],
      ]) {
        const span = maxMs - minMs;
        const expected = minMs + span * expectedFraction;
        const actual = mean(draw(SAMPLE_COUNT, minMs, maxMs));
        assert.ok(
          Math.abs(actual - expected) < span * 0.03,
          `mean ${actual} of ${minMs}..${maxMs} is not near ${expected}`,
        );
      }
    });

    it('does not repeat itself', () => {
      const values = draw(
        200,
        PRE_ACTION_PAUSE_MIN_MS,
        PRE_ACTION_PAUSE_MAX_MS,
      );
      assert.ok(new Set(values).size > 100);
    });
  });

  describe('the named draws', () => {
    it('take their bounds from the constants', () => {
      for (const [drawOne, minMs, maxMs] of [
        [drawKeyHoldMs, KEY_HOLD_MIN_MS, KEY_HOLD_MAX_MS],
        [drawMouseHoldMs, MOUSE_HOLD_MIN_MS, MOUSE_HOLD_MAX_MS],
      ] as Array<[() => number, number, number]>) {
        for (let i = 0; i < 1_000; i++) {
          const value = drawOne();
          assert.ok(value >= minMs && value <= maxMs, `${value} out of range`);
        }
      }
    });
  });

  describe('sleeping', () => {
    it('waits at least as long as it was asked to', async () => {
      const before = Date.now();
      await sleepMs(30);
      assert.ok(Date.now() - before >= 29);
    });

    it('reports what it waited', async () => {
      const before = Date.now();
      const waited = await pacedSleep(20, 40);
      assert.ok(waited >= 20 && waited <= 40);
      assert.ok(Date.now() - before >= waited - 1);
    });

    it('paces a key gap and a pre-action pause from the same shape', async () => {
      const gap = await sleepKeyIntervalMs();
      assert.ok(gap >= KEY_INTERVAL_MIN_MS && gap <= KEY_INTERVAL_MAX_MS);
      const pause = await pauseBeforeAction();
      assert.ok(
        pause >= PRE_ACTION_PAUSE_MIN_MS && pause <= PRE_ACTION_PAUSE_MAX_MS,
      );
    });
  });

  describe('the pause after a jump', () => {
    it('is paid only when the page actually moved', async () => {
      const before = Date.now();
      assert.strictEqual(await pauseAfterScroll(false), 0);
      assert.ok(
        Date.now() - before < 50,
        'an element already in the viewport waited',
      );

      const waited = await pauseAfterScroll(true);
      assert.ok(
        waited >= SCROLL_PAUSE_MIN_MS && waited <= SCROLL_PAUSE_MAX_MS,
        `${waited} outside ${SCROLL_PAUSE_MIN_MS}..${SCROLL_PAUSE_MAX_MS}`,
      );
      assert.ok(Date.now() - before >= waited - 1);
    });

    it('is longer than the pause before an action', () => {
      assert.ok(SCROLL_PAUSE_MIN_MS > PRE_ACTION_PAUSE_MAX_MS);
    });

    it('waits nothing at full speed', async () => {
      const restore = selectPace(true);
      try {
        const before = Date.now();
        assert.strictEqual(await pauseAfterScroll(true), 0);
        assert.ok(Date.now() - before < 50);
      } finally {
        restore();
      }
      assert.deepStrictEqual(PACE_FULL.scrollPauseMs, [0, 0]);
      assert.deepStrictEqual(PACE_HUMAN.scrollPauseMs, [
        SCROLL_PAUSE_MIN_MS,
        SCROLL_PAUSE_MAX_MS,
      ]);
    });
  });

  describe('the settle window after an action', () => {
    it('is drawn from the human interval', async () => {
      const waited = await settleAfterAction();

      assert.ok(
        waited >= SETTLE_MIN_MS && waited <= SETTLE_MAX_MS,
        `${waited} outside ${SETTLE_MIN_MS}..${SETTLE_MAX_MS}`,
      );
    });

    it('waits nothing at full speed', async () => {
      const restore = selectPace(true);
      try {
        const before = Date.now();
        assert.strictEqual(await settleAfterAction(), 0);
        assert.ok(Date.now() - before < 50);
      } finally {
        restore();
      }
      assert.deepStrictEqual(PACE_FULL.settleMs, [0, 0]);
      assert.deepStrictEqual(PACE_HUMAN.settleMs, [
        SETTLE_MIN_MS,
        SETTLE_MAX_MS,
      ]);
    });
  });

  describe('the call budget', () => {
    it('covers the worst case of a braked fill', () => {
      const value = 'a'.repeat(150);
      // What the braked path can cost at most: the pause before the field, the
      // select-all that clears it, and every character held and followed by a
      // gap.
      const selectAllMs = KEY_HOLD_MAX_MS + 2 * KEY_INTERVAL_MAX_MS;
      const worstCaseMs =
        PRE_ACTION_PAUSE_MAX_MS + selectAllMs + value.length * CHARACTER_MAX_MS;

      assert.ok(callBudgetMs('fill', {value}) > worstCaseMs);
    });

    it('covers the worst case of braked typing with a submit key', () => {
      const text = 'a'.repeat(150);
      const worstCaseMs =
        text.length * CHARACTER_MAX_MS +
        PRE_ACTION_PAUSE_MAX_MS +
        KEY_HOLD_MAX_MS;

      assert.ok(callBudgetMs('type_text', {text}) > worstCaseMs);
    });

    it('covers a form of many short fields that each make the page jump', () => {
      const value = 'a'.repeat(5);
      const elements = Array.from({length: 20}, () => ({value}));
      // Every element enters the wrapper of its own, so it pays the pause
      // before it, the pause after the page jumped to it, the helper's windows
      // around it and the settle window behind it, plus the select-all that
      // clears it and its own characters.
      const selectAllMs = KEY_HOLD_MAX_MS + 2 * KEY_INTERVAL_MAX_MS;
      const worstCaseMs =
        CALL_OVERHEAD_MS +
        elements.length *
          (PRE_ACTION_PAUSE_MAX_MS +
            SCROLL_PAUSE_MAX_MS +
            SETTLE_MAX_MS +
            WAIT_FOR_HELPER_MAX_MS +
            selectAllMs +
            value.length * CHARACTER_MAX_MS);

      assert.ok(
        callBudgetMs('fill_form', {elements}) > worstCaseMs,
        `${callBudgetMs('fill_form', {elements})} does not cover ${worstCaseMs}`,
      );
    });

    it('covers a wait the caller asked for by name', () => {
      const timeout = 300_000;

      for (const tool of ['wait_for', 'navigate_page', 'new_page']) {
        const budgetMs = callBudgetMs(tool, {timeout});
        assert.ok(
          budgetMs > timeout,
          `${tool}: ${budgetMs} does not cover ${timeout}`,
        );
        assert.ok(
          budgetMs > callBudgetMs(tool, {}),
          `${tool}: the timeout adds nothing to the budget`,
        );
      }
    });

    it('counts that wait at full speed too', () => {
      const timeout = 300_000;

      assert.ok(callBudgetMs('wait_for', {timeout}, true) > timeout);
      assert.strictEqual(
        callBudgetMs('wait_for', {timeout}, true),
        Math.ceil(timeout * BUDGET_SAFETY_FACTOR),
      );
    });

    it('leaves a call without an own timeout where it was', () => {
      // Zero and below are what the tool schema drops in favour of its own
      // default, and a non-number never reaches a tool at all.
      for (const timeout of [0, -1, undefined, 'soon']) {
        assert.strictEqual(
          callBudgetMs('wait_for', {timeout}),
          callBudgetMs('wait_for', {}),
        );
      }
      assert.strictEqual(callBudgetMs('wait_for', {}), MIN_CALL_BUDGET_MS);
    });

    it('falls back to the floor at full speed', () => {
      const value = 'a'.repeat(2_000);

      assert.ok(callBudgetMs('fill', {value}) > MIN_CALL_BUDGET_MS);
      assert.strictEqual(
        callBudgetMs('fill', {value}, true),
        MIN_CALL_BUDGET_MS,
      );
      assert.strictEqual(
        callBudgetMs('type_text', {text: value}, true),
        MIN_CALL_BUDGET_MS,
      );
      assert.strictEqual(
        callBudgetMs(
          'fill_form',
          {elements: [{value}, {value}, {value}]},
          true,
        ),
        MIN_CALL_BUDGET_MS,
      );
    });
  });

  describe('the queued budget', () => {
    it('adds the wait for the browser to the work budget', () => {
      const value = 'a'.repeat(600);

      for (const [tool, args] of [
        [undefined, undefined],
        ['click', {}],
        ['fill', {value}],
        ['type_text', {text: value}],
        ['wait_for', {text: [value], timeout: 300_000}],
      ] as Array<[string | undefined, Record<string, unknown> | undefined]>) {
        assert.strictEqual(
          queuedCallBudgetMs(tool, args),
          MUTEX_WAIT_CEILING_MS + callBudgetMs(tool, args),
        );
      }
    });

    it('leaves the work budget itself untouched', () => {
      const value = 'a'.repeat(600);

      assert.strictEqual(
        queuedCallBudgetMs('fill', {value}) - callBudgetMs('fill', {value}),
        MUTEX_WAIT_CEILING_MS,
      );
      assert.strictEqual(
        queuedCallBudgetMs('fill', {value}, true),
        MUTEX_WAIT_CEILING_MS + MIN_CALL_BUDGET_MS,
      );
    });

    it('caps the wait at three minutes, whatever the call types', () => {
      assert.strictEqual(MUTEX_WAIT_CEILING_MS, 180_000);
    });
  });

  describe('full speed', () => {
    it('is not what a call runs at unless it is selected', () => {
      assert.strictEqual(currentPace(), PACE_HUMAN);
    });

    it('is read off the request metadata and nothing else', () => {
      assert.strictEqual(isFullSpeedRequest(undefined), false);
      assert.strictEqual(isFullSpeedRequest({}), false);
      assert.strictEqual(isFullSpeedRequest({fullSpeed: true}), false);
      assert.strictEqual(
        isFullSpeedRequest({[FULL_SPEED_META_KEY]: 'true'}),
        false,
      );
      assert.strictEqual(
        isFullSpeedRequest({[FULL_SPEED_META_KEY]: true}),
        true,
      );
    });

    it('hands the previous profile back', () => {
      const restore = selectPace(true);
      assert.strictEqual(currentPace(), PACE_FULL);
      restore();
      assert.strictEqual(currentPace(), PACE_HUMAN);
    });

    it('fills in one shot where human pacing types', () => {
      assert.strictEqual(PACE_HUMAN.fillsInOneShot, false);
      assert.strictEqual(PACE_FULL.fillsInOneShot, true);
    });

    it('draws no interval at all', () => {
      const restore = selectPace(true);
      try {
        for (let i = 0; i < 1_000; i++) {
          assert.strictEqual(drawKeyHoldMs(), 0);
          assert.strictEqual(drawMouseHoldMs(), 0);
        }
      } finally {
        restore();
      }
    });

    it('waits out nothing, not even a timer per keystroke', async () => {
      const restore = selectPace(true);
      try {
        const before = Date.now();
        for (let i = 0; i < 500; i++) {
          assert.strictEqual(await sleepKeyIntervalMs(), 0);
          assert.strictEqual(await pauseBeforeAction(), 0);
        }
        // A thousand zero-length timers would cost about a second; without a
        // timer at all the loop is bounded by its own bookkeeping.
        assert.ok(
          Date.now() - before < 100,
          `1000 full-speed waits took ${Date.now() - before}ms`,
        );
      } finally {
        restore();
      }
    });

    it('leaves human pacing untouched for the next call', async () => {
      selectPace(true)();
      const hold = drawKeyHoldMs();
      assert.ok(hold >= KEY_HOLD_MIN_MS && hold <= KEY_HOLD_MAX_MS);
      const gap = await sleepKeyIntervalMs();
      assert.ok(gap >= KEY_INTERVAL_MIN_MS);
    });
  });
});
