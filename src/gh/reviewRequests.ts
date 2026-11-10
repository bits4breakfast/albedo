/**
 * The PRs waiting on your review in one project's repo (#287): what the
 * Reviewing tab lists. One `gh api graphql` request answers the whole list --
 * two searches in one query -- so watching every PR you are asked to review
 * costs the same as watching one.
 *
 *   requested  open PRs whose review is requested from you, directly or
 *              through a team you are on (`review-requested:@me` covers both)
 *   reviewed   open PRs you have reviewed and are not asked to review again:
 *              waiting on their author, until something happens on them
 *
 * `{owner}/{repo}` is gh's own placeholder, filled from the folder's remote as
 * `gh pr view` resolves it. It works inside an -F value, so the repo needs no
 * second call to name it. Measured on a live repo: `rateLimit { cost }` 3 for
 * this query at these page sizes, with or without what #315 added (a
 * review's `state`, `viewerLatestReview`, `latestOpinionatedReviews`).
 *
 * Like gh.ts, nothing here throws at its callers: no gh, logged out, offline,
 * a folder with no GitHub remote -- each is null, "cannot tell".
 */

import { gh } from './gh';

export const REVIEWS_QUERY = `query Reviews($requested: String!, $reviewed: String!) {
  viewer { login }
  requested: search(query: $requested, type: ISSUE, first: 30) { nodes { ...ReviewPr } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 20) { nodes { ...ReviewPr } }
}
fragment ReviewPr on PullRequest {
  number title url isDraft createdAt updatedAt additions deletions headRefOid baseRefName
  author { login }
  commits(last: 1) { totalCount nodes { commit { committedDate } } }
  comments(last: 10) { nodes { author { login } createdAt } }
  reviews(last: 10) { nodes { author { login } submittedAt state } }
  viewerLatestReview { submittedAt state }
  latestOpinionatedReviews(first: 10, writersOnly: true) { nodes { author { login } state } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  timelineItems(last: 10, itemTypes: [REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) { nodes {
    __typename
    ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
    ... on HeadRefForcePushedEvent { createdAt }
  } }
}`;

/** The two searches, scoped to the folder's repo by gh's placeholder. */
export const REQUESTED_SEARCH = 'is:pr is:open archived:false review-requested:@me repo:{owner}/{repo}';
export const REVIEWED_SEARCH =
  'is:pr is:open archived:false reviewed-by:@me -review-requested:@me -author:@me repo:{owner}/{repo}';

export type ReviewSection = 'requested' | 'reviewed';

/** A comment or a submitted review: who, and when. */
export interface ReviewEvent {
  author: string | null;
  at: number;
}

export interface ReviewPr {
  url: string;
  number: number;
  title: string;
  isDraft: boolean;
  author: string | null;
  additions: number;
  deletions: number;
  headOid: string;
  /** The branch it merges into: what a review task is measured against. */
  baseBranch: string;
  commitCount: number;
  /** The head commit's date; null when GitHub did not give one. */
  lastCommitAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** When your review was last asked for (you, or a team of yours); null when the timeline did not say. */
  requestedAt: number | null;
  /** Asked through a team, by slug. Empty when you were asked by name. */
  teams: string[];
  /** The newest conversation comments and submitted reviews, oldest first. */
  talk: ReviewEvent[];
  /** The latest force-push, or null. */
  forcePushedAt: number | null;
  /**
   * Your latest submitted review among the newest ten (#315): when, and its
   * state as GitHub says it (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`,
   * `DISMISSED`). Null when none of them is yours.
   */
  yourReview: { at: number; state: string } | null;
  /**
   * Your standing opinion on the PR is an approval (#315): GitHub's latest
   * opinionated review of yours (approve or request changes; a later
   * comment-only review does not replace it) is APPROVED. The owner's rule,
   * matching GitHub's own "approved by".
   */
  approved: boolean;
  section: ReviewSection;
}

