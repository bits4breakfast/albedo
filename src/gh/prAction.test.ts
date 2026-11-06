import { describe, expect, it } from 'vitest';
import { hasConflicts, prAction } from './prAction';
import { parsePrView, type PrStatus } from './prStatus';

/** A PR as `gh pr view --json` gives it, with what each case changes. */
function pr(o: {
  state?: string;
  isDraft?: boolean;
  decision?: string;
  mergeable?: string;
  mergeState?: string;
  checks?: 'pass' | 'fail' | 'pending' | 'none';
}): PrStatus {
  const check = (conclusion: string | null, status = 'COMPLETED') => ({
    __typename: 'CheckRun', name: 'test', status, conclusion, startedAt: '2026-11-03T10:00:00Z',
  });
  const rollup =
    o.checks === 'none' ? [] : o.checks === 'fail' ? [check('FAILURE')] : o.checks === 'pending' ? [check(null, 'IN_PROGRESS')] : [check('SUCCESS')];
  return parsePrView(
    JSON.stringify({
      number: 21,
      state: o.state ?? 'OPEN',
      isDraft: o.isDraft ?? false,
      headRefName: 'feat',
      baseRefName: 'main',
      reviewDecision: o.decision ?? 'APPROVED',
      statusCheckRollup: rollup,
      ...(o.mergeable === undefined ? {} : { mergeable: o.mergeable }),
      ...(o.mergeState === undefined ? {} : { mergeStateStatus: o.mergeState }),
    }),
  )!;
}

const green = { mergeable: 'MERGEABLE', mergeState: 'CLEAN' };

describe('prAction (#236)', () => {
  it('Merge: open, approved, checks passing, clean', () => {
    expect(prAction(pr(green))).toEqual({ kind: 'merge' });
    expect(prAction(pr({ ...green, checks: 'none' }))).toEqual({ kind: 'merge' });
    expect(prAction(pr({ ...green, mergeState: 'HAS_HOOKS' }))).toEqual({ kind: 'merge' });
  });

  it('Conflicts outranks everything, approved or not, draft or not', () => {
    const c = { mergeable: 'CONFLICTING', mergeState: 'DIRTY' };
    expect(prAction(pr(c))).toEqual({ kind: 'conflicts' });
    expect(prAction(pr({ ...c, decision: 'REVIEW_REQUIRED' }))).toEqual({ kind: 'conflicts' });
    expect(prAction(pr({ ...c, decision: 'CHANGES_REQUESTED', checks: 'fail' }))).toEqual({ kind: 'conflicts' });
    expect(prAction(pr({ ...c, isDraft: true }))).toEqual({ kind: 'conflicts' });
    // DIRTY alone is conflicts too, while `mergeable` lags behind.
    expect(prAction(pr({ mergeable: 'UNKNOWN', mergeState: 'DIRTY' }))).toEqual({ kind: 'conflicts' });
  });

  it('nothing once merged or closed, even if the last answer said conflicting', () => {
    expect(prAction(pr({ ...green, state: 'MERGED' }))).toBeNull();
    expect(prAction(pr({ mergeable: 'CONFLICTING', state: 'CLOSED' }))).toBeNull();
    expect(hasConflicts(pr({ mergeable: 'CONFLICTING', state: 'MERGED' }))).toBe(false);
  });

  it('nothing for a draft, or a PR not approved', () => {
    expect(prAction(pr({ ...green, isDraft: true }))).toBeNull();
    expect(prAction(pr({ ...green, mergeState: 'DRAFT' }))).toBeNull();
    expect(prAction(pr({ ...green, decision: 'REVIEW_REQUIRED' }))).toBeNull();
    expect(prAction(pr({ ...green, decision: 'CHANGES_REQUESTED' }))).toBeNull();
    expect(prAction(pr({ ...green, decision: '' }))).toBeNull();
  });

  it('unknown is never guessed: GitHub still computing, or gh did not say', () => {
    expect(prAction(pr({ mergeable: 'UNKNOWN', mergeState: 'CLEAN' }))).toBeNull();
    expect(prAction(pr({ mergeable: 'MERGEABLE', mergeState: 'UNKNOWN' }))).toBeNull();
    expect(prAction(pr({}))).toBeNull();
    expect(hasConflicts(pr({}))).toBe(false);
    expect(prAction(null)).toBeNull();
    expect(prAction(undefined)).toBeNull();
  });

  it('approved but not mergeable yet: the reason, in words', () => {
    expect(prAction(pr({ ...green, mergeState: 'BLOCKED' }))).toEqual({
      kind: 'blocked',
      reason: 'Can’t merge yet: a branch rule blocks it',
    });
    expect(prAction(pr({ ...green, mergeState: 'BEHIND' }))).toEqual({
      kind: 'blocked',
      reason: 'Can’t merge yet: the base has moved on',
    });
    expect(prAction(pr({ ...green, checks: 'pending', mergeState: 'BLOCKED' }))).toEqual({
      kind: 'blocked',
      reason: 'Can’t merge yet: checks still running',
    });
    expect(prAction(pr({ ...green, checks: 'fail', mergeState: 'UNSTABLE' }))).toEqual({
      kind: 'blocked',
      reason: 'Can’t merge yet: checks failing',
    });
    // A status the rollup does not show is still failing to GitHub.
    expect(prAction(pr({ ...green, mergeState: 'UNSTABLE' }))).toEqual({
      kind: 'blocked',
      reason: 'Can’t merge yet: checks failing',
    });
  });

  it('a hand-built status without the fields says nothing', () => {
    const p = pr(green);
    const { mergeable: _m, mergeState: _s, ...bare } = p;
    expect(prAction(bare as PrStatus)).toBeNull();
    expect(hasConflicts(bare as PrStatus)).toBe(false);
  });
});
