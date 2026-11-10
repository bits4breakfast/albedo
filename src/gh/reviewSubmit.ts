/**
 * Submit Review (#287, step 3): the drafts for GitHub on a review task, sent
 * as ONE pull request review, from the user's click and nothing else.
 *
 *   1. One REST `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with the
 *      summary, the event (Comment / Approve / Request Changes), the commit
 *      that was reviewed, and `comments[]` -- one per draft on a line inside
 *      the PR's diff (`path`, `line`, `side`, and `start_line` for a range).
 *      A draft on a line GitHub would refuse (not in the diff) goes into the
 *      review's body with its `path:line`, as the issue decided, rather than
 *      failing the whole review.
 *   2. Then each reply to someone else's thread, through REST
 *      `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`. The REST
 *      review takes no replies, so they follow it, in the same click.
 *
 * Nothing is marked sent until GitHub said yes to it: the review's drafts all
 * at once when the review is created, each reply as it lands. A failure stops
 * there and keeps every draft not yet accepted, so pressing Submit again sends
 * exactly what is left and never posts anything twice.
 *
 * The review's body is a JSON file in ~/.albedo/reviews, handed to
 * `gh api --input`: gh's `-f`/`-F` flags cannot build an array of objects
 * reliably (measured on gh 2.97: raw and typed fields are grouped apart, so a
 * typed `line` lands on the wrong comment), and the Tauri shell cannot close
 * a child's stdin. The file holds only what the user wrote, and is emptied
 * after the request, whether it succeeded or not. Emptied, not deleted:
 * Albedo has no fs remove permission, and granting one would allow deletes
 * across its whole fs scope, worktrees included (inbox.ts and hookEvents.ts
 * empty their files the same way). Replies are one string each, sent with `-f` (raw: a body
 * starting with `@` is never read as a file).
 *
 * The planning half is pure and tested; `submitReview` takes its gh runner
 * and file writer as arguments.
 */

import type { PrRef } from '../git/reviewCheckout';
import type { GhResult } from './gh';

export type ReviewVerdict = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request Changes',
};

/** A draft for GitHub, as the submit needs it (from a comments row). */
export interface GithubDraft {
  id: number;
  /** Worktree-relative: the repo-relative path GitHub names the file by. */
  path: string;
  /** 1-based, inclusive, on the reviewed commit (where the draft is now). */
  lineStart: number;
  lineEnd: number;
  body: string;
  /** A reply: the REST id of the thread's first comment. Null: a new line comment. */
  replyTo: number | null;
  /** Its code is no longer in the file: it goes in the summary, at the line it was on. */
  lost?: boolean;
}

/** path -> the new-side line ranges of the PR's diff hunks, inclusive. */
export type DiffRanges = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

/**
 * The hunks of `git diff -U3 <merge-base> <head>`, new side: the lines GitHub
 * lets a review comment on (its diff uses three lines of context too). A
 * deleted file has no new side and no entry.
 */
export function parseDiffRanges(diff: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let path: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t.*$/, '');
      path = name === '/dev/null' ? null : name.replace(/^b\//, '');
      continue;
    }
    if (path === null || !line.startsWith('@@ ')) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue; // a pure deletion: nothing on the new side
    const ranges = out.get(path) ?? [];
    ranges.push([start, start + count - 1]);
    out.set(path, ranges);
  }
  return out;
}

/** Whether GitHub takes a line comment on `from..to` of `path`: both ends in one hunk. */
export function inDiff(ranges: DiffRanges, path: string, from: number, to: number): boolean {
  return (ranges.get(path) ?? []).some(([lo, hi]) => from >= lo && to <= hi && from <= to);
}

export interface ReviewLineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  event: ReviewVerdict;
  body: string;
  comments: ReviewLineComment[];
}

export interface ReviewPlan {
  /** The one review request, or null when there is nothing for it (only replies, as a Comment). */
  review: ReviewPayload | null;
  /** The drafts the review carries (as line comments or in its body): marked sent with it. */
  inReview: number[];
  /** Of those, the ones written into the body because their lines are not in the diff. */
  outside: GithubDraft[];
  replies: GithubDraft[];
}

