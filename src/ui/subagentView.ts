/**
 * Pure presentation logic for the subagent strip and inspector, kept out of
 * the components so it is testable without a DOM or a database -- the same
 * split `db/subagents.ts` makes with `buildRuns`.
 */

import { liveRuns, type SubagentRun } from '../db/subagents';

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
 * What a row says, one step finer than `TaskStatus`: `waiting` is an agent
 * that stopped with background work of its own still running (#139). Its
 * status is `idle`, so nothing counts it as at work; this is only what it is
 * called.
 */
export type AgentState = 'running' | 'blocked' | 'waiting' | 'finished' | 'archived';

export function agentState(run: Pick<SubagentRun, 'status' | 'waiting'>): AgentState {
  switch (run.status) {
    case 'running':
      return 'running';
    case 'blocked':
      return 'blocked';
    case 'archived':
      return 'archived';
    default:
      return run.waiting ? 'waiting' : 'finished';
  }
}

/**
 * The status word shown beside the dot. Colour alone is not a status mark
 * (HIG: never rely on colour by itself), so every row carries the word too.
 *
 * `idle` reads "Finished" here, not the task list's "Idle": a subagent does
 * not wait for another prompt the way a session does -- when its turn ends it
 * has handed its result back and is done. Unless it said it is waiting on its
 * own background work: then "In Background", the task list's words for work
 * that goes on after a turn (#123).
 */
export function agentStatusWord(run: Pick<SubagentRun, 'status' | 'waiting'>): string {
  switch (agentState(run)) {
    case 'running':
      return 'Running';
    case 'blocked':
      return 'Needs You';
    case 'waiting':
      return 'In Background';
    case 'finished':
      return 'Finished';
    case 'archived':
      return 'Archived';
  }
}

/** The longer form, for a tooltip and assistive tech. */
export function agentStatusDetail(run: Pick<SubagentRun, 'status' | 'waiting'>): string {
  return agentState(run) === 'waiting'
    ? 'Waiting on its own background work. It may resume on its own when that work reports'
    : agentStatusWord(run);
}

/**
 * How long the agent has been at it, in its current run: since it started or
 * was last resumed, not since it was first spawned. A live agent counts up to
 * `now`; one that has stopped -- finished, or waiting on its own background
 * work -- stops at its last row, so its clock does not keep ticking.
 */
export function elapsedMs(run: Pick<SubagentRun, 'runStartTs' | 'lastTs' | 'status'>, now: number): number {
  const live = run.status === 'running' || run.status === 'blocked';
  const end = live ? Math.max(now, run.lastTs) : run.lastTs;
  return Math.max(0, end - run.runStartTs);
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
 * The strip's one-line summary: "5 Agents Running · 1 Needs You". Blocked is the only
 * live count worth calling out separately -- it is the one that will sit there
 * until you act. Agents waiting on their own background work are not running;
 * when listed, they are named after the count ("· 1 In Background").
 */
export function stripSummary(live: readonly Pick<SubagentRun, 'status'>[], waiting = 0): string {
  const n = live.length;
  const blocked = live.filter((r) => r.status === 'blocked').length;
  let out = `${n} Agent${n === 1 ? '' : 's'} Running`;
  if (blocked > 0) out += ` · ${blocked} Need${blocked === 1 ? 's' : ''} You`;
  if (waiting > 0) out += ` · ${waiting} In Background`;
  return out;
}

/**
 * The rows the strip lists: every live agent, then those waiting on their own
 * background work. Waiting ones are listed only beside live ones -- they
 * never open the strip on their own, since nothing is at work -- and are
 * named so they are not mistaken for finished.
 */
export function stripRuns(runs: readonly SubagentRun[]): { live: SubagentRun[]; waiting: SubagentRun[] } {
  const live = liveRuns(runs);
  const waiting = live.length === 0 ? [] : runs.filter((r) => agentState(r) === 'waiting');
  return { live, waiting };
}

/** The earliest moment any run's status goes stale with no new row, or null. */
export function nextExpiry(runs: readonly Pick<SubagentRun, 'expiresAt'>[]): number | null {
  let at: number | null = null;
  for (const r of runs) if (r.expiresAt !== null && (at === null || r.expiresAt < at)) at = r.expiresAt;
  return at;
}

/** What a row is called when the agent has not said anything yet. */
export function agentLabel(run: Pick<SubagentRun, 'label' | 'agentId'>): string {
  return run.label ?? `Agent ${run.agentId.slice(0, 8)}`;
}
