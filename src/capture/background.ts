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

import { cronNext, cronPrev, parseCron } from '../lib/cron';
import type { Message } from '../types';
import { backgroundFactsOf, type BackgroundKind } from './adapter';

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
}

/** A monitor whose result does not say its timeout gets Claude Code's default. */
export const MONITOR_DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** A recurring CronCreate job expires after this (its tool description). */
export const TIMER_MAX_MS = 7 * 24 * 60 * 60_000;

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
 * A recurring job runs a fixed time after each of its cron's slots, the same
 * for every run of one job (measured, adapter.ts). That offset is its first
 * run minus the slot the run belongs to: the last slot at or before it, when
 * that is at most 30 minutes back; else the next slot, when the run is at
 * most 5 minutes before it (a run early); else none, rather than an offset
 * taken from a slot days away.
 */
const OFFSET_LATE_MAX_MS = 30 * 60_000;
const OFFSET_EARLY_MAX_MS = 5 * 60_000;

export function timerOffsetMs(cron: string, firstRunAt: number): number {
  const c = parseCron(cron);
  if (c === null) return 0;
  const before = cronPrev(c, firstRunAt);
  if (before !== null && firstRunAt - before <= OFFSET_LATE_MAX_MS) return firstRunAt - before;
  const after = cronNext(c, firstRunAt);
  if (after !== null && after - firstRunAt <= OFFSET_EARLY_MAX_MS) return firstRunAt - after;
  return 0;
}

/**
 * When an item next wakes the task, after `now`: a wake-up when it is due; a
 * timer at its first run while that is ahead, then -- recurring only -- at
 * its cron's next slot plus the job's offset, while that is before it
 * expires. Null for anything else, or when it is not known.
 */
export function nextRunOf(item: Pick<BackgroundItem, 'kind' | 'until' | 'schedule'>, now: number): number | null {
  if (item.kind === 'wakeup') return item.until !== null && item.until > now ? item.until : null;
  const s = item.schedule;
  if (item.kind !== 'timer' || s === null) return null;
  if (s.firstRunAt !== null && s.firstRunAt > now) return s.firstRunAt;
  if (s.once || s.cron === null) return s.once && item.until !== null && item.until > now ? item.until : null;
  const offset = s.firstRunAt === null ? 0 : timerOffsetMs(s.cron, s.firstRunAt);
  const slot = cronNext(s.cron, now - offset);
  if (slot === null) return null;
  const at = slot + offset;
  return item.until !== null && at >= item.until ? null : at;
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
            const cron = call.schedule?.cron ?? null;
            const once = call.schedule?.once === true;
            schedule = { cron, once, firstRunAt: f.nextFireAt };
            if (once) {
              // Over once it has run: at its first run, or its cron's next
              // slot after the call. Neither known: it could be counting a
              // job that already ran, so it is not shown.
              until = f.nextFireAt ?? (cron === null ? null : cronNext(cron, call.ts));
              if (until === null) break;
            } else {
              until = row.ts + TIMER_MAX_MS;
            }
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
    .map(({ taskId: _taskId, ...item }) => item)
    .sort((a, b) => a.startedAt - b.startedAt || a.rowId - b.rowId);
}
