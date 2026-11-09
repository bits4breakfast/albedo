/**
 * What is new on a PR you review, since you last looked (#287), and the
 * Reviewing tab's order. Pure: the list, what you saw and when, in; sections
 * out.
 *
 * "Since you last looked" is the later of two moments:
 *   - the last time you opened the PR from Albedo (a {@link SeenMark}), and
 *   - your own latest comment or review on it, wherever you wrote it.
 * A PR with neither has no "since": it was never looked at, so nothing on it
 * is news. It is simply requested, and sorts by when you were asked.
 *
 * Activity is new commits (or a force-push), new comments and reviews by
 * anyone but you, and your review being asked for again.
 */

import type { ReviewPr } from './reviewRequests';

/** What you saw when you last opened a PR: when, its head, its commit count. */
export interface SeenMark {
  at: number;
  head: string;
  commits: number;
}

export interface ReviewActivity {
  /** Anything new since you last looked. */
  unseen: boolean;
  /** When the newest of it happened; 0 when nothing is new. */
  at: number;
  /** New commits: a count when it is known, null for "some", 0 for none. */
  newCommits: number | null;
  forcePushed: boolean;
  newComments: number;
  reRequested: boolean;
}

const NOTHING: ReviewActivity = {
  unseen: false,
  at: 0,
  newCommits: 0,
  forcePushed: false,
  newComments: 0,
  reRequested: false,
};

/** When you last looked at `pr`, or null for never. */
export function lastLooked(pr: ReviewPr, mark: SeenMark | undefined, viewer: string | null): number | null {
  let at = mark?.at ?? null;
  if (viewer) {
    for (const e of pr.talk) if (e.author === viewer && (at === null || e.at > at)) at = e.at;
  }
  return at;
}

export function activityOf(pr: ReviewPr, mark: SeenMark | undefined, viewer: string | null): ReviewActivity {
  const since = lastLooked(pr, mark, viewer);
  if (since === null) return NOTHING;
  const times: number[] = [];

  const forcePushed = pr.forcePushedAt !== null && pr.forcePushedAt > since;
  if (forcePushed) times.push(pr.forcePushedAt as number);

  let newCommits: number | null = 0;
  // A mark knows the head you saw, so commits are counted exactly. Without
  // one (you only commented on GitHub), the head commit's date has to do.
  const headMoved = mark ? pr.headOid !== '' && pr.headOid !== mark.head : pr.lastCommitAt !== null && pr.lastCommitAt > since;
  if (headMoved) {
    const count = mark ? pr.commitCount - mark.commits : null;
    // A force-push can leave fewer commits than before: then it is said as
    // a force-push, not as "−2 new commits".
    newCommits = count === null ? null : count > 0 ? count : forcePushed ? 0 : null;
    times.push(pr.lastCommitAt ?? pr.updatedAt);
  }

  const news = pr.talk.filter((e) => e.at > since && e.author !== viewer);
  for (const e of news) times.push(e.at);

  const reRequested = pr.requestedAt !== null && pr.requestedAt > since;
  if (reRequested) times.push(pr.requestedAt as number);

  const unseen = forcePushed || newCommits !== 0 || news.length > 0 || reRequested;
  if (!unseen) return NOTHING;
  return {
    unseen,
    at: Math.max(...times),
    newCommits,
    forcePushed,
    newComments: news.length,
    reRequested,
  };
}

/** The activity in words, in the row's order: "2 new commits", "3 new comments", "re-requested". */
export function activityWords(a: ReviewActivity): string[] {
  const out: string[] = [];
  if (a.newCommits === null) out.push('new commits');
  else if (a.newCommits > 0) out.push(`${a.newCommits} new commit${a.newCommits === 1 ? '' : 's'}`);
  if (a.forcePushed) out.push('force-pushed');
  if (a.newComments > 0) out.push(`${a.newComments} new comment${a.newComments === 1 ? '' : 's'}`);
  if (a.reRequested) out.push('re-requested');
  return out;
}

export type ReviewGroupKey = 'activity' | 'requested' | 'reviewed';

export const REVIEW_GROUP_TITLE: Record<ReviewGroupKey, string> = {
  activity: 'New Activity',
  requested: 'Requested',
  reviewed: 'Reviewed · Waiting on Author',
};

export interface ReviewRow {
  pr: ReviewPr;
  activity: ReviewActivity;
  /** The time the row sorts by and shows as its age. */
  at: number;
}

export interface ReviewGroup {
  key: ReviewGroupKey;
  rows: ReviewRow[];
}

/**
 * The Reviewing tab's groups, in order, empty ones left out:
 *   New Activity  anything new since you last looked; newest activity first
 *   Requested     the rest of what you are asked to review; newest request first
 *   Reviewed      reviewed, nothing new; most recently updated first
 */
export function reviewGroups(
  prs: readonly ReviewPr[],
  marks: ReadonlyMap<string, SeenMark>,
  viewer: string | null,
): ReviewGroup[] {
  const groups: Record<ReviewGroupKey, ReviewRow[]> = { activity: [], requested: [], reviewed: [] };
  for (const pr of prs) {
    const activity = activityOf(pr, marks.get(pr.url), viewer);
    if (activity.unseen) groups.activity.push({ pr, activity, at: activity.at });
    else if (pr.section === 'requested') groups.requested.push({ pr, activity, at: pr.requestedAt ?? pr.createdAt });
    else groups.reviewed.push({ pr, activity, at: pr.updatedAt });
  }
  const order: ReviewGroupKey[] = ['activity', 'requested', 'reviewed'];
  return order
    .map((key) => ({ key, rows: groups[key].sort((a, b) => b.at - a.at || b.pr.number - a.pr.number) }))
    .filter((g) => g.rows.length > 0);
}

/**
 * The tab's count: what is waiting on you -- every PR you are asked to
 * review, plus reviewed ones with something new.
 */
export function waitingCount(groups: readonly ReviewGroup[]): number {
  return groups.reduce(
    (n, g) => n + g.rows.filter((r) => r.pr.section === 'requested' || r.activity.unseen).length,
    0,
  );
}
