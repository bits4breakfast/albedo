/**
 * What the working line under a running turn says: the step in progress and
 * the turn's totals, read from the rows the pane already holds (#112).
 *
 * Transcript rows only, never the terminal. Claude Code writes an assistant
 * `tool_use` the moment it is asked for and its `tool_result` only when it
 * finishes (measured: text 14:34:14, tool_use 14:34:18, result 14:34:27), so
 * a call with no result yet is what is running.
 *
 * Main-session rows only. A subagent's rows share the parent's session id
 * (`agentId` set); while one runs, the parent's own Agent call has no result
 * yet, and that call -- with its description -- is the step. Its own tool
 * calls and tokens are not this turn's.
 */

import type { Message } from '../../types';
import { outputTokensOf, turnEdgeOf } from '../../capture';
import { basename, summaryOf, targetOf, toolUseId } from './ToolChip';
import { formatDuration } from '../../lib/duration';

export type WorkingStep =
  /** Sent, not in the transcript yet. */
  | { kind: 'sending' }
  /** One tool call without a result: what its chip shows. */
  | { kind: 'tool'; name: string; target: string | null; summary: string | null }
  /** A subagent running: the Agent call's description. */
  | { kind: 'agent'; description: string | null }
  /** Several calls without a result; `agents` when every one is a subagent. */
  | { kind: 'tools'; count: number; agents: boolean }
  /** A result or the prompt is in, and no reply after it. */
  | { kind: 'thinking' }
  /** Busy, and the rows say no more than that. */
  | { kind: 'working' };

export interface TurnTotals {
  /** The turn's first row, ms. */
  startedAt: number;
  /** `output_tokens` over the turn's assistant messages, once per message id. */
  outputTokens: number;
}

export interface Working {
  step: WorkingStep;
  /** When the step began, ms; 0 when unknown. */
  since: number;
  /** Null when the turn's start is not among the rows. */
  turn: TurnTotals | null;
}

/** The tool names a subagent runs under: `Agent` now, `Task` before. */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/**
 * The working line's state over `messages`, in the pane's order.
 *
 * - `sending`: a message is on its way and no turn is running; it counts
 *   from `echoAt`.
 * - `complete`: the rows reach back to the start of the conversation, so a
 *   first row with no turn end before it is a turn's start, not the middle
 *   of one whose beginning is not loaded.
 *
 * The turn starts at the latest typed prompt, or at the first user row after
 * the latest turn end, whichever is later: a turn Claude Code starts from
 * its own queue opens with a meta line, which is no typed prompt, while a
 * meta line inside a turn (a skill's text) is not after a turn end. With
 * neither among the rows the totals are unknown.
 */
export function workingState(
  messages: readonly Message[],
  opts: { sending: boolean; echoAt: number | null; complete: boolean },
): Working {
  const main = messages.filter((m) => m.agentId === null);

  // Rows after the latest turn end: the turn running now, or the start of it.
  let endAt = -1;
  for (let i = main.length - 1; i >= 0; i--) {
    if (turnEdgeOf((main[i] as Message).rawJson) === 'end') {
      endAt = i;
      break;
    }
  }
  const current = main.slice(endAt + 1);
  const turn = turnTotals(main, endAt, opts.complete);

  if (opts.sending) return { step: { kind: 'sending' }, since: opts.echoAt ?? 0, turn };

  const answered = new Set<string>();
  for (const m of current) {
    if (m.role !== 'tool_result') continue;
    const id = toolUseId(m);
    if (id !== null) answered.add(id);
  }
  const open = current.filter((m) => {
    if (m.role !== 'tool_use') return false;
    const id = toolUseId(m);
    return id !== null && !answered.has(id);
  });

  const last = main[main.length - 1];
  const lastTs = last?.ts ?? 0;
  if (open.length === 1) {
    const call = open[0] as Message;
    const step: WorkingStep = AGENT_TOOLS.has(call.toolName ?? '')
      ? { kind: 'agent', description: summaryOf(call) }
      : { kind: 'tool', name: call.toolName ?? 'Tool', target: targetOf(call), summary: summaryOf(call) };
    return { step, since: call.ts, turn };
  }
  if (open.length > 1) {
    const agents = open.every((m) => AGENT_TOOLS.has(m.toolName ?? ''));
    // The step began when the first of them was asked for.
    const since = Math.min(...open.map((m) => m.ts));
    return { step: { kind: 'tools', count: open.length, agents }, since, turn };
  }
  if (current.length > 0 && last && (last.role === 'tool_result' || last.role === 'user')) {
    return { step: { kind: 'thinking' }, since: last.ts, turn };
  }
  return { step: { kind: 'working' }, since: lastTs, turn };
}

function turnTotals(main: readonly Message[], endAt: number, complete: boolean): TurnTotals | null {
  // The first user row after the latest end; with no end loaded, only when
  // the rows start at the conversation's beginning.
  let start = -1;
  if (endAt >= 0 || complete) {
    start = main.findIndex((m, i) => i > endAt && m.role === 'user');
  }
  // A prompt before the latest end began a turn that is over.
  for (let i = main.length - 1; i > Math.max(start, endAt); i--) {
    if (turnEdgeOf((main[i] as Message).rawJson) === 'prompt') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  // Each message id once: every content block's line repeats its usage. The
  // largest figure wins, in case a block's line was written mid-stream.
  const byId = new Map<string, number>();
  for (let i = start; i < main.length; i++) {
    const m = main[i] as Message;
    if (m.role !== 'assistant' && m.role !== 'tool_use') continue;
    const usage = outputTokensOf(m.rawJson);
    if (usage) byId.set(usage.messageId, Math.max(byId.get(usage.messageId) ?? 0, usage.outputTokens));
  }
  let outputTokens = 0;
  for (const n of byId.values()) outputTokens += n;
  return { startedAt: (main[start] as Message).ts, outputTokens };
}

/** The step in words, before its detail: "Running", "Agent", "Thinking"... */
export function stepLabel(step: WorkingStep): string {
  switch (step.kind) {
    case 'sending':
      return 'Sending';
    case 'tool':
      return 'Running';
    case 'agent':
      return 'Agent';
    case 'tools':
      return `Running ${step.count} ${step.agents ? 'agents' : 'tools'}`;
    case 'thinking':
      return 'Thinking';
    case 'working':
      return 'Working';
    default: {
      const unhandled: never = step;
      return unhandled;
    }
  }
}

/** The step's detail as one line of text, or null: what a chip head reads. */
export function stepDetail(step: WorkingStep): string | null {
  if (step.kind === 'agent') return step.description || null;
  if (step.kind !== 'tool') return null;
  return [step.name, step.target ? basename(step.target) : null, step.summary].filter((s) => s).join(' ');
}

/** "↓ 37.6k tokens", as Claude Code counts them. */
export function formatOutputTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  // Rounded to a tenth first, so 999,960 reads 1m rather than 1000k.
  const short =
    v < 1000
      ? String(v)
      : Math.round(v / 100) < 10_000
        ? `${trimZero((v / 1000).toFixed(1))}k`
        : `${trimZero((v / 1_000_000).toFixed(1))}m`;
  return `↓ ${short} ${v === 1 ? 'token' : 'tokens'}`;
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** "7m 48s · ↓ 37.6k tokens": the turn's totals at `now`. */
export function formatTurnTotals(turn: TurnTotals, now: number): string {
  return `${formatDuration(now - turn.startedAt)} · ${formatOutputTokens(turn.outputTokens)}`;
}