export interface ReviewRequests {
  /** The signed-in login, as the same request reported it. */
  viewer: string | null;
  prs: ReviewPr[];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nodesOf(v: unknown): unknown[] {
  const n = obj(v)?.nodes;
  return Array.isArray(n) ? n : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function time(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function login(v: unknown): string | null {
  return str(obj(v)?.login);
}

/** A requested reviewer as `user:<login>` or `team:<slug>`; null for anything else (a bot, a deleted account). */
function reviewerKey(v: unknown): string | null {
  const r = obj(v);
  if (r?.__typename === 'User' && str(r.login)) return `user:${str(r.login)}`;
  if (r?.__typename === 'Team' && str(r.slug)) return `team:${str(r.slug)}`;
  return null;
}

function prOf(raw: unknown, section: ReviewSection, viewer: string | null): ReviewPr | null {
  const n = obj(raw);
  if (!n) return null;
  const url = str(n.url);
  const number = n.number;
  const title = str(n.title);
  const createdAt = time(n.createdAt);
  // A search node that is not a PR (an issue) comes back as {}: not one.
  if (!url || typeof number !== 'number' || !title || createdAt === null) return null;

  const requested = nodesOf(n.reviewRequests)
    .map((r) => reviewerKey(obj(r)?.requestedReviewer))
    .filter((k): k is string => k !== null);
  const direct = viewer !== null && requested.includes(`user:${viewer}`);
  const teams = direct ? [] : requested.filter((k) => k.startsWith('team:')).map((k) => k.slice(5));
  // The keys a request event must name to be a request of YOU.
  const mine = new Set(direct ? [`user:${viewer}`] : teams.map((t) => `team:${t}`));

  let requestedAt: number | null = null;
  let forcePushedAt: number | null = null;
  for (const raw of nodesOf(n.timelineItems)) {
    const e = obj(raw);
    const at = time(e?.createdAt);
    if (!e || at === null) continue;
    if (e.__typename === 'HeadRefForcePushedEvent') forcePushedAt = Math.max(forcePushedAt ?? at, at);
    if (e.__typename === 'ReviewRequestedEvent') {
      const key = reviewerKey(e.requestedReviewer);
      if (key && mine.has(key)) requestedAt = Math.max(requestedAt ?? at, at);
    }
  }

  const talk: ReviewEvent[] = [];
  for (const c of nodesOf(n.comments)) {
    const at = time(obj(c)?.createdAt);
    if (at !== null) talk.push({ author: login(obj(c)?.author), at });
  }
  let yourReview: ReviewPr['yourReview'] = null;
  for (const r of nodesOf(n.reviews)) {
    // A pending review (yours, unsubmitted) has no submittedAt: not activity.
    const at = time(obj(r)?.submittedAt);
    if (at === null) continue;
    const author = login(obj(r)?.author);
    talk.push({ author, at });
    if (viewer !== null && author === viewer && (yourReview === null || at >= yourReview.at)) {
      yourReview = { at, state: str(obj(r)?.state) ?? '' };
    }
  }
  // GitHub's own answer, whatever the last ten reviews hold. A pending review
  // may come back here with no submittedAt: then the last ten have to do.
  const latest = obj(n.viewerLatestReview);
  const latestAt = time(latest?.submittedAt);
  if (latestAt !== null && (yourReview === null || latestAt >= yourReview.at)) {
    yourReview = { at: latestAt, state: str(latest?.state) ?? '' };
  }
  const approved =
    viewer !== null &&
    nodesOf(n.latestOpinionatedReviews).some((r) => login(obj(r)?.author) === viewer && obj(r)?.state === 'APPROVED');
  talk.sort((a, b) => a.at - b.at);

  const commits = obj(n.commits);
  return {
    url,
    number,
    title,
    isDraft: n.isDraft === true,
    author: login(n.author),
    additions: num(n.additions),
    deletions: num(n.deletions),
    headOid: str(n.headRefOid) ?? '',
    baseBranch: str(n.baseRefName) ?? '',
    commitCount: num(commits?.totalCount),
    lastCommitAt: time(obj(obj(nodesOf(commits)[0])?.commit)?.committedDate),
    createdAt,
    updatedAt: time(n.updatedAt) ?? createdAt,
    requestedAt,
    teams,
    talk,
    forcePushedAt,
    yourReview,
    approved,
    section,
  };
}

/**
 * {@link REVIEWS_QUERY}'s answer as a list, requested first. Null for an
 * answer that is not one (an error, a GraphQL error with no data), so the
 * caller can tell "nothing to review" from "could not ask".
 */
export function parseReviewRequests(stdout: string): ReviewRequests | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const d = obj(obj(data)?.data);
  if (!d || !obj(d.requested) || !obj(d.reviewed)) return null;
  const viewer = login(d.viewer);
  const seen = new Set<string>();
  const prs: ReviewPr[] = [];
  for (const section of ['requested', 'reviewed'] as const) {
    for (const raw of nodesOf(d[section])) {
      const pr = prOf(raw, section, viewer);
      if (!pr || seen.has(pr.url)) continue;
      seen.add(pr.url);
      prs.push(pr);
    }
  }
  return { viewer, prs };
}

/**
 * Ask GitHub for the folder's review list. Null when gh is missing, not
 * signed in, offline, or the folder has no GitHub remote.
 */
export async function fetchReviewRequests(repoPath: string): Promise<ReviewRequests | null> {
  const r = await gh(
    [
      'api',
      'graphql',
      '-F',
      `requested=${REQUESTED_SEARCH}`,
      '-F',
      `reviewed=${REVIEWED_SEARCH}`,
      '-f',
      `query=${REVIEWS_QUERY}`,
    ],
    repoPath,
  );
  if (!r || r.code !== 0) return null;
  return parseReviewRequests(r.stdout);
}
