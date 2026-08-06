/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {observeInterruptions} from '../src/interruption.js';
import {
  drawPointerPath,
  drawViewportEdgePoint,
  type PointerPoint,
} from '../src/pacing.js';
import {travelPaced} from '../src/pointerTravel.js';
import type {ContextPage} from '../src/tools/ToolDefinition.js';
import {seededRandom} from './utils.js';

/** One move as the page saw it: where it went and when it was dispatched. */
interface RecordedMove {
  x: number;
  y: number;
  atMs: number;
}

function stubPage(
  options: {
    position?: PointerPoint;
    leadPauseMs?: number;
    layoutViewport?: {clientWidth: number; clientHeight: number};
    layoutMetricsFail?: boolean;
    viewport?: {width: number; height: number} | null;
  } = {},
): {page: ContextPage; moves: RecordedMove[]; position: () => PointerPoint} {
  const moves: RecordedMove[] = [];
  let position = options.position;
  let leadPauseMs = options.leadPauseMs ?? 0;
  const page = {
    pptrPage: {
      mouse: {
        move(x: number, y: number): Promise<void> {
          moves.push({x, y, atMs: Date.now()});
          return Promise.resolve();
        },
      },
      viewport: () => options.viewport ?? null,
      _client: () => {
        return {
          send: () => {
            if (options.layoutMetricsFail) {
              return Promise.reject(new Error('no metrics'));
            }
            return Promise.resolve({
              cssLayoutViewport: options.layoutViewport ?? {
                clientWidth: 1_280,
                clientHeight: 800,
              },
            });
          },
        };
      },
    },
    get pointerPosition(): PointerPoint | undefined {
      return position;
    },
    setPointerPosition(next: PointerPoint): void {
      position = {x: next.x, y: next.y};
    },
    takeLeadPause(): number {
      const reserved = leadPauseMs;
      leadPauseMs = 0;
      return reserved;
    },
  };
  return {
    page: page as unknown as ContextPage,
    moves,
    position: () => position as PointerPoint,
  };
}

/** The path the production draw produces from one seed, without dispatching it. */
function pathFromSeed(
  seed: number,
  from: PointerPoint,
  to: PointerPoint,
): ReturnType<typeof drawPointerPath> {
  const random = sinon.stub(Math, 'random').callsFake(seededRandom(seed));
  try {
    return drawPointerPath(from, to);
  } finally {
    random.restore();
  }
}

/** Runs one travel out on a fake clock and hands back what the page saw. */
async function travel(
  seed: number,
  page: ContextPage,
  to: PointerPoint,
): Promise<{elapsedMs: number}> {
  const clock = sinon.useFakeTimers();
  const random = sinon.stub(Math, 'random').callsFake(seededRandom(seed));
  try {
    const travelling = travelPaced(page, to);
    await clock.runAllAsync();
    await travelling;
    return {elapsedMs: clock.now};
  } finally {
    random.restore();
    clock.restore();
  }
}

describe('the pointer travel', () => {
  const from = {x: 120, y: 90};
  const to = {x: 940, y: 610};

  it('dispatches one move per point of the path it drew', async () => {
    const expected = pathFromSeed(31, from, to);
    const {page, moves, position} = stubPage({position: from});

    const {elapsedMs} = await travel(31, page, to);

    assert.deepStrictEqual(
      moves.map(move => ({x: move.x, y: move.y})),
      expected.points.map(point => ({x: point.x, y: point.y})),
    );
    // The pointer ends the travel believing it stands on the last point of the
    // path; the move that follows it is the one that carries the interaction.
    assert.deepStrictEqual(position(), {
      x: expected.points.at(-1)?.x,
      y: expected.points.at(-1)?.y,
    });
    assert.strictEqual(elapsedMs, expected.durationMs);
  });

  it('keeps to the schedule it drew rather than to its own sleeps', async () => {
    const expected = pathFromSeed(32, from, to);
    const {page, moves} = stubPage({position: from});

    await travel(32, page, to);

    let dueAtMs = 0;
    for (const [index, point] of expected.points.entries()) {
      assert.strictEqual(
        moves[index].atMs,
        dueAtMs,
        `point ${index} was dispatched at ${moves[index].atMs}, not at ${dueAtMs}`,
      );
      dueAtMs += point.gapMs;
    }
  });

  it('waits out what is left of the reserved pause before setting off', async () => {
    const expected = pathFromSeed(33, from, to);
    const leadPauseMs = expected.durationMs + 250;
    const {page, moves} = stubPage({position: from, leadPauseMs});

    const {elapsedMs} = await travel(33, page, to);

    assert.strictEqual(moves[0].atMs, 250);
    assert.strictEqual(elapsedMs, leadPauseMs);
  });

  it('waits nothing when the path is longer than the pause', async () => {
    const expected = pathFromSeed(34, from, to);
    const {page, moves} = stubPage({
      position: from,
      leadPauseMs: Math.floor(expected.durationMs / 2),
    });

    const {elapsedMs} = await travel(34, page, to);

    assert.strictEqual(moves[0].atMs, 0);
    assert.strictEqual(elapsedMs, expected.durationMs);
  });

  it('stops where it stands when the page interrupts it', async () => {
    const {page, moves} = stubPage({position: from});
    const restore = observeInterruptions(() =>
      moves.length >= 3 ? 'navigation' : undefined,
    );
    try {
      await travel(35, page, to);
    } finally {
      restore();
    }

    assert.strictEqual(moves.length, 3);
  });

  it('sets off from the edge of the viewport when nothing has moved yet', async () => {
    const random = sinon.stub(Math, 'random').callsFake(seededRandom(36));
    let start: PointerPoint;
    let expected: ReturnType<typeof drawPointerPath>;
    try {
      start = drawViewportEdgePoint(1_000, 600);
      expected = drawPointerPath(start, to);
    } finally {
      random.restore();
    }
    const {page, moves} = stubPage({
      layoutViewport: {clientWidth: 1_000, clientHeight: 600},
    });

    await travel(36, page, to);

    assert.ok(
      start.x === 0 || start.x === 1_000 || start.y === 0 || start.y === 600,
      `(${start.x}, ${start.y}) is not on the perimeter`,
    );
    assert.deepStrictEqual(
      moves.map(move => ({x: move.x, y: move.y})),
      expected.points.map(point => ({x: point.x, y: point.y})),
    );
  });

  it('sets off anyway when the layout viewport cannot be read', async () => {
    for (const viewport of [{width: 900, height: 500}, null]) {
      const {page, moves} = stubPage({layoutMetricsFail: true, viewport});

      await travel(37, page, to);

      assert.ok(moves.length >= 8, `${moves.length} moves after the fallback`);
    }
  });
});
