/**
 * "Your PR's checks just finished" -- which PR answers are that event.
 *
 * Pure: the PR store (`prStore.ts`) hands each answer here with what this run
 * remembered about the task, and gets back what to remember now and whether
 * an event happened. `ui/ciNotice.ts` turns the event into a banner, a Dock
 * bounce or a row mark.
 *
 * The rule is the one `attentionFor` and `mergeNoticeFor` apply: a transition
 * is an event, a level is not.
 *
 *   - Only pending -> final, on one head commit, is an event. A result that
 *     was already final the first time this run saw the commit is history:
 *     a launch must not open with a banner per PR that went green last week.
 *   - "Final" is the badge's own reading (`summarizeChecks`): one failing job
 *     is the answer, even while others still run. That is when the owner can
 *     stop watching, and it is what the badge already says.
 *   - Each outcome fires at most once per head commit. A failing job rerun to
 *     green is pending -> passing on the same commit, a different outcome, so
 *     it fires once more; a second "failing" for the same commit never does.
 *   - A new head commit (a push) starts over.
 *   - A PR closed or merged meanwhile says nothing: its checks stopped
 *     mattering, and the merge has a notice of its own (`mergeNotice.ts`).
 *
 * Kept in memory only, like the PR store itself. After a restart a check that
 * was pending before and is final now is "already final when first seen" and
 * says nothing; a duplicate is impossible, a miss across a restart is the
 * price, and it is the cheaper one than state that is wrong on every launch.
 */

import type { PrStatus } from './prStatus';

export type CiOutcome = 'pass' | 'fail';

/** What this run remembers about one task's checks. */
export interface CiWatch {
  /** The head commit the rest is about. */
  sha: string;
  /** Whether the checks on `sha` were last seen running. */
  pending: boolean;
  /** Outcomes already announced for `sha`. */
  announced: readonly CiOutcome[];
}

export interface CiEvent {
  outcome: CiOutcome;
  sha: string;
  prNumber: number;
  /** The first failing job, for a failure. */
  job?: string;
  /** Its reason when not a plain failure: "cancelled", "timed out", ... */
  reason?: string;
  /** How many jobs failed, for a failure; how many passed, for a pass. */
  count: number;
}

export interface CiStep {
  watch: CiWatch | undefined;
  event: CiEvent | null;
}

const live = (pr: PrStatus) => pr.state === 'open' || pr.state === 'draft';

/**
 * One answer from `gh`, against what was remembered.
 *
 * `pr` null is "no PR, or gh could not say": nothing is learned from it, so
 * what was remembered is kept -- a gh that drops out while checks run and
 * comes back after they finished still owes the owner the result.
 */
export function ciStep(prev: CiWatch | undefined, pr: PrStatus | null): CiStep {
  if (pr === null) return { watch: prev, event: null };
  const pending = pr.checks.kind === 'pending';
  // A commit gh did not name still has to be told apart from the next one:
  // the PR number stands in, which at worst merges two pushes into one.
  const sha = pr.headSha || `#${pr.number}`;
  if (!prev || prev.sha !== sha) {
    // First sight of this commit: whatever it shows is a level, not an event.
    return { watch: { sha, pending: live(pr) && pending, announced: [] }, event: null };
  }
  if (!live(pr)) return { watch: { ...prev, pending: false }, event: null };
  if (pending) return { watch: { ...prev, pending: true }, event: null };

  const outcome: CiOutcome | null =
    pr.checks.kind === 'passing' ? 'pass' : pr.checks.kind === 'failing' ? 'fail' : null;
  const next: CiWatch = { ...prev, pending: false };
  if (!prev.pending || outcome === null || prev.announced.includes(outcome)) return { watch: next, event: null };

  next.announced = [...prev.announced, outcome];
  const event: CiEvent = { outcome, sha, prNumber: pr.number, count: 0 };
  if (pr.checks.kind === 'failing') {
    event.count = pr.checks.failing;
    const first = pr.lines.find((l) => l.bucket === 'fail');
    if (first) {
      event.job = first.name;
      if (first.reason) event.reason = first.reason;
    }
  } else if (pr.checks.kind === 'passing') {
    event.count = pr.checks.total;
  }
  return { watch: next, event };
}

/** The banner's words, as the issue (#159) asked for them. */
export function ciBanner(event: CiEvent, taskTitle: string | null, taskId: number): { title: string; body: string } {
  const name = taskTitle && taskTitle.trim() ? taskTitle.trim() : `Task ${taskId}`;
  if (event.outcome === 'pass') {
    return {
      title: `✓ Checks passed: ${name} (#${event.prNumber})`,
      body: event.count === 1 ? 'The check passed.' : `All ${event.count} checks passed.`,
    };
  }
  const job = event.job ? `${event.job}${event.reason ? ` (${event.reason})` : ''}` : 'A check failed';
  const more = event.count > 1 ? ` and ${event.count - 1} more` : '';
  return { title: `✗ Checks failed: ${name} (#${event.prNumber})`, body: `${job}${more}` };
}
