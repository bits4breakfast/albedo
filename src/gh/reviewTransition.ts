/**
 * "A review just landed on your PR" -- which PR answers are that event (#180).
 *
 * Pure, like `ciTransition.ts`: the PR store hands each answer here with what
 * this run remembered, and gets back what to remember now and whether a review
 * landed. `ui/reviewNotice.ts` turns the event into a banner, a Dock bounce or
 * a row mark.
 *
 * The rule is the one the checks follow: a transition is an event, a level is
 * not.
 *
 *   - A review is one reviewer's approval or change request at one moment
 *     (author, state, submittedAt). `latestReviews` holds each reviewer's
 *     newest, so a second approval after a push is a new review, and the same
 *     one seen on the next poll is not.
 *   - Whatever reviews the PR has the first time this run sees it are
 *     history: a launch must not open with a banner per PR approved last week.
 *   - Only an open PR announces. A review on a draft is remembered, so it does
 *     not fire later when the draft is marked ready.
 *   - A review by the signed-in user is theirs: they know.
 *   - Several in one answer are one event: a change request outranks an
 *     approval, and every reviewer of that kind is named.
 *
 * In memory only, like the PR store. A review that lands across a restart is
 * missed, never announced twice.
 */

import { reviewerNames, type PrReview, type PrStatus } from './prStatus';

export type ReviewOutcome = 'approved' | 'changes-requested';

/** What this run remembers about one task's PR reviews. */
export interface ReviewWatch {
  /** The PR the rest is about. Another number starts over. */
  prNumber: number;
  /** Every review already seen, by {@link reviewKey}. */
  seen: ReadonlySet<string>;
}

export interface ReviewEvent {
  outcome: ReviewOutcome;
  prNumber: number;
  /** Who, in the order GitHub lists them. Never empty. */
  reviewers: string[];
}

export interface ReviewStep {
  watch: ReviewWatch | undefined;
  event: ReviewEvent | null;
}

export function reviewKey(r: PrReview): string {
  return `${r.author.toLowerCase()}|${r.state}|${r.submittedAt}`;
}

/**
 * One answer from `gh`, against what was remembered. `pr` null ("no PR, or gh
 * could not say") teaches nothing, so what was remembered is kept. `viewer`
 * is the signed-in login, null when unknown.
 */
export function reviewStep(prev: ReviewWatch | undefined, pr: PrStatus | null, viewer: string | null): ReviewStep {
  if (pr === null) return { watch: prev, event: null };
  const reviews = pr.reviews ?? [];
  const seen = new Set(reviews.map(reviewKey));
  if (!prev || prev.prNumber !== pr.number) return { watch: { prNumber: pr.number, seen }, event: null };
  // Keep what was seen before as well: a review that drops out of
  // `latestReviews` and comes back (dismissed, then restored) is not new.
  for (const k of prev.seen) seen.add(k);
  const watch: ReviewWatch = { prNumber: pr.number, seen };
  if (pr.state !== 'open') return { watch, event: null };
  const me = viewer?.toLowerCase() ?? null;
  const fresh = reviews.filter((r) => !prev.seen.has(reviewKey(r)) && r.author.toLowerCase() !== me);
  if (!fresh.length) return { watch, event: null };
  const outcome: ReviewOutcome = fresh.some((r) => r.state === 'changes-requested') ? 'changes-requested' : 'approved';
  const reviewers = [...new Set(fresh.filter((r) => r.state === outcome).map((r) => r.author))];
  return { watch, event: { outcome, prNumber: pr.number, reviewers } };
}

/** The banner's words: the task leads, as every banner's does; then who said what. */
export function reviewBanner(
  event: ReviewEvent,
  taskTitle: string | null,
  taskId: number,
): { title: string; body: string } {
  const name = taskTitle && taskTitle.trim() ? taskTitle.trim() : `Task ${taskId}`;
  const who = reviewerNames(event.reviewers);
  return {
    title: name,
    body:
      event.outcome === 'approved'
        ? `PR #${event.prNumber} approved by ${who}`
        : `PR #${event.prNumber}: changes requested by ${who}`,
  };
}
