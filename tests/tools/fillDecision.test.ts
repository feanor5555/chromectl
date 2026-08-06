/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {FillDecision} from '../../src/tools/fillDecision.js';
import {fillDecisionNote} from '../../src/tools/fillDecision.js';

describe('what a fill reports', () => {
  it('says nothing of its own when the element took the value', () => {
    assert.strictEqual(fillDecisionNote('typed'), undefined);
    assert.strictEqual(fillDecisionNote('one-shot'), undefined);
  });

  it('speaks up for every decision that wrote nothing', () => {
    const silent: FillDecision[] = [
      'toggle-already-set',
      'already-equal',
      'already-equal-rendered',
      'option-without-value',
    ];

    for (const decision of silent) {
      const note = fillDecisionNote(decision);
      assert.ok(note, `${decision} has to be reported`);
      assert.match(note, /not (typed|clicked|set)|nothing was/);
    }
  });

  it('names the rendered text as the basis for an editable element', () => {
    const note = fillDecisionNote('already-equal-rendered');

    assert.match(note ?? '', /rendered text/);
    assert.match(note ?? '', /collapsed whitespace|trailing line break/);
    // A native field is compared on its value, so it must not claim otherwise.
    assert.doesNotMatch(fillDecisionNote('already-equal') ?? '', /rendered/);
  });
});