function where(d: Pick<GithubDraft, 'path' | 'lineStart' | 'lineEnd'>): string {
  return d.lineStart === d.lineEnd ? `${d.path}:${d.lineStart}` : `${d.path}:${d.lineStart}-${d.lineEnd}`;
}

/**
 * The review's body: the summary, then each draft whose lines are outside
 * the diff under its `path:line`, quoted so its own markdown stays its own.
 */
export function reviewBody(summary: string, outside: readonly GithubDraft[]): string {
  const head = summary.trim();
  if (outside.length === 0) return head;
  const items = outside.map((d) => `\`${where(d)}\`${d.lost ? ' (this code has changed since)' : ''}\n${d.body.trim().split('\n').map((l) => `> ${l}`).join('\n')}`);
  return [head, `**On lines outside the diff:**\n\n${items.join('\n\n')}`].filter((p) => p !== '').join('\n\n');
}

/** Why the dialog may not send yet, in its words; null when it may. */
export function cannotSubmit(drafts: readonly GithubDraft[], summary: string, verdict: ReviewVerdict): string | null {
  // GitHub requires a body for Request Changes, and a Comment review needs
  // something to say: a body or a line comment.
  if (verdict === 'REQUEST_CHANGES' && summary.trim() === '') return 'Request Changes needs a summary.';
  if (verdict === 'COMMENT' && summary.trim() === '' && drafts.length === 0) return 'Nothing to send: write a summary or a comment.';
  return null;
}

