/**
 * "Your PR was merged" -- an attention mark, and a banner when it is news.
 *
 * The input is the PR store (`gh/prStore`), which is already polled per
 * non-archived task; this adds no `gh` calls of its own. It only watches the
 * answers go by and decides which of them are events.
 *
 * The rule is the one `attentionFor` applies to session status: a transition
 * is an event, a level is not. A PR seen open (or draft) and then merged is
 * something that happened while you were here, and gets the full treatment.
 * A PR that is already merged the first time this run asks is history: the
 * row is marked, because "archive or follow up" is still the open question,
 * but nothing bounces or posts.
 */

import { useEffect, useRef } from 'react';
import type { Task } from '../types';
import type { PrState } from '../gh/prStatus';
import { getPrStatus, subscribePrStatus } from '../gh/prStore';
import { noteMerged } from './attention';

/** What a change in a task's PR state deserves. */
export type MergeNotice =
  /** Merged while we were watching: mark, and notify. */
  | 'notify'
  /** Already merged when first seen: mark only. */
  | 'mark';

/**
 * The transition table.
 *
 * `prev` is undefined when this run has not observed the task before, and
 * null when it observed "no PR" (or gh being unavailable). Only `open`/`draft`
 * -> `merged` notifies: from null it is as likely a gh that came back as a
 * merge that just happened, and from `merged` it is a repeat.
 */
export function mergeNoticeFor(
  prev: PrState | null | undefined,
  next: PrState | null,
): MergeNotice | null {
  if (next !== 'merged' || prev === 'merged') return null;
  return prev === 'open' || prev === 'draft' ? 'notify' : 'mark';
}

/**
 * Watch the PR store for the given tasks and raise the notices. Archived tasks
 * are skipped: they are not polled, and a merge is what archived them.
 */
export function useMergeNotices(tasks: Pick<Task, 'id' | 'title' | 'status'>[]): void {
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  /** Last state observed per task in this run. Absent = never observed. */
  const seen = useRef(new Map<number, PrState | null>());

  useEffect(() => {
    const check = () => {
      for (const t of tasksRef.current) {
        if (t.status === 'archived') continue;
        const pr = getPrStatus(t.id);
        if (pr === undefined) continue; // not asked yet
        const next = pr?.state ?? null;
        const notice = mergeNoticeFor(seen.current.get(t.id), next);
        seen.current.set(t.id, next);
        if (notice) noteMerged(t.id, t.title, pr?.number ?? null, notice === 'notify');
      }
    };
    check();
    return subscribePrStatus(check);
  }, []);
}
