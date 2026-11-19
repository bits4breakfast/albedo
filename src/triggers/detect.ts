/**
 * Which PR answers are a trigger's event (#448). Pure: the trigger watch
 * (`useTriggers.ts`) hands each answer the PR store already fetched here, with
 * what was remembered about the task, and gets back what to remember now and
 * which events happened. No `gh` call of its own, no new polling loop.
 *
 * The rule the PR notices follow: a transition is an event, a level is not.
 * Unlike them, what is remembered is kept across a restart (`store.ts`), so a
 * PR merged while Albedo was closed still fires once on the next launch, and
 * an event already seen never fires again:
 *
 *   merged     the PR was last seen open or draft, and is merged now.
 *   ciFailed   the head commit's checks fail, and a failing check is one not
 *              seen failing on that commit before: a new commit's failure, or
 *              a check joining. A rerun failing the same check again is not new.
 *   review     on an open PR, a change request by someone else not seen
 *              before, or more review threads than were seen (a new inline
 *              comment). Replies inside a thread do not change the count, so
 *              they are not seen here.
 *   approved   the PR became ready to merge -- approved, checks green, no
 *              conflicts: exactly when the task bar offers Squash and Merge…
 *              (`prAction`) -- on a head commit not seen ready before.
 *
 * The first answer for a task, or for a new PR on its branch, is history:
 * remembered, never fired. So turning a trigger on never fires for what
 * already happened, and the watch runs whether or not any trigger is on.
 */

import type { PrState, PrStatus } from '../gh/prStatus';
import { headKey } from '../gh/ciTransition';
import { reviewKey } from '../gh/reviewTransition';
import { prAction } from '../gh/prAction';
import { failingChecks, type FailedCheck } from '../ui/transcript/ciFailure';

/** What is remembered about one task's PR. */
export interface TriggerWatch {
  /** The PR the rest is about. Another number starts over. */
  pr: number;
  state: PrState;
  /** The head commit, and the checks already seen failing on it. */
  ciSha: string;
  ciFailed: string[];
  /** Every review already seen (`reviewKey`). */
  reviews: string[];
  /** Review threads last seen; null while GitHub has not said. */
  threads: number | null;
  /** When review activity was last taken in: a thread comment after it is new. */
  reviewSince: number;
  /** The head commit last seen ready to merge, or null. */
  ready: string | null;
}

interface FireBase {
  prNumber: number;
  prTitle: string;
  prUrl: string;
}

export type TriggerFire =
  | (FireBase & { event: 'merged'; mergeCommit: string | null })
  | (FireBase & { event: 'ciFailed'; sha: string; checks: FailedCheck[] })
  | (FireBase & { event: 'review'; changesBy: string[]; newThreads: number; since: number })
  | (FireBase & { event: 'approved'; sha: string; approvers: string[]; checks: number });

export interface TriggerStep {
  watch: TriggerWatch | undefined;
  fires: TriggerFire[];
}

const live = (pr: PrStatus) => pr.state === 'open' || pr.state === 'draft';

/** Ready to merge as the task bar sees it: Squash and Merge… is offered. */
export function readyToMerge(pr: PrStatus): boolean {
  return prAction(pr)?.kind === 'merge';
}

function baseline(pr: PrStatus, now: number): TriggerWatch {
  return {
    pr: pr.number,
    state: pr.state,
    ciSha: headKey(pr),
    ciFailed: pr.checks.kind === 'failing' ? failingChecks(pr).map((c) => c.name) : [],
    reviews: (pr.reviews ?? []).map(reviewKey),
    threads: pr.reviewThreads?.total ?? null,
    reviewSince: now,
    ready: readyToMerge(pr) ? headKey(pr) : null,
  };
}

/**
 * One answer from `gh`, against what was remembered. `pr` null ("no PR, or gh
 * could not say") teaches nothing. `viewer` is the signed-in login, null while
 * unknown: until it is known a review cannot be told from your own, so review
 * activity waits, unseen, rather than being taken in or fired.
 */
export function triggerStep(prev: TriggerWatch | undefined, pr: PrStatus | null, viewer: string | null, now: number): TriggerStep {
  if (pr === null) return { watch: prev, fires: [] };
  if (!prev || prev.pr !== pr.number) return { watch: baseline(pr, now), fires: [] };

  const base: FireBase = { prNumber: pr.number, prTitle: pr.title, prUrl: pr.url };
  const fires: TriggerFire[] = [];
  const next: TriggerWatch = { ...prev, state: pr.state };

  if (pr.state === 'merged' && (prev.state === 'open' || prev.state === 'draft')) {
    fires.push({ ...base, event: 'merged', mergeCommit: pr.mergeCommit ?? null });
  }

  if (live(pr)) {
    // CI: what is failing on this commit that was not seen failing on it.
    const sha = headKey(pr);
    const known = prev.ciSha === sha ? prev.ciFailed : [];
    if (pr.checks.kind === 'failing') {
      const checks = failingChecks(pr);
      const fresh = checks.filter((c) => !known.includes(c.name));
      if (fresh.length > 0) fires.push({ ...base, event: 'ciFailed', sha, checks });
      next.ciSha = sha;
      next.ciFailed = [...new Set([...known, ...checks.map((c) => c.name)])];
    } else {
      next.ciSha = sha;
      next.ciFailed = known;
    }

    // Review: only once "you" are known, and only announced on an open PR. On
    // a draft it is taken in, so marking the draft ready fires nothing old.
    if (viewer !== null) {
      const me = viewer.toLowerCase();
      const reviews = pr.reviews ?? [];
      const seen = new Set(prev.reviews);
      const changesBy = [
        ...new Set(
          reviews
            .filter((r) => r.state === 'changes-requested' && !seen.has(reviewKey(r)) && r.author.toLowerCase() !== me)
            .map((r) => r.author),
        ),
      ];
      const total = pr.reviewThreads?.total ?? null;
      const newThreads = total !== null && prev.threads !== null && total > prev.threads ? total - prev.threads : 0;
      next.reviews = [...new Set([...prev.reviews, ...reviews.map(reviewKey)])];
      if (total !== null) next.threads = total;
      if (pr.state === 'open' && (changesBy.length > 0 || newThreads > 0)) {
        fires.push({ ...base, event: 'review', changesBy, newThreads, since: prev.reviewSince });
        next.reviewSince = now;
      } else if (pr.state !== 'open') {
        next.reviewSince = now;
      }
    }

    // Ready to merge, once per head commit.
    if (readyToMerge(pr)) {
      if (prev.ready !== sha) {
        const approvers = (pr.reviews ?? []).filter((r) => r.state === 'approved').map((r) => r.author);
        fires.push({ ...base, event: 'approved', sha, approvers, checks: pr.checks.kind === 'passing' ? pr.checks.total : 0 });
      }
      next.ready = sha;
    }
  }

  return { watch: next, fires };
}

/** Whether two watches say the same, so an unchanged answer writes nothing. */
export function sameWatch(a: TriggerWatch | undefined, b: TriggerWatch | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

