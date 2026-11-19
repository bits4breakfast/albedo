/**
 * Which PR answers are a trigger's event (#448): a transition is an event, a
 * level is not; each event once; and what was seen survives a restart (the
 * watch goes through the store's codec, as it does on disk).
 */

import { describe, expect, it } from 'vitest';
import { triggerStep, type TriggerWatch } from './detect';
import { triggersCodec } from './store';
import { MERGE_SHA, SHA_A, SHA_B, approvedBy, changesBy, fail, pass, pending, prOf, readyPr } from './fixtures';
import type { PrStatus } from '../gh/prStatus';

const ME = 'me';

/** Feed answers in order; return every fire's event and the last watch. */
function run(answers: Array<PrStatus | null>, viewer: string | null = ME, start?: TriggerWatch) {
  let watch = start;
  const fired: string[] = [];
  let t = 1_000;
  for (const pr of answers) {
    const step = triggerStep(watch, pr, viewer, (t += 1_000));
    watch = step.watch;
    fired.push(...step.fires.map((f) => f.event));
  }
  return { fired, watch };
}

/** As a restart reads it back. */
function restart(w: TriggerWatch | undefined): TriggerWatch | undefined {
  const raw = triggersCodec.encode(new Map([[1, { watch: w, cards: [] }]]));
  return raw ? triggersCodec.decode(raw)?.get(1)?.watch : undefined;
}

describe('the first answer is history', () => {
  it('remembers whatever the PR shows, and fires nothing', () => {
    for (const pr of [prOf({ state: 'merged' }), prOf({ lines: [fail('build')] }), readyPr(), prOf({ reviews: [changesBy('bob')], threads: 3 })]) {
      expect(run([pr]).fired).toEqual([]);
    }
  });

  it('a new PR on the branch starts over', () => {
    expect(run([prOf({ number: 1 }), prOf({ number: 2, state: 'merged' })]).fired).toEqual([]);
  });

  it('no PR, or gh could not say, teaches nothing', () => {
    const { watch } = run([prOf()]);
    expect(triggerStep(watch, null, ME, 9).watch).toBe(watch);
  });
});

describe('merged', () => {
  it('open, then merged: fires once, with the merge commit', () => {
    const a = triggerStep(undefined, prOf(), ME, 1);
    const b = triggerStep(a.watch, prOf({ state: 'merged' }), ME, 2);
    expect(b.fires).toEqual([
      { event: 'merged', prNumber: 412, prTitle: 'Send the confirmation once per order', prUrl: 'https://github.com/example/shop/pull/412', mergeCommit: MERGE_SHA },
    ]);
    expect(triggerStep(b.watch, prOf({ state: 'merged' }), ME, 3).fires).toEqual([]);
  });

  it('from a draft too; never from closed', () => {
    expect(run([prOf({ state: 'draft' }), prOf({ state: 'merged' })]).fired).toEqual(['merged']);
    expect(run([prOf({ state: 'closed' }), prOf({ state: 'merged' })]).fired).toEqual([]);
  });

  it('merged while Albedo was closed: fires once on the next launch, and never again', () => {
    const before = restart(run([prOf()]).watch);
    const after = run([prOf({ state: 'merged' })], ME, before);
    expect(after.fired).toEqual(['merged']);
    expect(run([prOf({ state: 'merged' })], ME, restart(after.watch)).fired).toEqual([]);
  });
});

describe('CI failed', () => {
  it('running, then failing: fires with every failing check', () => {
    const a = triggerStep(undefined, prOf({ lines: [pending('build'), pending('test')] }), ME, 1);
    const b = triggerStep(a.watch, prOf({ lines: [fail('build'), pass('test')] }), ME, 2);
    expect(b.fires).toMatchObject([{ event: 'ciFailed', sha: SHA_A, checks: [{ name: 'build', conclusion: 'failed' }] }]);
  });

  it('a rerun failing the same check on the same commit is not new', () => {
    expect(
      run([prOf({ lines: [pending('build')] }), prOf({ lines: [fail('build')] }), prOf({ lines: [pending('build')] }), prOf({ lines: [fail('build')] })]).fired,
    ).toEqual(['ciFailed']);
  });

  it('a check joining the failure on the same commit fires again, for what is new', () => {
    const { fired } = run([prOf({ lines: [pass('build'), pass('test')] }), prOf({ lines: [fail('build'), pending('test')] }), prOf({ lines: [fail('build'), fail('test')] })]);
    expect(fired).toEqual(['ciFailed', 'ciFailed']);
  });

  it('a new commit failing fires again, even when it is already failing at first sight', () => {
    expect(run([prOf({ lines: [fail('build')] }), prOf({ sha: SHA_B, lines: [fail('build')] })]).fired).toEqual(['ciFailed']);
  });

  it('already failing when first seen, and across a restart: never fired', () => {
    const w = restart(run([prOf({ lines: [fail('build')] })]).watch);
    expect(run([prOf({ lines: [fail('build')] })], ME, w).fired).toEqual([]);
  });

  it('a merged or closed PR’s checks say nothing', () => {
    expect(run([prOf({ lines: [pending('build')] }), prOf({ state: 'closed', lines: [fail('build')] })]).fired).toEqual([]);
  });
});

