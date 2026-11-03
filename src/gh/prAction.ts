/**
 * The one action the task bar offers for a PR (#236), and the mark a task
 * row wears for it. Pure: a `PrStatus` in, a decision out, so every
 * combination is pinned by a test.
 *
 * At most one action, and only when it applies:
 *
 *   1. **Conflicts** -- GitHub reports the head conflicts with the base, on an
 *      open PR, draft or not, approved or not. It outranks everything: a
 *      conflicting PR cannot be merged whatever else is true.
 *   2. **Merge** -- open (not a draft), approved, the checks passing or none,
 *      and GitHub says the merge state is clean (or clean with hooks).
 *   3. **Blocked** -- approved, but GitHub will not merge it yet: a reason in
 *      words instead of a button. Albedo never merges with `--admin`.
 *
 * GitHub computes `mergeable` lazily: `unknown` means "still computing" and
 * shows nothing, never a guess either way.
 */

import type { PrStatus } from './prStatus';

export type PrAction =
  | { kind: 'conflicts' }
  | { kind: 'merge' }
  | { kind: 'blocked'; reason: string };

/** Does GitHub say this open PR conflicts with its base? */
export function hasConflicts(pr: PrStatus | null | undefined): boolean {
  if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) return false;
  // DIRTY is GitHub's merge state for "the merge commit cannot be cleanly
  // created": conflicts, even on an answer whose `mergeable` lags behind.
  return pr.mergeable === 'conflicting' || pr.mergeState === 'dirty';
}

const BLOCKED_REASON: Partial<Record<NonNullable<PrStatus['mergeState']>, string>> = {
  blocked: 'Can’t merge yet: a branch rule blocks it',
  behind: 'Can’t merge yet: the base has moved on',
};

/** The task bar's action for this PR, or null for none. */
export function prAction(pr: PrStatus | null | undefined): PrAction | null {
  if (!pr) return null;
  if (hasConflicts(pr)) return { kind: 'conflicts' };
  if (pr.state !== 'open' || pr.review !== 'approved') return null;
  const state = pr.mergeState ?? 'unknown';
  // Still computing, or a draft by GitHub's own account: say nothing.
  if (pr.mergeable === 'unknown' || pr.mergeable === undefined || state === 'unknown' || state === 'draft') return null;
  if (pr.checks.kind === 'failing') return { kind: 'blocked', reason: 'Can’t merge yet: checks failing' };
  if (pr.checks.kind === 'pending') return { kind: 'blocked', reason: 'Can’t merge yet: checks still running' };
  if (state === 'clean' || state === 'has-hooks') return { kind: 'merge' };
  // UNSTABLE: mergeable, but a commit status is not passing. The summary
  // above says passing (or none), so it is one the rollup does not show.
  if (state === 'unstable') return { kind: 'blocked', reason: 'Can’t merge yet: checks failing' };
  return { kind: 'blocked', reason: BLOCKED_REASON[state] ?? 'Can’t merge yet' };
}
