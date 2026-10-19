/**
 * Pure presentation logic for the subagent strip and inspector, kept out of
 * the components so it is testable without a DOM or a database -- the same
 * split `db/subagents.ts` makes with `buildRuns`.
 */

import type { TaskStatus } from '../types';
import type { SubagentRun } from '../db/subagents';

/**
 * Past this many live agents the strip collapses to one summary line.
 *
 * Every row is up to two lines of label, so five agents is already ten lines of
 * transcript height spent on chrome -- the strip exists to answer "what is
 * running", not to become the pane. Four still fits a laptop-height window with
 * the transcript readable beneath it.
 */
export const COLLAPSE_AFTER = 4;

export function shouldCollapse(liveCount: number): boolean {
  return liveCount > COLLAPSE_AFTER;
}

/**
 * The status word shown beside the dot. Colour alone is not a status mark
 * (HIG: never rely on colour by itself), so every row carries the word too.
 *
 * `idle` reads "Finished" here, not the task list's "Idle": a subagent does
 * not wait for another prompt the way a session does -- when its turn ends it
 * has handed its result back and is done.
 */
export function agentStatusWord(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'blocked':
      return 'Needs you';
    case 'idle':
    case 'done':
      return 'Finished';
    case 'archived':
      return 'Archived';
    default:
      return status;
  }
}

/**
 * How long the agent has been at it. A live agent counts up to `now`; one that
 * has finished stops at its last row, so the inspector does not keep a
 * finished run's clock ticking.
 */
export function elapsedMs(run: Pick<SubagentRun, 'firstTs' | 'lastTs' | 'status'>, now: number): number {
  const live = run.status === 'running' || run.status === 'blocked';
  const end = live ? Math.max(now, run.lastTs) : run.lastTs;
  return Math.max(0, end - run.firstTs);
}

/** `42s`, `3m 05s`, `1h 02m`. Seconds stop mattering once it is hours. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Spoken form for assistive tech: "3 minutes 5 seconds", not "3m 05s". */
export function spokenElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (h > 0) return m > 0 ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour');
  if (m > 0) return s > 0 ? `${unit(m, 'minute')} ${unit(s, 'second')}` : unit(m, 'minute');
  return unit(s, 'second');
}

/**
 * The strip's one-line summary: "5 agents · 1 needs you". Blocked is the only
 * count worth calling out separately -- it is the one that will sit there
 * until you act.
 */
export function stripSummary(live: readonly Pick<SubagentRun, 'status'>[]): string {
  const n = live.length;
  const blocked = live.filter((r) => r.status === 'blocked').length;
  const head = `${n} agent${n === 1 ? '' : 's'} running`;
  return blocked > 0 ? `${head} · ${blocked} need${blocked === 1 ? 's' : ''} you` : head;
}

/** What a row is called when the agent has not said anything yet. */
export function agentLabel(run: Pick<SubagentRun, 'label' | 'agentId'>): string {
  return run.label ?? `Agent ${run.agentId.slice(0, 8)}`;
}
