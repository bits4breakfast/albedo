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
 * (fired or not -- see adapter.ts), a monitor at its timeout, a recurring
 * timer after Claude Code's 7 days. `nextChangeAt` says when the answer next
 * changes with no new row, so a caller re-reads then instead of polling.
 */

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
  /** When it is due (a wake-up) or expires (a monitor, a timer); null for never. */
  until: number | null;
  /** The starting call's row, to scroll the transcript to. */
  rowId: number;
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
  return foldBackground(rows, since).filter((i) => i.until === null || i.until > now);
}

/**
 * When `runningInBackground` next changes with no new row: the earliest
 * deadline still ahead of `now`, or null.
 */
export function nextChangeAt(rows: readonly Row[], since: number | null, now: number): number | null {
  let next: number | null = null;
  for (const i of foldBackground(rows, since)) {
    if (i.until !== null && i.until > now && (next === null || i.until < next)) next = i.until;
  }
  return next;
}

/** Every start still open by the rows alone, deadlines not yet applied. */
function foldBackground(rows: readonly Row[], since: number | null): BackgroundItem[] {
  if (since === null) return [];
  const ordered = rows.filter((r) => r.agentId === null).sort((a, b) => a.ts - b.ts || a.id - b.id);

  const calls = new Map<string, { kind: BackgroundKind; description: string; ts: number; rowId: number }>();
  const running = new Map<string, BackgroundItem & { taskId: string | null }>();
  const endOf = (pred: (i: BackgroundItem & { taskId: string | null }) => boolean) => {
    for (const [k, i] of running) if (pred(i)) running.delete(k);
  };

  for (const row of ordered) {
    for (const f of backgroundFactsOf(row)) {
      switch (f.fact) {
        case 'call':
          if (row.ts >= since) calls.set(f.toolUseId, { kind: f.kind, description: f.description, ts: row.ts, rowId: row.id });
          break;
        case 'result': {
          const call = calls.get(f.toolUseId);
          if (!call || !f.ok || running.has(f.toolUseId)) break;
          let until: number | null = null;
          let taskId: string | null = f.taskId;
          if (call.kind === 'wakeup') {
            if (f.scheduledFor === null) break;
            until = f.scheduledFor;
            // One wake-up is pending at a time: the next one replaces it.
            endOf((i) => i.kind === 'wakeup');
          } else if (call.kind === 'timer') {
            taskId = f.jobId;
            until = row.ts + TIMER_MAX_MS;
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
            taskId,
          });
          break;
        }
        case 'end': {
          const ids = new Set(f.toolUseIds);
          const tasks = new Set(f.taskIds);
          endOf((i) => ids.has(i.key) || (i.taskId !== null && tasks.has(i.taskId)));
          break;
        }
        case 'stop':
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
