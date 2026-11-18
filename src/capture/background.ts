/**
 * Which background work is running, folded from transcript rows (#122).
 *
 * Pure. The rows say what started and what ended (`backgroundFactsOf`,
 * adapter.ts, which also records what was measured); this decides what is
 * left. Two rules come from outside the rows:
 *
 *  - **Only since the pty was spawned.** Background work dies with the claude
 *    process, and nothing is written when it does. A start from before the
 *    live pty belongs to a process that is gone, and without a live pty
 *    nothing counts: the caller passes `since` null.
 *  - **Main thread only.** A subagent's own background work is started and
 *    ended in the subagent's transcript, and runs inside the agent it belongs
 *    to, which is already shown while it runs (the Agents strip, the row's
 *    agent count). Counting both would be the same work twice.
 *
 * Time ends some of it without a row: a wake-up at its `scheduledFor`
 * (fired or not -- see adapter.ts), a monitor at its timeout, a one-shot
 * timer at its run, a recurring timer after Claude Code's 7 days. And time
 * moves a recurring timer's next run on (#443). `nextChangeAt` says when the
 * answer next changes with no new row, so a caller re-reads then instead of
 * polling.
 */

import { cronNext } from '../lib/cron';
import type { Message } from '../types';
import { backgroundFactsOf, type BackgroundKind } from './adapter';
import { TIMER_MAX_MS, timerFinalRun, timerRunAfter } from './timerRuns';

export type { BackgroundKind } from './adapter';

export interface BackgroundItem {
  /** The starting call's tool-use id. */
  key: string;
  kind: BackgroundKind;
  /** One line: the call's description, command, reason or prompt. May be empty. */
  description: string;
  /** When it started: the call's row. */
  startedAt: number;
  /** When it is due (a wake-up), runs (a one-shot timer) or expires (a monitor, a recurring timer); null for never. */
  until: number | null;
  /** The starting call's row, to scroll the transcript to. */
  rowId: number;
  /** A timer's schedule; null for every other kind. */
  schedule: TimerSchedule | null;
  /**
   * When it next wakes the task by itself, as of the `now` it was read at: a
   * wake-up's due time, a timer's next run. Null for every other kind, and
   * for a timer whose next run is not known (a cron this cannot read).
   */
  nextRunAt: number | null;
}

export interface TimerSchedule {
  /** The cron expression, 5 fields, local time; null when the call had none. */
  cron: string | null;
  /** Runs once (`recurring: false`), and is over once it has. */
  once: boolean;
  /** Its first run, as its result says (`nextFireAt`); null when it does not. */
  firstRunAt: number | null;
  /** When it was created: its result's row. */
  createdAt: number;
  /** When its runs came (`scheduled_task_fire`), oldest first: the latest few; empty before any. */
  firedAt: readonly number[];
}

/** A monitor whose result does not say its timeout gets Claude Code's default. */
export const MONITOR_DEFAULT_TIMEOUT_MS = 30 * 60_000;
export { TIMER_MAX_MS } from './timerRuns';

type Row = Pick<Message, 'id' | 'role' | 'seq' | 'rawJson' | 'toolName' | 'agentId' | 'ts'>;

/**
 * What is running in the background at `now`, oldest first. `rows` are the
 * session's rows in any order; `since` is when the task's live pty was
 * spawned, null with none.
 */
export function runningInBackground(rows: readonly Row[], since: number | null, now: number): BackgroundItem[] {
  return foldBackground(rows, since)
    .filter((i) => i.until === null || i.until > now)
    .map((i) => ({ ...i, nextRunAt: nextRunOf(i, now) }));
}

/**
 * When `runningInBackground` next changes with no new row: the earliest
 * deadline or timer run still ahead of `now`, or null.
 */
export function nextChangeAt(rows: readonly Row[], since: number | null, now: number): number | null {
  let next: number | null = null;
  const consider = (at: number | null) => {
    if (at !== null && at > now && (next === null || at < next)) next = at;
  };
  for (const i of foldBackground(rows, since)) {
    consider(i.until);
    if (i.until === null || i.until > now) consider(nextRunOf(i, now));
  }
  return next;
}

/**
 * When an item next wakes the task, after `now`: a wake-up when it is due; a
 * one-shot timer at its run; a recurring timer at its next run as Claude
 * Code computes it (timerRuns.ts: measured on 2.1.327, may change), counted
 * from its last run. Null for anything else, or when it is not known.
 */
export function nextRunOf(item: Pick<BackgroundItem, 'kind' | 'until' | 'schedule'>, now: number): number | null {
  if (item.kind === 'wakeup') return item.until !== null && item.until > now ? item.until : null;
  const s = item.schedule;
  if (item.kind !== 'timer' || s === null) return null;
  if (s.once) return item.until !== null && item.until > now ? item.until : null;
  if (s.cron === null) return s.firstRunAt !== null && s.firstRunAt > now ? s.firstRunAt : null;
  return timerRunAfter({ ...s, cron: s.cron }, now);
}

