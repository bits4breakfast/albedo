/**
 * "Your PR's checks finished" -- a banner and a Dock bounce when you are away,
 * a mark on the task's row when you are here (#159).
 *
 * Like `mergeNotice.ts`, this adds no `gh` calls: it watches the PR store's
 * answers go by and hands each to `ciStep` (`gh/ciTransition.ts`), which
 * decides whether checks just finished. What happens then depends on where
 * the owner is, decided by the owner on the issue:
 *
 *   - **Window not focused:** a banner and one Dock bounce, for a pass and a
 *     failure alike (`noteChecksFinished`). Clicking it opens the task, and
 *     for a failure the Checks dialog, which opens on the first failing job.
 *     The row is marked as well -- a banner can be dismissed unread, and the
 *     mark is what says which task when you come back.
 *   - **Window focused:** no banner, no bounce. The row is marked with an
 *     unseen ✓ or ✗ until the task is opened.
 *   - **The task already open:** no mark (it is being looked at, so it would
 *     be seen the moment it appeared); a brief cue on its PR badge instead.
 *
 * "Notify When CI Finishes" (the ⋯ menu) turns the banner and the bounce
 * off; the row mark and the cue stay, as they are quiet. The app-wide banner
 * switch (`notificationsEnabled`) is respected too.
 *
 * Everything is in memory: the PR store is (see there), and so is "seen" for
 * this mark -- a mark from a run that ended is about checks you have since
 * looked at on GitHub.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { ciBanner, ciStep, type CiEvent, type CiOutcome, type CiWatch } from '../gh/ciTransition';
import { getPrStatus, subscribePrStatus } from '../gh/prStore';
import type { PrStatus } from '../gh/prStatus';
import { noteChecksFinished } from './attention';
import { KEYS, readPersisted, writePersisted, type Codec } from './persisted';

/** An unseen result on a task's row. */
export interface CiMark {
  outcome: CiOutcome;
  prNumber: number;
  /** For a failure: the first failing job, with its reason. */
  job?: string;
}

/** How long the open task's PR badge shows its cue. */
export const CI_CUE_MS = 4_000;

const watches = new Map<number, CiWatch>();
const marks = new Map<number, CiMark>();
let cue: { taskId: number; outcome: CiOutcome } | null = null;
let cueTimer: ReturnType<typeof setTimeout> | null = null;
/** A banner click asked for this task's checks to be shown. */
let checksRequest: number | null = null;

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

// --- the setting -------------------------------------------------------------

/** Only 'off' is stored; on removes the key. */
const onOff: Codec<boolean> = {
  decode: (raw) => raw !== 'off',
  encode: (on) => (on ? null : 'off'),
};

/** "Notify When CI Finishes". Never throws: no storage reads as "on". */
export function ciNotifyEnabled(): boolean {
  return readPersisted(KEYS.ciNotifications, onOff, true);
}

export function setCiNotifyEnabled(on: boolean): void {
  writePersisted(KEYS.ciNotifications, onOff, on);
  emit();
}

/** The setting, for the menu that shows it. */
export function useCiNotifyEnabled(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, ciNotifyEnabled);
  return [on, setCiNotifyEnabled];
}

// --- observing ---------------------------------------------------------------

/**
 * One PR answer for one task. Exported for tests; `useCiNotices` is the
 * production caller.
 */
export function observeCi(
  task: Pick<Task, 'id' | 'title'>,
  pr: PrStatus | null,
  selectedId: number | null,
): CiEvent | null {
  const prev = watches.get(task.id);
  const { watch, event } = ciStep(prev, pr);
  if (watch) watches.set(task.id, watch);
  let changed = false;
  // A push makes a mark about the commit before it old news.
  if (prev && watch && prev.sha !== watch.sha && marks.delete(task.id)) changed = true;
  if (event) {
    changed = true;
    // Unfocused only; focused, it does nothing (see there).
    if (ciNotifyEnabled()) noteChecksFinished(task.id, event.outcome, ciBanner(event, task.title, task.id));
    if (task.id === selectedId) {
      showCue(task.id, event.outcome);
    } else {
      const mark: CiMark = { outcome: event.outcome, prNumber: event.prNumber };
      if (event.job) mark.job = event.reason ? `${event.job} (${event.reason})` : event.job;
      marks.set(task.id, mark);
    }
  }
  if (changed) emit();
  return event;
}

function showCue(taskId: number, outcome: CiOutcome): void {
  cue = { taskId, outcome };
  if (cueTimer) clearTimeout(cueTimer);
  cueTimer = setTimeout(() => {
    cue = null;
    cueTimer = null;
    emit();
  }, CI_CUE_MS);
}

/** The task was opened: its result has been seen. */
export function clearCiMark(taskId: number): void {
  if (marks.delete(taskId)) emit();
}

/** The unseen result on a task's row, if any. */
export function ciMarkFor(taskId: number): CiMark | undefined {
  return marks.get(taskId);
}

/** The open task's PR badge cue, while it lasts. */
export function ciCueFor(taskId: number): CiOutcome | null {
  return cue?.taskId === taskId ? cue.outcome : null;
}

/** A banner for a failure was clicked: show that task's checks once it is open. */
export function requestChecks(taskId: number): void {
  checksRequest = taskId;
  emit();
}

/** True once for the task a banner click asked for; the request is then spent. */
export function takeChecksRequest(taskId: number): boolean {
  if (checksRequest !== taskId) return false;
  checksRequest = null;
  return true;
}

/** Re-render on any change here (marks, cue, setting, a checks request). */
export function useCiVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** @internal for tests */
export function resetCiNoticesForTests(): void {
  watches.clear();
  marks.clear();
  cue = null;
  if (cueTimer) clearTimeout(cueTimer);
  cueTimer = null;
  checksRequest = null;
  emit();
}

/**
 * Watch the PR store for every task, on screen or not, and raise the
 * notices. Archived tasks and chats are skipped: neither has checks to wait
 * on. The selected task's mark is cleared whenever it becomes the selected
 * one, by whatever path -- opening a task is what "seen" means.
 */
export function useCiNotices(
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'kind'>[],
  selectedId: number | null,
): void {
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const check = () => {
      for (const t of tasksRef.current) {
        if (t.status === 'archived' || t.kind === 'chat') continue;
        const pr = getPrStatus(t.id);
        if (pr === undefined) continue; // not asked yet
        observeCi(t, pr, selectedRef.current);
      }
    };
    check();
    return subscribePrStatus(check);
  }, []);

  useEffect(() => {
    if (selectedId !== null) clearCiMark(selectedId);
  }, [selectedId]);
}
