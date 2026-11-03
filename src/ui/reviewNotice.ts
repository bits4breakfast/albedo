/**
 * "A review landed on your PR" -- a banner and a Dock bounce when you are
 * away, a mark on the task's row either way (#180).
 *
 * The same path as the checks (`ciNotice.ts`, #159), and the same switch: the
 * owner decided one setting covers news about a task's PR, checks and
 * reviews alike ("Notify About PRs: Checks and Reviews", stored under the
 * #159 key). Like it, this adds no `gh` calls: it watches the PR store's
 * answers go by and hands each to `reviewStep` (`gh/reviewTransition.ts`).
 *
 *   - **Window not focused:** a banner ("PR #12 approved by alice") and one
 *     Dock bounce (`noteReviewLanded`), unless the switch is off. The row is
 *     marked as well: a banner can be dismissed unread.
 *   - **Window focused:** no banner, no bounce; the row is marked.
 *   - **The task already open:** no mark. Its header's review chip shows
 *     the new state where the owner is looking.
 *
 * The mark is news, not state -- the row shows no PR state otherwise (see
 * TaskList). It says Approved or Changes, until the task is opened, the PR
 * stops being open, or a newer review replaces it. Awaiting Review never
 * marks a row: it is the default state of every open PR.
 *
 * The row shows only a Changes mark from here. Approved, by the owner's
 * decision (#234), is state: read from the PR as it is now
 * ({@link standingApproval}) and shown on every row, the selected one too,
 * until the PR is merged.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { reviewBanner, reviewStep, type ReviewEvent, type ReviewOutcome, type ReviewWatch } from '../gh/reviewTransition';
import { getPrStatus, subscribePrStatus } from '../gh/prStore';
import { loadViewerLogin, viewerLogin } from '../gh/gh';
import type { PrStatus } from '../gh/prStatus';
import { noteReviewLanded } from './attention';
import { ciNotifyEnabled } from './ciNotice';

/** An unseen review on a task's row. */
export interface ReviewMark {
  outcome: ReviewOutcome;
  prNumber: number;
  reviewers: string[];
}

const watches = new Map<number, ReviewWatch>();
const marks = new Map<number, ReviewMark>();

const listeners = new Set<() => void>();
let version = 0;
function emit(): void {
  version += 1;
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * One PR answer for one task. Exported for tests; `useReviewNotices` is the
 * production caller.
 */
export function observeReview(
  task: Pick<Task, 'id' | 'title'>,
  pr: PrStatus | null,
  selectedId: number | null,
): ReviewEvent | null {
  const prev = watches.get(task.id);
  const { watch, event } = reviewStep(prev, pr, viewerLogin());
  if (watch) watches.set(task.id, watch);
  let changed = false;
  // Merged, closed, or another PR: a mark about the old review is old news.
  const mark = marks.get(task.id);
  if (mark && pr && (pr.state !== 'open' || pr.number !== mark.prNumber)) {
    marks.delete(task.id);
    changed = true;
  }
  if (event) {
    changed = true;
    // Unfocused only; focused, it does nothing (see there).
    if (ciNotifyEnabled()) noteReviewLanded(task.id, event.outcome, reviewBanner(event, task.title, task.id));
    if (task.id !== selectedId) {
      marks.set(task.id, { outcome: event.outcome, prNumber: event.prNumber, reviewers: event.reviewers });
    }
  }
  if (changed) emit();
  return event;
}

/** The task was opened: its review has been seen. */
export function clearReviewMark(taskId: number): void {
  if (marks.delete(taskId)) emit();
}

/** The unseen review on a task's row, if any. */
export function reviewMarkFor(taskId: number): ReviewMark | undefined {
  return marks.get(taskId);
}

/**
 * The approval that stands on a task's PR (#234): open, not a draft, and
 * approved, as GitHub says now. State, not news -- by the owner's decision it
 * stays on the row, selected or not and across restarts, until the PR is
 * merged or closed, or the approval is dismissed or outranked by a change
 * request. Each of those arrives with the next poll.
 */
export function standingApproval(pr: PrStatus | null | undefined): ReviewMark | null {
  if (!pr || pr.state !== 'open' || pr.review !== 'approved') return null;
  const reviewers = (pr.reviews ?? []).filter((r) => r.state === 'approved').map((r) => r.author);
  return { outcome: 'approved', prNumber: pr.number, reviewers };
}

/** Re-render on any change to the marks. */
export function useReviewVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** @internal for tests */
export function resetReviewNoticesForTests(): void {
  watches.clear();
  marks.clear();
  emit();
}

/**
 * Watch the PR store for every task, on screen or not, and raise the notices.
 * Archived tasks and chats are skipped, as for the checks. Opening a task, by
 * whatever path, clears its mark.
 */
export function useReviewNotices(
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'kind'>[],
  selectedId: number | null,
): void {
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    let live = true;
    const check = () => {
      let anyPr = false;
      for (const t of tasksRef.current) {
        if (t.status === 'archived' || t.kind === 'chat') continue;
        const pr = getPrStatus(t.id);
        if (pr === undefined) continue; // not asked yet
        if (pr) anyPr = true;
        observeReview(t, pr, selectedRef.current);
      }
      // A new review waits until the signed-in login is known (see
      // `reviewStep`), so ask for it here: the PR badge asks only for the
      // open task, and nothing else would. gh.ts dedupes and paces the asking.
      if (anyPr && viewerLogin() === null) {
        void loadViewerLogin().then((l) => {
          if (live && l) check();
        });
      }
    };
    check();
    const unsubscribe = subscribePrStatus(check);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (selectedId !== null) clearReviewMark(selectedId);
  }, [selectedId]);
}
