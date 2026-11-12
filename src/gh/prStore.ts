/**
 * In-memory PR status per task, and the schedule that keeps it fresh.
 *
 * Deliberately NOT in SQLite: a PR's checks are stale within minutes, so a
 * persisted copy would be wrong on every launch and right only by accident.
 * The cost of starting cold is one `gh` call per visible task.
 *
 * Three refresh triggers, one rule:
 *   - every {@link POLL_MS} for the tasks on screen -- every
 *     {@link POLL_PENDING_MS} for a PR whose checks are still running, which
 *     is when the answer changes and someone is waiting on it. That one also
 *     holds off screen, in another project tab or with the window hidden
 *     ({@link usePendingPrWatch}): the checks finishing is an event the owner
 *     is told about (#159), wherever the task is. A branch with no PR, or a
 *     merged PR, whose session has written nothing since it was last asked is
 *     asked less often ({@link pollEveryMs}, #365),
 *   - on window focus -- coming back from the browser is exactly when the
 *     owner wants to know whether CI went green,
 *   - on demand, when a task is selected.
 * Whatever the trigger, a task never has more than one `gh` call in flight,
 * and a result younger than {@link MIN_AGE_MS} is reused rather than refetched.
 *
 * Each call is one GraphQL request (gh.ts `fetchPrAnswer`), and it carries the
 * review threads too (#278): the unresolved counts cost no call of their own.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { fetchPrAnswer, loadViewerLogin, PR_FETCH_FAILED, viewerLogin } from './gh';
import type { PrStatus } from './prStatus';

export const POLL_MS = 60_000;
/**
 * A branch with no PR whose session has been quiet since it was last asked
 * (#365). A PR is opened by a session's turn -- which writes to the
 * transcript and so brings the branch back to {@link POLL_MS} -- or from the
 * browser or another terminal, which coming back to Albedo catches on focus.
 * This is the wait for the rest: a PR opened while Albedo stays in front.
 */
export const POLL_NO_PR_QUIET_MS = 5 * 60_000;
/**
 * A merged PR whose session has been quiet since it was last asked (#365).
 * A merge is final; what can still change is a new PR for the same branch,
 * which a session's turn or a focus catches like any other.
 */
export const POLL_MERGED_QUIET_MS = 15 * 60_000;
/** While a PR's checks run: soon enough to see them finish, not a hammering. */
export const POLL_PENDING_MS = 15_000;
/** Focus and selection churn; this keeps a burst of them to one fetch. */
export const MIN_AGE_MS = 15_000;
/** gh is a network round trip each; ten tasks should not be ten at once. */
const MAX_CONCURRENT = 3;
/**
 * The most PR fetches a minute that watching running checks may cost,
 * whatever the number of PRs. Each is one GraphQL request against a budget of
 * 5,000 an hour shared with everything else the owner runs through gh; 40 a
 * minute is 2,400 an hour at worst, under half of it. Up to ten PRs with
 * running checks are each still asked every {@link POLL_PENDING_MS}.
 */
export const PENDING_CALLS_PER_MIN = 40;

/** See usePendingPrWatch. */
const TICK_SLACK_MS = 2_000;

/** How often each of `n` PRs with running checks is asked, within the budget. */
export function pendingIntervalMs(n: number): number {
  return Math.max(POLL_PENDING_MS, Math.ceil((n * 60_000) / PENDING_CALLS_PER_MIN));
}

type PrTask = Pick<Task, 'id' | 'branch' | 'baseBranch' | 'worktreePath' | 'repoPath' | 'status'> &
  Partial<Pick<Task, 'lastActivityAt'>>;

interface Entry {
  /**
   * Null is a real answer: "no PR for this branch" -- or gh could not answer
   * and there was no earlier answer to keep (`failed`, `streak` 0).
   */
  pr: PrStatus | null;
  /** The branch it was fetched for; a different branch makes it stale. */
  branch: string;
  fetchedAt: number;
  /**
   * When that fetch was sent. Session activity after it may not be in the
   * answer: a PR opened while gh was on its way is noticed at the next poll.
   */
  askedAt: number;
  /**
   * The last ask failed (gh offline, rate-limited, logged out...): `pr` is
   * the answer before it, kept rather than read as "none" (#365 review).
   */
  failed: boolean;
  /** How many answers in a row said what `pr` says: none, merged, or a PR not merged. 0: no answer yet. */
  streak: number;
}

type AnswerKind = 'none' | 'merged' | 'other';
function kindOf(pr: PrStatus | null): AnswerKind {
  return pr === null ? 'none' : pr.state === 'merged' ? 'merged' : 'other';
}