export function planReview(input: {
  drafts: readonly GithubDraft[];
  ranges: DiffRanges;
  summary: string;
  verdict: ReviewVerdict;
  commitId: string;
}): ReviewPlan {
  const replies = input.drafts.filter((d) => d.replyTo !== null);
  const lines = input.drafts.filter((d) => d.replyTo === null);
  const comments: ReviewLineComment[] = [];
  const outside: GithubDraft[] = [];
  for (const d of lines) {
    if (d.lost || !inDiff(input.ranges, d.path, d.lineStart, d.lineEnd)) {
      outside.push(d);
      continue;
    }
    const c: ReviewLineComment = { path: d.path, line: d.lineEnd, side: 'RIGHT', body: d.body.trim() };
    if (d.lineStart < d.lineEnd) {
      c.start_line = d.lineStart;
      c.start_side = 'RIGHT';
    }
    comments.push(c);
  }
  const body = reviewBody(input.summary, outside);
  // Only replies, as a plain Comment with no summary: no review at all, or
  // GitHub would refuse an empty one.
  const empty = comments.length === 0 && body === '' && input.verdict === 'COMMENT';
  return {
    review: empty ? null : { commit_id: input.commitId, event: input.verdict, body, comments },
    inReview: lines.map((d) => d.id),
    outside,
    replies,
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SubmitFailure =
  /** GitHub refused a line: the diff it has differs from the one measured here. */
  | 'line'
  /** The commit reviewed is no longer part of the PR (force-pushed). */
  | 'head'
  /** You already have a pending review on this PR, started on GitHub. */
  | 'pending'
  | 'other';

export type SubmitOutcome =
  | { ok: true; replies: number }
  | {
      ok: false;
      /** Whether the review itself went out; when it did, only replies are left. */
      reviewSent: boolean;
      repliesSent: number;
      kind: SubmitFailure;
      message: string;
    };

export function classifySubmitError(text: string): SubmitFailure {
  if (/one pending review/i.test(text)) return 'pending';
  if (/commit_id|No commit found|is not part of the pull request/i.test(text)) return 'head';
  if (/line could not be resolved|pull_request_review_thread\.(line|start_line|diff_hunk)|must be part of the diff/i.test(text)) return 'line';
  return 'other';
}

/** What the dialog says for a failure, after gh's own words. */
export function failureAdvice(kind: SubmitFailure): string {
  switch (kind) {
    case 'line':
      return 'GitHub would not place a comment on its line: the pull request may have changed since this copy was checked out.';
    case 'head':
      return 'The commit you reviewed is no longer part of the pull request (it was force-pushed). Your drafts are kept here; GitHub takes them once this copy is on the new head.';
    case 'pending':
      return 'You have a review in progress on GitHub for this pull request. Submit or discard it there, then submit again here.';
    case 'other':
      return 'Nothing was lost: your drafts are kept, and Submit sends what is left.';
  }
}

export interface SubmitIo {
  gh(args: string[]): Promise<GhResult | null>;
  /** Write the review's JSON where gh can read it; returns its absolute path. */
  writeInput(json: string): Promise<string>;
  /** Done with it, sent or not: nothing of the review stays on disk. */
  clearInput(path: string): Promise<void>;
  /** The drafts GitHub accepted: stored as sent before the next request. */
  markSent(ids: readonly number[]): Promise<void>;
}

function repoPath(pr: PrRef): string {
  return `repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
}

function hostArgs(pr: PrRef): string[] {
  return pr.host === 'github.com' ? [] : ['--hostname', pr.host];
}

function ghText(r: GhResult): string {
  // eslint-disable-next-line no-control-regex
  const text = `${r.stderr}\n${r.stdout}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return text || `gh exited with ${r.code ?? 'a signal'}.`;
}

/**
 * Send a plan: the review, then the replies. Never throws; never marks a
 * draft sent that GitHub did not accept.
 */
export async function submitReview(pr: PrRef, plan: ReviewPlan, io: SubmitIo): Promise<SubmitOutcome> {
  const fail = (reviewSent: boolean, repliesSent: number, text: string): SubmitOutcome => ({
    ok: false,
    reviewSent,
    repliesSent,
    kind: classifySubmitError(text),
    message: text,
  });

  let reviewSent = plan.review === null;
  if (plan.review !== null) {
    let file: string;
    try {
      file = await io.writeInput(JSON.stringify(plan.review));
    } catch (e) {
      return fail(false, 0, `Could not prepare the review: ${e instanceof Error ? e.message : String(e)}`);
    }
    let r: GhResult | null;
    try {
      r = await io.gh(['api', ...hostArgs(pr), '-X', 'POST', `${repoPath(pr)}/reviews`, '--input', file]);
    } finally {
      await io.clearInput(file).catch((err: unknown) => console.warn('[review] could not empty the request file', err));
    }
    if (!r) return fail(false, 0, 'GitHub CLI (gh) could not be run.');
    if (r.code !== 0) return fail(false, 0, ghText(r));
    reviewSent = true;
    try {
      await io.markSent(plan.inReview);
    } catch (e) {
      // Posted, but not recorded: say so, or Submit would post them twice.
      return {
        ok: false,
        reviewSent: true,
        repliesSent: 0,
        kind: 'other',
        message: `The review was posted, but its drafts could not be marked as sent (${e instanceof Error ? e.message : String(e)}). Delete them before submitting again.`,
      };
    }
  }

  let sent = 0;
  for (const d of plan.replies) {
    const r = await io.gh([
      'api',
      ...hostArgs(pr),
      '-X',
      'POST',
      `${repoPath(pr)}/comments/${d.replyTo}/replies`,
      '-f',
      `body=${d.body.trim()}`,
    ]);
    if (!r) return fail(reviewSent, sent, 'GitHub CLI (gh) could not be run.');
    if (r.code !== 0) return fail(reviewSent, sent, ghText(r));
    try {
      await io.markSent([d.id]);
    } catch (e) {
      return {
        ok: false,
        reviewSent,
        repliesSent: sent + 1,
        kind: 'other',
        message: `A reply was posted, but could not be marked as sent (${e instanceof Error ? e.message : String(e)}). Delete it before submitting again.`,
      };
    }
    sent += 1;
  }
  return { ok: true, replies: sent };
}
