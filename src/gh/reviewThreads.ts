/**
 * Other reviewers' threads on a pull request open as a review task (#287,
 * step 4): read only, shown at their lines in the Guide and the Diff, with a
 * reply going out as a draft on Submit Review (reviewSubmit.ts).
 *
 * One `gh api graphql` request per PR, made when a view of the review task
 * opens and then again only after the Reviewing list's own poll has run and
 * the last answer is at least {@link THREADS_MIN_AGE_MS} old: never more often
 * than that list's one request a minute. A failed fetch keeps the last
 * answer; a PR that never answered has no threads to show, and says so
 * nowhere -- they are an ornament on the review, as the PR badge is.
 *
 * Placing a thread: GitHub's `line` is on the PR's head as GitHub has it,
 * which may not be the commit checked out here. So a thread carries its line
 * of code (the last line of its first comment's `diffHunk`) and is found by
 * that text, as Albedo's own comments are (`relocate`), near its line.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { PrRef } from '../git/reviewCheckout';
import { gh } from './gh';
import { subscribeReviews } from './reviewStore';

export const THREADS_QUERY = `query Threads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes {
      id isResolved isOutdated path line startLine originalLine diffSide
      comments(first: 50) { nodes { databaseId author { login } body createdAt diffHunk } }
    } }
  } }
}`;

export interface ThreadComment {
  author: string | null;
  body: string;
  createdAt: number;
}

export interface ReviewThread {
  id: string;
  path: string;
  /** On GitHub's head; null when GitHub has it outdated. */
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  isResolved: boolean;
  isOutdated: boolean;
  /** The REST id of the first comment: what a reply is posted to. */
  replyTo: number;
  /** The commented line's code, for finding it in the file here; null when not known. */
  anchor: string | null;
  comments: ThreadComment[];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nodesOf(v: unknown): unknown[] {
  const n = obj(v)?.nodes;
  return Array.isArray(n) ? n : [];
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/** The last line of a diff hunk, without its +/space marker; null for a removed line or none. */
export function anchorOfHunk(hunk: unknown): string | null {
  if (typeof hunk !== 'string' || hunk === '') return null;
  // `\ No newline at end of file` follows the line it is about: skip it.
  const lines = hunk
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .filter((l) => !l.startsWith('\\'));
  const last = lines[lines.length - 1] ?? '';
  if (last === '' || last.startsWith('@@') || last.startsWith('-')) return null;
  return last.slice(1);
}

export function parseThreads(stdout: string): ReviewThread[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const pull = obj(obj(obj(obj(data)?.data)?.repository)?.pullRequest);
  if (!pull) return null;
  const out: ReviewThread[] = [];
  for (const raw of nodesOf(pull.reviewThreads)) {
    const t = obj(raw);
    if (!t || typeof t.id !== 'string' || typeof t.path !== 'string' || t.path === '') continue;
    const comments = nodesOf(t.comments).map(obj).filter((c): c is Record<string, unknown> => c !== null);
    const first = comments[0];
    const replyTo = int(first?.databaseId);
    if (!first || replyTo === null) continue;
    const side = t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT';
    out.push({
      id: t.id,
      path: t.path,
      line: int(t.line),
      startLine: int(t.startLine),
      originalLine: int(t.originalLine),
      side,
      isResolved: t.isResolved === true,
      isOutdated: t.isOutdated === true,
      replyTo,
      anchor: side === 'RIGHT' ? anchorOfHunk(first.diffHunk) : null,
      comments: comments.map((c) => {
        const at = typeof c.createdAt === 'string' ? Date.parse(c.createdAt) : NaN;
        return {
          author: typeof obj(c.author)?.login === 'string' ? (obj(c.author)!.login as string) : null,
          body: typeof c.body === 'string' ? c.body : '',
          createdAt: Number.isFinite(at) ? at : 0,
        };
      }),
    });
  }
  return out;
}

export async function fetchThreads(pr: PrRef, cwd: string): Promise<ReviewThread[] | null> {
  const r = await gh(
    [
      'api',
      'graphql',
      ...(pr.host === 'github.com' ? [] : ['--hostname', pr.host]),
      '-f',
      `owner=${pr.owner}`,
      '-f',
      `repo=${pr.repo}`,
      '-F',
      `number=${pr.number}`,
      '-f',
      `query=${THREADS_QUERY}`,
    ],
    cwd,
  );
  if (!r || r.code !== 0) return null;
  return parseThreads(r.stdout);
}

/**
 * Where a RIGHT-side thread is in `text` (the file checked out here): the
 * line holding its code nearest GitHub's line. Null when it is not on this
 * version's lines -- outdated, on a removed line, or its code is gone -- and
 * then it is listed in the bar above the file, never pinned to a guess.
 */
export function placeThread(t: ReviewThread, text: string): number | null {
  // Without its code there is nothing to find it by: GitHub's line is on
  // GitHub's head, which may not be this copy, so it goes to the bar.
  if (t.side !== 'RIGHT' || t.isOutdated || t.line === null || t.anchor === null) return null;
  const lines = text.split(/\r?\n/);
  let best: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== t.anchor) continue;
    const n = i + 1;
    if (best === null || Math.abs(n - t.line) < Math.abs(best - t.line)) best = n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The store: one entry per PR url
// ---------------------------------------------------------------------------

/** Never asked again sooner than the Reviewing list's poll. */
export const THREADS_MIN_AGE_MS = 60_000;

interface Entry {
  threads: ReviewThread[] | null;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
let fetcher: (pr: PrRef, cwd: string) => Promise<ReviewThread[] | null> = fetchThreads;
let now: () => number = () => Date.now();

function emit(): void {
  version += 1;
  for (const l of [...listeners]) l();
}

/** @internal Test seam. */
export function setThreadsFetcherForTests(next: typeof fetcher, clock?: () => number): void {
  fetcher = next;
  if (clock) now = clock;
  cache.clear();
  inflight.clear();
}

export function threadsFor(url: string): readonly ReviewThread[] {
  return cache.get(url)?.threads ?? NONE;
}

const NONE: readonly ReviewThread[] = [];

/**
 * Fetch one PR's threads, unless the last answer is younger than
 * {@link THREADS_MIN_AGE_MS}. `force` is for right after Submit Review, so
 * what was just posted appears as the thread it now is. Never rejects.
 */
export function refreshThreads(url: string, pr: PrRef, cwd: string, opts: { force?: boolean } = {}): Promise<void> {
  const already = inflight.get(url);
  // Forced (right after Submit Review): a fetch already going may have
  // left before the post landed, so a fresh one follows it.
  if (already) return opts.force ? already.then(() => refreshThreads(url, pr, cwd, opts)) : already;
  const prev = cache.get(url);
  if (prev && !opts.force && now() - prev.fetchedAt < THREADS_MIN_AGE_MS) return Promise.resolve();
  const p = fetcher(pr, cwd)
    .then((threads) => {
      cache.set(url, { threads: threads ?? prev?.threads ?? null, fetchedAt: now() });
      emit();
    })
    .catch((err: unknown) => console.warn('[gh] review threads failed', err))
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/**
 * A review task's threads, kept current while a view of it is open: fetched
 * on open, and after each run of the Reviewing list's poll or its Refresh,
 * at most once a minute.
 */
export function useReviewThreads(url: string | null, pr: PrRef | null, cwd: string | null): readonly ReviewThread[] {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  useEffect(() => {
    if (!url || !pr || !cwd) return;
    const run = () => void refreshThreads(url, pr, cwd);
    run();
    return subscribeReviews(run);
    // The PR's parts are its url's; the url decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, cwd]);
  return url ? threadsFor(url) : NONE;
}
