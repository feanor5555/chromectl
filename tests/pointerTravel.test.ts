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
  POINTER_CURVATURE_MAX,
  POINTER_PATH_MAX_MS,
  POINTER_POINTS_MAX,
  POINTER_POINTS_MIN,
  POINTER_SHORTEST_STEP_PX,
  POINTER_STEP_GAP_MAX_MS,
  POINTER_STEP_GAP_MIN_MS,
  PACE_FULL,
  PACE_HUMAN,
  reserveLeadPause,
  selectPace,
  travelsPointer,
} from '../src/pacing.js';
import {
  drawPointerPath,
  drawViewportEdgePoint,
  pointerPosition,
  recordPointerAt,
  travelPaced,
  type PointerPoint,
} from '../src/pointerTravel.js';
import type {ContextPage} from '../src/tools/ToolDefinition.js';
import {fixedRandom, seededRandom} from './utils.js';

/** One move as the page saw it: where it went and when it was dispatched. */
interface RecordedMove {
  x: number;
  y: number;
  atMs: number;
}

function stubPage(
  options: {
    position?: PointerPoint;
    layoutViewport?: {clientWidth: number; clientHeight: number};
    layoutMetricsFail?: boolean;
    viewport?: {width: number; height: number} | null;
  } = {},
): {page: ContextPage; moves: RecordedMove[]; position: () => PointerPoint} {
  const moves: RecordedMove[] = [];
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
  } as unknown as ContextPage;
  if (options.position) {
    recordPointerAt(page, options.position);
  }
  return {
    page,
    moves,
    position: () => pointerPosition(page) as PointerPoint,
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
    // The pointer ends the travel on its target rather than on the last point
    // of the path: the move that follows is the one that puts it there.
    assert.deepStrictEqual(position(), to);
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
    const {page, moves} = stubPage({position: from});

    reserveLeadPause(leadPauseMs);
    const {elapsedMs} = await travel(33, page, to);

    assert.strictEqual(moves[0].atMs, 250);
    assert.strictEqual(elapsedMs, leadPauseMs);
  });

  it('waits nothing when the path is longer than the pause', async () => {
    const expected = pathFromSeed(34, from, to);
    const {page, moves} = stubPage({position: from});

    reserveLeadPause(Math.floor(expected.durationMs / 2));
    const {elapsedMs} = await travel(34, page, to);

    assert.strictEqual(moves[0].atMs, 0);
    assert.strictEqual(elapsedMs, expected.durationMs);
  });

  it('spends the reservation on a target it already stands on', async () => {
    const {page, moves, position} = stubPage({position: to});

    reserveLeadPause(400);
    const {elapsedMs} = await travel(38, page, to);

    // Nothing moved, so nothing is dispatched: a pointer standing still emits
    // no event on any real input stack.
    assert.deepStrictEqual(moves, []);
    assert.strictEqual(elapsedMs, 400);
    assert.deepStrictEqual(position(), to);
  });

  it('takes the reservation only once', async () => {
    const next = {x: 300, y: 200};
    const {page} = stubPage({position: from});

    reserveLeadPause(5_000);
    const first = await travel(39, page, to);
    const second = await travel(39, page, next);

    assert.strictEqual(first.elapsedMs, 5_000);
    // The second travel sets off from where the first left the pointer and
    // pays for itself: the reservation belonged to the action before it.
    assert.strictEqual(second.elapsedMs, pathFromSeed(39, to, next).durationMs);
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

  describe('the pointer path', () => {
    const from = {x: 100, y: 100};

    function pathBetween(
      random: () => number,
      to: {x: number; y: number},
      start = from,
    ) {
      const stub = sinon.stub(Math, 'random').callsFake(random);
      try {
        return drawPointerPath(start, to);
      } finally {
        stub.restore();
      }
    }

    function strideAt(
      points: ReadonlyArray<{x: number; y: number}>,
      index: number,
    ): number {
      return Math.hypot(
        points[index + 1].x - points[index].x,
        points[index + 1].y - points[index].y,
      );
    }

    it('draws the same path twice for the same seed', () => {
      const to = {x: 900, y: 640};
      const first = pathBetween(seededRandom(7), to);
      const second = pathBetween(seededRandom(7), to);
      const other = pathBetween(seededRandom(8), to);

      assert.deepStrictEqual(first, second);
      assert.notDeepStrictEqual(first, other);
    });

    it('takes more points the further it goes', () => {
      const counts = [200, 1_000, 4_000].map(
        distance =>
          pathBetween(fixedRandom([0.5]), {x: from.x + distance, y: from.y})
            .points.length,
      );

      assert.deepStrictEqual(counts, [8, 13, POINTER_POINTS_MAX]);
      for (const seed of [1, 2, 3, 4, 5]) {
        for (const distance of [30, 500, 10_000]) {
          const {points} = pathBetween(seededRandom(seed), {
            x: from.x + distance,
            y: from.y + distance,
          });
          assert.ok(
            points.length >= POINTER_POINTS_MIN &&
              points.length <= POINTER_POINTS_MAX,
            `${points.length} points for a distance of ${distance}`,
          );
        }
      }
    });

    it('draws nothing at all for a spot the pointer already stands on', () => {
      for (const seed of [41, 42, 43]) {
        for (const to of [
          from,
          {x: from.x + 1, y: from.y},
          {x: from.x, y: from.y - 2},
          {x: from.x + 2, y: from.y + 2},
        ]) {
          const path = pathBetween(seededRandom(seed), to);

          assert.deepStrictEqual(
            path.points,
            [],
            `(${to.x}, ${to.y}) was travelled to from (${from.x}, ${from.y})`,
          );
          assert.strictEqual(path.durationMs, 0);
        }
      }
    });

    it('takes no more points than the distance can carry', () => {
      for (const seed of [44, 45, 46]) {
        for (const distance of [POINTER_SHORTEST_STEP_PX, 10, 20, 44]) {
          const {points} = pathBetween(seededRandom(seed), {
            x: from.x + distance,
            y: from.y,
          });

          assert.ok(points.length >= 1, `${distance} px went in one jump`);
          assert.ok(
            points.length <= Math.floor(distance / POINTER_SHORTEST_STEP_PX),
            `${points.length} points over ${distance} px`,
          );
        }
      }
      // The floor of eight points would have made this hop a crawl of eight
      // events over up to 360 ms.
      const {points} = pathBetween(seededRandom(47), {
        x: from.x + 10,
        y: from.y,
      });
      assert.ok(points.length < POINTER_POINTS_MIN);
    });

    it('leaves both endpoints out', () => {
      const to = {x: 700, y: 500};
      const {points} = pathBetween(seededRandom(3), to);

      for (const point of points) {
        assert.notDeepStrictEqual({x: point.x, y: point.y}, from);
        assert.notDeepStrictEqual({x: point.x, y: point.y}, to);
      }
      // Every point lies between the two, and they arrive in that order.
      const distances = points.map(point =>
        Math.hypot(point.x - from.x, point.y - from.y),
      );
      for (let index = 1; index < distances.length; index++) {
        assert.ok(distances[index] > distances[index - 1]);
      }
    });

    it('stays inside the straight line expanded by the bow', () => {
      const to = {x: -400, y: 900};
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const room = distance * POINTER_CURVATURE_MAX;

      for (const seed of [11, 12, 13, 14, 15]) {
        for (const point of pathBetween(seededRandom(seed), to).points) {
          assert.ok(
            point.x >= Math.min(from.x, to.x) - room &&
              point.x <= Math.max(from.x, to.x) + room &&
              point.y >= Math.min(from.y, to.y) - room &&
              point.y <= Math.max(from.y, to.y) + room,
            `(${point.x}, ${point.y}) left the expanded bounding box`,
          );
        }
      }
    });

    it('bows to the side the coin flip picks', () => {
      const to = {x: 900, y: 100};
      // The draws in order: the stride, the curvature, the side, then a gap
      // per point.
      const left = pathBetween(fixedRandom([0.5, 0.5, 0.2, 0.5]), to);
      const right = pathBetween(fixedRandom([0.5, 0.5, 0.8, 0.5]), to);

      const sideOf = (point: {x: number; y: number}): number =>
        Math.sign(
          (to.x - from.x) * (point.y - from.y) -
            (to.y - from.y) * (point.x - from.x),
        );

      assert.strictEqual(left.points.length, right.points.length);
      for (let index = 0; index < left.points.length; index++) {
        assert.strictEqual(sideOf(left.points[index]), -1);
        assert.strictEqual(sideOf(right.points[index]), 1);
      }
    });

    it('strides furthest in the middle', () => {
      const {points} = pathBetween(fixedRandom([0.5]), {x: 1_100, y: 100});
      const middle = Math.floor((points.length - 1) / 2);

      assert.ok(strideAt(points, middle) > strideAt(points, 0));
      assert.ok(strideAt(points, middle) > strideAt(points, points.length - 2));
    });

    it('draws every gap from the shared shape', () => {
      for (const seed of [21, 22, 23]) {
        const {points, durationMs} = pathBetween(seededRandom(seed), {
          x: 800,
          y: 700,
        });
        let total = 0;
        for (const point of points) {
          assert.ok(
            point.gapMs >= POINTER_STEP_GAP_MIN_MS &&
              point.gapMs <= POINTER_STEP_GAP_MAX_MS,
            `${point.gapMs} outside ${POINTER_STEP_GAP_MIN_MS}..${POINTER_STEP_GAP_MAX_MS}`,
          );
          total += point.gapMs;
        }
        assert.strictEqual(durationMs, total);
        assert.ok(durationMs <= POINTER_PATH_MAX_MS);
      }
    });

    it('is not travelled at all at full speed', () => {
      const restore = selectPace(true);
      try {
        assert.strictEqual(travelsPointer(), false);
        const path = drawPointerPath(from, {x: 800, y: 800});
        assert.strictEqual(path.durationMs, 0);
        for (const point of path.points) {
          assert.strictEqual(point.gapMs, 0);
        }
      } finally {
        restore();
      }
      assert.strictEqual(travelsPointer(), true);
      assert.deepStrictEqual(PACE_FULL.pointerStepGapMs, [0, 0]);
      assert.deepStrictEqual(PACE_HUMAN.pointerStepGapMs, [
        POINTER_STEP_GAP_MIN_MS,
        POINTER_STEP_GAP_MAX_MS,
      ]);
    });
  });

  describe('the unknown pointer start', () => {
    it('lands on the perimeter of the viewport', () => {
      const width = 1_280;
      const height = 800;
      let onEachEdge = 0;
      const seen = new Set<string>();

      for (let i = 0; i < 4_000; i++) {
        const {x, y} = drawViewportEdgePoint(width, height);
        assert.ok(x >= 0 && x <= width && y >= 0 && y <= height);
        const edges = [x === 0, x === width, y === 0, y === height].filter(
          Boolean,
        ).length;
        assert.ok(edges >= 1, `(${x}, ${y}) is not on an edge`);
        seen.add(`${x === 0}${x === width}${y === 0}${y === height}`);
      }
      onEachEdge = seen.size;
      assert.ok(onEachEdge >= 4, 'not every edge was drawn from');
    });
  });
});