describe('review', () => {
  it('a change request by someone else fires; your own never does', () => {
    expect(run([prOf(), prOf({ reviews: [changesBy('bob')] })]).fired).toEqual(['review']);
    expect(run([prOf(), prOf({ reviews: [changesBy(ME)] })]).fired).toEqual([]);
  });

  it('the same review on the next poll is not new; a second one later is', () => {
    expect(
      run([prOf(), prOf({ reviews: [changesBy('bob')] }), prOf({ reviews: [changesBy('bob')] }), prOf({ reviews: [changesBy('bob', '2026-11-19T12:00:00Z')] })]).fired,
    ).toEqual(['review', 'review']);
  });

  it('more threads fire, with how many and since when; fewer or the same do not', () => {
    const a = triggerStep(undefined, prOf({ threads: 1 }), ME, 100);
    const b = triggerStep(a.watch, prOf({ threads: 3 }), ME, 200);
    expect(b.fires).toMatchObject([{ event: 'review', newThreads: 2, changesBy: [], since: 100 }]);
    expect(triggerStep(b.watch, prOf({ threads: 3 }), ME, 300).fires).toEqual([]);
    const c = triggerStep(b.watch, prOf({ threads: 2 }), ME, 300);
    expect(c.fires).toEqual([]);
    // The next one is new since the last card, not since the start.
    expect(triggerStep(c.watch, prOf({ threads: 3 }), ME, 400).fires).toMatchObject([{ since: 200 }]);
  });

  it('threads GitHub did not report are unknown, never "none"', () => {
    expect(run([prOf({ threads: 2 }), prOf({ threads: null }), prOf({ threads: 2 })]).fired).toEqual([]);
  });

  it('waits while "you" are not known, then judges what came meanwhile', () => {
    const a = triggerStep(undefined, prOf(), null, 1);
    const b = triggerStep(a.watch, prOf({ reviews: [changesBy('bob')], threads: 1 }), null, 2);
    expect(b.fires).toEqual([]);
    expect(triggerStep(b.watch, prOf({ reviews: [changesBy('bob')], threads: 1 }), ME, 3).fires).toMatchObject([
      { event: 'review', changesBy: ['bob'], newThreads: 1 },
    ]);
  });

  it('on a draft it is taken in, so marking the draft ready fires nothing old', () => {
    expect(run([prOf({ state: 'draft' }), prOf({ state: 'draft', reviews: [changesBy('bob')], threads: 2 }), prOf({ reviews: [changesBy('bob')], threads: 2 })]).fired).toEqual([]);
  });
});

describe('approved with green checks', () => {
  it('fires when Squash and Merge… becomes offered, once per head commit', () => {
    const { fired } = run([prOf({ lines: [pending('build')] }), readyPr(), readyPr(), readyPr({ sha: SHA_B, lines: [pending('build')] }), readyPr({ sha: SHA_B })]);
    expect(fired).toEqual(['approved', 'approved']);
  });

  it('carries who approved and the checks', () => {
    const a = triggerStep(undefined, prOf({ lines: [pending('build')] }), ME, 1);
    expect(triggerStep(a.watch, readyPr({ reviews: [approvedBy('alice'), approvedBy('carol')] }), ME, 2).fires).toMatchObject([
      { event: 'approved', sha: SHA_A, approvers: ['alice', 'carol'], checks: 2 },
    ]);
  });

  it('not while conflicting, failing, still running, a draft, or GitHub is still computing', () => {
    for (const pr of [
      readyPr({ mergeable: 'conflicting', mergeState: 'dirty' }),
      readyPr({ lines: [fail('build')] }),
      readyPr({ lines: [pending('build')] }),
      readyPr({ state: 'draft' }),
      readyPr({ mergeable: 'unknown' }),
      readyPr({ mergeState: 'blocked' }),
    ]) {
      expect(run([prOf({ lines: [pending('build')] }), pr]).fired.filter((e) => e === 'approved')).toEqual([]);
    }
  });

  it('flapping on the same commit (a poll that reads "computing") does not fire twice', () => {
    expect(run([prOf({ lines: [pending('x')] }), readyPr(), readyPr({ mergeable: 'unknown' }), readyPr()]).fired).toEqual(['approved']);
  });
});
