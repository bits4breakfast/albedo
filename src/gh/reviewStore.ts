/**
 * The Reviewing tab's data (#287): one project's review list, polled, and
 * what you have seen of each PR.
 *
 * One request a minute per project shown, whatever the number of PRs
 * (reviewRequests.ts), only while the window is visible, and again when it
 * comes back. A failed or impossible fetch keeps the last list: a flicker to
 * "nothing to review" would be a lie. A project that never answered is
 * `unavailable`, and the tab says so instead of claiming an empty list.
 *
 * The seen marks are a per-machine convenience in localStorage
 * (`albedo.reviews.seen`), keyed by PR url: losing them only means the dots
 * come back.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { fetchReviewRequests, type ReviewPr, type ReviewRequests } from './reviewRequests';
import type { SeenMark } from './reviewActivity';
import { KEYS, readPersisted, writePersisted, type Codec } from '../ui/persisted';

export const REVIEW_POLL_MS = 60_000;
/** Focus churn: a burst of focus events is one fetch. */
export const REVIEW_MIN_AGE_MS = 15_000;

export type ReviewListState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; list: ReviewRequests };

interface Entry {
  list: ReviewRequests | null;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

let fetcher: (repoPath: string) => Promise<ReviewRequests | null> = fetchReviewRequests;
let now: () => number = () => Date.now();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

export function subscribeReviews(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** @internal Test seam: swap the fetch and the clock; clears the cache and the marks read. */
export function setReviewFetcherForTests(
  next: (repoPath: string) => Promise<ReviewRequests | null>,
  clock?: () => number,
): void {
  fetcher = next;
  if (clock) now = clock;
  cache.clear();
  inflight.clear();
  queued.clear();
  marks = null;
}

export function reviewListState(repoPath: string): ReviewListState {
  const e = cache.get(repoPath);
  if (!e) return { kind: 'loading' };
  return e.list ? { kind: 'ready', list: e.list } : { kind: 'unavailable' };
}

const queued = new Map<string, Promise<void>>();

/**
 * Refresh one project's list. Never rejects. A forced refresh while a fetch
 * is in flight is one more fetch after it (#315): the one in flight may have
 * been asked before what the caller just did (a submitted review), so its
 * answer cannot stand for it. Several such calls share that one fetch.
 */
export function refreshReviews(repoPath: string, opts: { force?: boolean } = {}): Promise<void> {
  const already = inflight.get(repoPath);
  if (already && opts.force) {
    const next = queued.get(repoPath);
    if (next) return next;
    const after = already.then(() => {
      queued.delete(repoPath);
      return refreshReviews(repoPath, { force: true });
    });
    queued.set(repoPath, after);
    return after;
  }
  if (already) return already;
  const prev = cache.get(repoPath);
  if (prev && !opts.force && now() - prev.fetchedAt < REVIEW_MIN_AGE_MS) return Promise.resolve();
  const p = fetcher(repoPath)
    .then((list) => {
      // Keep the last good list over a failure; a first failure is "unavailable".
      cache.set(repoPath, { list: list ?? prev?.list ?? null, fetchedAt: now() });
      emit();
    })
    .catch((err) => {
      console.warn('[gh] review list failed', err);
    })
    .finally(() => {
      inflight.delete(repoPath);
    });
  inflight.set(repoPath, p);
  return p;
}

/**
 * One project's review list, polled while mounted (every
 * {@link REVIEW_POLL_MS}, skipped while the window is hidden, and on focus).
 * Null `repoPath` (no project) is `unavailable`.
 */
export function useReviewList(repoPath: string | null): ReviewListState {
  useReviewsVersion();
  useEffect(() => {
    if (!repoPath) return;
    const run = () => {
      if (!document.hidden) void refreshReviews(repoPath);
    };
    run();
    const timer = window.setInterval(run, REVIEW_POLL_MS);
    window.addEventListener('focus', run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
    };
  }, [repoPath]);
  return repoPath ? reviewListState(repoPath) : { kind: 'unavailable' };
}

// --- seen marks -------------------------------------------------------------

/** The newest marks kept; a PR you have not opened in this many is long closed. */
export const MAX_MARKS = 300;

const marksCodec: Codec<Map<string, SeenMark>> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = new Map<string, SeenMark>();
    for (const [url, v] of Object.entries(parsed as Record<string, unknown>)) {
      const m = v as Partial<SeenMark> | null;
      if (m && typeof m.at === 'number' && typeof m.head === 'string' && typeof m.commits === 'number') {
        out.set(url, { at: m.at, head: m.head, commits: m.commits });
      }
    }
    return out;
  },
  encode: (value) => {
    const newest = [...value].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_MARKS);
    return JSON.stringify(Object.fromEntries(newest));
  },
};

let marks: Map<string, SeenMark> | null = null;

function loadMarks(): Map<string, SeenMark> {
  if (!marks) marks = readPersisted(KEYS.reviewSeen, marksCodec, new Map<string, SeenMark>());
  return marks;
}

export function seenMarks(): ReadonlyMap<string, SeenMark> {
  return loadMarks();
}

/** You looked at `pr` now: its activity so far is no longer news. */
export function markSeen(pr: ReviewPr): void {
  const next = new Map(loadMarks());
  next.set(pr.url, { at: now(), head: pr.headOid, commits: pr.commitCount });
  marks = next;
  writePersisted(KEYS.reviewSeen, marksCodec, next);
  emit();
}

/** Re-render on any change to the lists or the marks. */
export function useReviewsVersion(): number {
  return useSyncExternalStore(subscribeReviews, () => version);
}