/**
 * How long the answer in `e` holds for `task` before the on-screen poll asks
 * again (#365). {@link POLL_MS}, except for a branch with no PR or a merged PR
 * whose session has written nothing since the answer was asked for: those are
 * quiet, and wait {@link POLL_NO_PR_QUIET_MS} or {@link POLL_MERGED_QUIET_MS}.
 * Any session write since then (a turn, a prompt, a `!` command) is what
 * opens a PR from inside Albedo, and puts the branch back on the minute.
 * A task whose activity is not known is never treated as quiet.
 *
 * Only on two answers in a row that say the same (#365 review): GitHub's
 * search can lag a PR opened a moment ago, so one "none" is not enough. And
 * never after a failed ask: that is retried on the minute.
 */
export function pollEveryMs(
  e: Pick<Entry, 'pr' | 'askedAt' | 'failed' | 'streak'>,
  task: Pick<PrTask, 'lastActivityAt'>,
): number {
  if (e.failed || e.streak < 2) return POLL_MS;
  const merged = e.pr !== null && e.pr.state === 'merged';
  if (e.pr !== null && !merged) return POLL_MS;
  if (task.lastActivityAt === undefined) return POLL_MS;
  const quiet = (task.lastActivityAt ?? 0) <= e.askedAt;
  if (!quiet) return POLL_MS;
  return merged ? POLL_MERGED_QUIET_MS : POLL_NO_PR_QUIET_MS;
}

const cache = new Map<number, Entry>();
const inflight = new Map<number, Promise<void>>();
const listeners = new Set<() => void>();

let fetcher: (task: PrTask) => Promise<PrStatus | null | typeof PR_FETCH_FAILED> = fetchPrAnswer;
let now: () => number = () => Date.now();

/** Test seam: swap the fetch and the clock; clears the cache. */
export function setPrFetcherForTests(
  next: (task: PrTask) => Promise<PrStatus | null | typeof PR_FETCH_FAILED>,
  clock?: () => number,
): void {
  fetcher = next;
  if (clock) now = clock;
  cache.clear();
  inflight.clear();
  queue.length = 0;
  running = 0;
}

/** Bumped on every change, so a list can re-render on one subscription. */
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

// --- a tiny concurrency gate ----------------------------------------------

let running = 0;
const queue: Array<() => void> = [];

function gate<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      job()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          queue.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

// --- public API ------------------------------------------------------------

/** The cached answer: a PR, null for "none", undefined for "not asked yet". */
export function getPrStatus(taskId: number): PrStatus | null | undefined {
  return cache.get(taskId)?.pr;
}

export function subscribePrStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Refresh one task. Resolves when the fetch (or the one already running for
 * it) settles. Never rejects: a failed fetch keeps the previous answer.
 */
export function refreshPrStatus(task: PrTask, opts: { force?: boolean } = {}): Promise<void> {
  const already = inflight.get(task.id);
  if (already) return already;
  const prev = cache.get(task.id);
  const fresh = prev && prev.branch === task.branch && now() - prev.fetchedAt < MIN_AGE_MS;
  if (fresh && !opts.force) return Promise.resolve();

  let askedAt = now();
  const p = gate(() => {
    // Sent now: a call waiting at the gate has not asked yet.
    askedAt = now();
    return fetcher(task);
  })
    .then((fetched) => {
      const same = prev && prev.branch === task.branch ? prev : null;
      if (fetched === PR_FETCH_FAILED) {
        // gh could not answer: the last answer stands, asked again on the
        // minute. With none to keep, "none", as it always read.
        if (same) {
          cache.set(task.id, { ...same, fetchedAt: now(), askedAt, failed: true });
          return;
        }
        cache.set(task.id, { pr: null, branch: task.branch, fetchedAt: now(), askedAt, failed: true, streak: 0 });
        emit();
        return;
      }
      const pr = keepThreads(fetched, same ? same.pr : null);
      const streak = same && same.streak > 0 && kindOf(same.pr) === kindOf(pr) ? same.streak + 1 : 1;
      cache.set(task.id, { pr, branch: task.branch, fetchedAt: now(), askedAt, failed: false, streak });
      emit();
    })
    .catch((err) => {
      // fetchPrAnswer does not throw by contract; this is for a fetcher that
      // does. Keep what we had -- a flicker to "no PR" would be a lie.
      console.warn('[gh] pr status failed', err);
    })
    .finally(() => {
      inflight.delete(task.id);
    });
  inflight.set(task.id, p);
  return p;
}

/**
 * An answer that does not say how many review threads the PR has keeps the
 * counts last seen for the same open PR (#278): unknown is not "none", and
 * reading it as none would move the task out of In Review and back.
 */
export function keepThreads(next: PrStatus | null, prev: PrStatus | null | undefined): PrStatus | null {
  if (!next || next.reviewThreads != null) return next;
  if (next.state !== 'open' && next.state !== 'draft') return next;
  if (!prev?.reviewThreads || prev.number !== next.number) return next;
  return { ...next, reviewThreads: prev.reviewThreads };
}

/** Drop a task's entry, e.g. after it is deleted. */
export function forgetPrStatus(taskId: number): void {
  if (cache.delete(taskId)) emit();
}

