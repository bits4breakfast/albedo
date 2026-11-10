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
 *
 * Review Started and Approved (#315) come after New Activity: a PR with news
 * is there whatever else is true of it.
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

/**
 * How far you are into a PR's review in Albedo (#315), from its review task:
 * the Guide's Reviewed marks and the task's comments. Local facts, never
 * GitHub's.
 */
export interface ReviewStart {
  /**
   * The latest of them: the last Reviewed tick or comment. Null when there is
   * one but its time is not known (a tick from before #315 kept no time).
   */
  at: number | null;
  /** The Guide's groups all Reviewed, of how many; null with no guide. */
  groups: { reviewed: number; total: number } | null;
  /** Drafts for GitHub not yet submitted. */
  drafts: number;
  /** Every other comment on the task: for Claude, or already posted. */
  comments: number;
}

/**
 * Started (#315): there is something to show for it -- a Reviewed mark or a
 * comment -- and you have not submitted a review since. With no submitted
 * review of yours, anything counts; otherwise only what is newer than it.
 */
export function isStarted(pr: ReviewPr, start: ReviewStart | undefined): boolean {
  if (!start) return false;
  if (pr.yourReview === null) return true;
  return start.at !== null && start.at > pr.yourReview.at;
}

/** Started's progress in words, for the row: "2/4 groups", "3 drafts", or the comments when neither says anything. */
export function startWords(s: ReviewStart): string[] {
  const out: string[] = [];
  if (s.groups) out.push(`${s.groups.reviewed}/${s.groups.total} group${s.groups.total === 1 ? '' : 's'}`);
  if (s.drafts > 0) out.push(`${s.drafts} draft${s.drafts === 1 ? '' : 's'}`);
  if (out.length === 0 && s.comments > 0) out.push(`${s.comments} comment${s.comments === 1 ? '' : 's'}`);
  return out;
}

export type ReviewGroupKey = 'activity' | 'started' | 'requested' | 'reviewed' | 'approved';

export const REVIEW_GROUP_TITLE: Record<ReviewGroupKey, string> = {
  activity: 'New Activity',
  started: 'Review Started',
  requested: 'Requested',
  reviewed: 'Reviewed · Waiting on Author',
  approved: 'Approved',
};

/** The owner's order (#315). */
const GROUP_ORDER: readonly ReviewGroupKey[] = ['activity', 'started', 'requested', 'reviewed', 'approved'];

/** The groups that wait on you, and so make the tab's count. */
const WAITING: ReadonlySet<ReviewGroupKey> = new Set(['activity', 'started', 'requested']);

export interface ReviewRow {
  pr: ReviewPr;
  activity: ReviewActivity;
  /** The time the row sorts by and shows as its age. */
  at: number;
  /** Review Started's progress; only on its rows. */
  start?: ReviewStart;
}

export interface ReviewGroup {
  key: ReviewGroupKey;
  rows: ReviewRow[];
}

const NO_STARTS: ReadonlyMap<string, ReviewStart> = new Map();

/**
 * The Reviewing tab's groups, in order, empty ones left out. Each PR goes to
 * the first that takes it:
 *   New Activity    anything new since you last looked; newest activity first
 *   Review Started  begun in Albedo since your last submitted review (#315);
 *                   most recently worked on first
 *   Requested       the rest of what you are asked to review; newest request first
 *   Reviewed        reviewed, nothing new, your latest review not an
 *                   approval; most recently updated first
 *   Approved        your latest review approved it (#315); most recently updated first
 * `starts` is keyed by PR url, and has an entry only for a PR with a review task.
 */
export function reviewGroups(
  prs: readonly ReviewPr[],
  marks: ReadonlyMap<string, SeenMark>,
  viewer: string | null,
  starts: ReadonlyMap<string, ReviewStart> = NO_STARTS,
): ReviewGroup[] {
  const groups: Record<ReviewGroupKey, ReviewRow[]> = { activity: [], started: [], requested: [], reviewed: [], approved: [] };
  for (const pr of prs) {
    const activity = activityOf(pr, marks.get(pr.url), viewer);
    const start = starts.get(pr.url);
    if (activity.unseen) groups.activity.push({ pr, activity, at: activity.at });
    else if (start && isStarted(pr, start)) groups.started.push({ pr, activity, at: start.at ?? pr.updatedAt, start });
    else if (pr.section === 'requested') groups.requested.push({ pr, activity, at: pr.requestedAt ?? pr.createdAt });
    else if (pr.yourReview?.state === 'APPROVED') groups.approved.push({ pr, activity, at: pr.updatedAt });
    else groups.reviewed.push({ pr, activity, at: pr.updatedAt });
  }
  return GROUP_ORDER.map((key) => ({ key, rows: groups[key].sort((a, b) => b.at - a.at || b.pr.number - a.pr.number) })).filter(
    (g) => g.rows.length > 0,
  );
}

/**
 * The tab's count: what is waiting on you -- New Activity, Review Started
 * and Requested (#315). Waiting on Author and Approved wait on someone else.
 */
export function waitingCount(groups: readonly ReviewGroup[]): number {
  return groups.reduce((n, g) => n + (WAITING.has(g.key) ? g.rows.length : 0), 0);
}