/**
 * When a timer is over by time alone: a one-shot at its run; a recurring one
 * after its last run, the first at or past 7 days (Claude Code deletes an
 * aged-out job only once it has run once more), or at 7 days when that run
 * is not known.
 */
function timerUntil(s: TimerSchedule): number | null {
  if (s.once) return s.firstRunAt ?? (s.cron === null ? null : cronNext(s.cron, s.createdAt));
  const final = s.cron === null ? null : timerFinalRun({ ...s, cron: s.cron });
  return final ?? s.createdAt + TIMER_MAX_MS;
}

/** Every start still open by the rows alone, deadlines not yet applied. */
function foldBackground(rows: readonly Row[], since: number | null): BackgroundItem[] {
  if (since === null) return [];
  const ordered = rows.filter((r) => r.agentId === null).sort((a, b) => a.ts - b.ts || a.id - b.id);

  const calls = new Map<
    string,
    { kind: BackgroundKind; description: string; ts: number; rowId: number; schedule: { cron: string | null; once: boolean } | null }
  >();
  const running = new Map<string, BackgroundItem & { taskId: string | null }>();
  // What has already ended, by tool-use id and task id. Claude Code can write
  // a shell's end before the result that starts it: one that failed at once
  // was noticed 11 ms before its result (#350). Sorting by time cannot fix
  // that order, so a start whose end was already seen never opens.
  const endedUses = new Set<string>();
  const endedTasks = new Set<string>();
  const endOf = (pred: (i: BackgroundItem & { taskId: string | null }) => boolean) => {
    for (const [k, i] of running) if (pred(i)) running.delete(k);
  };

  for (const row of ordered) {
    for (const f of backgroundFactsOf(row)) {
      switch (f.fact) {
        case 'call':
          if (row.ts >= since) {
            calls.set(f.toolUseId, { kind: f.kind, description: f.description, ts: row.ts, rowId: row.id, schedule: f.schedule });
          }
          break;
        case 'result': {
          const call = calls.get(f.toolUseId);
          if (!call || !f.ok || running.has(f.toolUseId)) break;
          if (endedUses.has(f.toolUseId) || (f.taskId !== null && endedTasks.has(f.taskId))) break;
          let until: number | null = null;
          let taskId: string | null = f.taskId;
          let schedule: TimerSchedule | null = null;
          if (call.kind === 'wakeup') {
            if (f.scheduledFor === null) break;
            until = f.scheduledFor;
            // One wake-up is pending at a time: the next one replaces it.
            endOf((i) => i.kind === 'wakeup');
          } else if (call.kind === 'timer') {
            taskId = f.jobId;
            schedule = {
              cron: call.schedule?.cron ?? null,
              once: call.schedule?.once === true,
              firstRunAt: f.nextFireAt,
              createdAt: row.ts,
              firedAt: [],
            };
            // A one-shot whose run is not known could be counting a job that
            // already ran, so it is not shown. `until` is set again once
            // every run line is read, below.
            until = timerUntil(schedule);
            if (until === null) break;
          } else {
            // A shell, agent or monitor that ran in the foreground has no task id.
            if (f.taskId === null) break;
            if (call.kind === 'monitor' && !f.persistent) until = row.ts + (f.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS);
          }
          running.set(f.toolUseId, {
            key: f.toolUseId,
            kind: call.kind,
            description: call.description,
            startedAt: call.ts,
            until,
            rowId: call.rowId,
            schedule,
            nextRunAt: null,
            taskId,
          });
          break;
        }
        case 'end': {
          const ids = new Set(f.toolUseIds);
          const tasks = new Set(f.taskIds);
          for (const id of ids) endedUses.add(id);
          for (const t of tasks) endedTasks.add(t);
          endOf((i) => ids.has(i.key) || (i.taskId !== null && tasks.has(i.taskId)));
          break;
        }
        case 'stop':
          endedTasks.add(f.taskId);
          endOf((i) => i.taskId === f.taskId);
          break;
        case 'wakeups-stopped':
          endOf((i) => i.kind === 'wakeup');
          break;
        case 'timer-fired': {
          for (const [k, i] of running) {
            if (i.kind !== 'timer' || i.taskId !== f.jobId || i.schedule === null) continue;
            // A one-shot deletes itself once it has run; a recurring job
            // aged out, once it has run past its 7 days.
            if (i.schedule.once || row.ts >= i.schedule.createdAt + TIMER_MAX_MS) running.delete(k);
            else i.schedule = { ...i.schedule, firedAt: [...i.schedule.firedAt, row.ts] };
          }
          break;
        }
        case 'timer-deleted': {
          // A delete this cannot pair (an id this does not know) ends every
          // timer: showing one that is gone would be the false thing.
          const known = f.id !== null && [...running.values()].some((i) => i.kind === 'timer' && i.taskId === f.id);
          endOf((i) => i.kind === 'timer' && (!known || i.taskId === f.id));
          break;
        }
      }
    }
  }

  return [...running.values()]
    .map(({ taskId: _taskId, ...item }) => (item.schedule === null ? item : { ...item, until: timerUntil(item.schedule) }))
    .sort((a, b) => a.startedAt - b.startedAt || a.rowId - b.rowId);
}