// --- React -----------------------------------------------------------------

/**
 * One task's PR status. Asking IS the on-demand trigger: mounting this for a
 * task (selecting it) refreshes it unless the answer is younger than
 * {@link MIN_AGE_MS}.
 */
export function usePrStatus(task: PrTask | null): PrStatus | null {
  const id = task?.id ?? null;
  const pr = useSyncExternalStore(subscribePrStatus, () => (id === null ? null : (getPrStatus(id) ?? null)));
  const live = task !== null && task.status !== 'archived';
  useEffect(() => {
    if (task && live) void refreshPrStatus(task);
    // Keyed on identity and branch: a title edit is not a reason to refetch.
  }, [id, task?.branch, live]);
  return live ? pr : null;
}

/** Subscribe to the whole cache, for a list that shows many tasks. */
export function usePrStatusVersion(): number {
  return useSyncExternalStore(subscribePrStatus, () => version);
}

/** Whether the cached answer is an open PR whose checks are still running. */
export function hasPendingChecks(taskId: number): boolean {
  const pr = cache.get(taskId)?.pr;
  return !!pr && (pr.state === 'open' || pr.state === 'draft') && pr.checks.kind === 'pending';
}

/**
 * Keep every PR with running checks polled, on screen or not (#159).
 *
 * Handed ALL tasks, not the visible ones: a task in another project tab, or
 * scrolled away, still has checks finishing, and that is now an event. Only
 * a task whose last answer was "open, checks pending" is asked; it learned
 * that while it was on screen or selected, so nothing here adds a call for a
 * task that has never been looked at. Unlike {@link usePrPolling} it keeps
 * going while the window is hidden -- that is exactly when a banner is the
 * only way to hear about it. The gate still caps it at MAX_CONCURRENT, and
 * {@link pendingIntervalMs} keeps many running PRs within the rate budget.
 * A task on screen is asked by both loops; the in-flight and freshness checks
 * make that one call.
 */
export function usePendingPrWatch(tasks: PrTask[]): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  useEffect(() => {
    const timer = setInterval(() => {
      const due = ref.current.filter((t) => t.status !== 'archived' && hasPendingChecks(t.id));
      const every = pendingIntervalMs(due.length);
      for (const t of due) {
        const e = cache.get(t.id);
        // The slack: a tick lands a moment before the answer it follows is a
        // full interval old (the fetch took that moment), and without it every
        // other tick is skipped -- 30 s, not 15. Forced past MIN_AGE_MS for the
        // same reason; an answer the on-screen loop just got is still skipped.
        if (e && e.branch === t.branch && now() - e.fetchedAt >= every - TICK_SLACK_MS) {
          void refreshPrStatus(t, { force: true });
        }
      }
    }, POLL_PENDING_MS);
    return () => clearInterval(timer);
  }, []);
}

/**
 * Keep the given tasks fresh: now, every {@link POLL_MS}, and whenever the
 * window regains focus. Archived tasks are skipped -- their PR is history.
 */
export function usePrPolling(tasks: PrTask[]): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  // Re-arm only when the SET of tasks changes, not on every status tick.
  const key = tasks
    .filter((t) => t.status !== 'archived')
    .map((t) => `${t.id}:${t.branch}`)
    .join(',');

  useEffect(() => {
    const sweep = () => {
      for (const t of ref.current) {
        if (t.status !== 'archived') void refreshPrStatus(t);
      }
    };
    sweep();
    // One tick at the fast rate; each task is due at its own: a PR with
    // checks running every tick, every other only once POLL_MS has passed --
    // or, quiet with no PR or a merged one, its longer wait (pollEveryMs).
    const tick = () => {
      if (document.hidden) return; // nobody reading the badge; focus catches it up
      for (const t of ref.current) {
        if (t.status === 'archived') continue;
        const e = cache.get(t.id);
        const pending = e?.pr?.checks.kind === 'pending';
        if (!e || pending || now() - e.fetchedAt >= pollEveryMs(e, t)) void refreshPrStatus(t);
      }
    };
    const timer = setInterval(tick, POLL_PENDING_MS);
    window.addEventListener('focus', sweep);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', sweep);
    };
  }, [key]);
}

/**
 * The signed-in gh user's login, or null while unknown (#180). Asked when
 * `ask` is true and the login is not known yet -- and again when `key`
 * changes (another task), so a launch while offline catches up; gh.ts keeps
 * a failure from being asked more than every few minutes.
 */
export function useViewerLogin(ask: boolean, key: unknown): string | null {
  const [login, setLogin] = useState<string | null>(viewerLogin);
  useEffect(() => {
    if (!ask || login !== null) return;
    let live = true;
    void loadViewerLogin().then((l) => {
      if (live && l) setLogin(l);
    });
    return () => {
      live = false;
    };
  }, [ask, key, login]);
  return login;
}
