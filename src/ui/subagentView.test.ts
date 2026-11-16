import { describe, expect, it } from 'vitest';
import {
  agentActivity,
  agentLabel,
  agentState,
  agentTitle,
  agentTokens,
  agentStatusDetail,
  agentStatusWord,
  COLLAPSE_AFTER,
  elapsedMs,
  formatElapsed,
  nextExpiry,
  shouldCollapse,
  spokenElapsed,
  stripRuns,
  stripSummary,
} from './subagentView';
import type { SubagentRun } from '../db/subagents';
import type { Message } from '../types';

const run = (o: Partial<SubagentRun> & Pick<SubagentRun, 'agentId'>): SubagentRun => ({
  label: null,
  prompt: null,
  name: null,
  kind: null,
  lastCall: null,
  tokens: null,
  status: 'idle',
  waiting: false,
  firstTs: 0,
  lastTs: 0,
  runStartTs: 0,
  messages: 1,
  expiresAt: null,
  ...o,
});

describe('formatElapsed', () => {
  it('reads seconds, then minutes, then hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_400)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m 05s');
    expect(formatElapsed(3_725_000)).toBe('1h 02m');
  });

  it('never shows a negative or NaN clock', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });
});

describe('spokenElapsed', () => {
  it('spells units out, singular where it should be', () => {
    expect(spokenElapsed(1_000)).toBe('1 second');
    expect(spokenElapsed(185_000)).toBe('3 minutes 5 seconds');
    expect(spokenElapsed(60_000)).toBe('1 minute');
    expect(spokenElapsed(3_600_000)).toBe('1 hour');
  });
});

describe('elapsedMs', () => {
  it('counts a live agent up to now', () => {
    expect(elapsedMs({ runStartTs: 1_000, lastTs: 5_000, status: 'running' }, 9_000)).toBe(8_000);
  });

  it('stops a finished agent at its last row', () => {
    expect(elapsedMs({ runStartTs: 1_000, lastTs: 5_000, status: 'idle' }, 9_000)).toBe(4_000);
  });

  it('does not run backwards when the clock lags the newest row', () => {
    expect(elapsedMs({ runStartTs: 1_000, lastTs: 5_000, status: 'running' }, 2_000)).toBe(4_000);
  });

  it('counts the current run, not the time since the agent was first spawned (#139)', () => {
    const day = 24 * 3_600_000;
    // Spawned two weeks ago, resumed a minute ago, still at it.
    const resumed = { firstTs: 0, runStartTs: 14 * day, lastTs: 14 * day + 50_000, status: 'running' as const };
    expect(formatElapsed(elapsedMs(resumed, 14 * day + 60_000))).toBe('1m 00s');
  });

  it('does not count up for an agent waiting on its own background work', () => {
    const w = { runStartTs: 1_000, lastTs: 5_000, status: 'idle' as const };
    expect(elapsedMs(w, 9_000)).toBe(elapsedMs(w, 900_000));
  });
});

describe('collapse', () => {
  it('keeps every row up to the threshold and folds past it', () => {
    expect(shouldCollapse(COLLAPSE_AFTER)).toBe(false);
    expect(shouldCollapse(COLLAPSE_AFTER + 1)).toBe(true);
  });

  it('names agents waiting on background work after the running count, never in it', () => {
    expect(stripSummary([{ status: 'running' }], 1)).toBe('1 Agent Running · 1 In Background');
    expect(stripSummary([{ status: 'running' }, { status: 'blocked' }], 2)).toBe('2 Agents Running · 1 Needs You · 2 In Background');
  });

  it('lists waiting agents after the live ones, and never opens the strip for them alone', () => {
    const live = run({ agentId: 'live', status: 'running' });
    const waiting = run({ agentId: 'wait', waiting: true });
    const done = run({ agentId: 'done' });
    expect(stripRuns([waiting, done, live])).toEqual({ live: [live], waiting: [waiting] });
    expect(stripRuns([waiting, done])).toEqual({ live: [], waiting: [] });
  });

  it('summarises, calling out only what needs you', () => {
    expect(stripSummary([{ status: 'running' }])).toBe('1 Agent Running');
    expect(stripSummary([{ status: 'running' }, { status: 'running' }])).toBe('2 Agents Running');
    expect(stripSummary([{ status: 'running' }, { status: 'blocked' }])).toBe('2 Agents Running · 1 Needs You');
    expect(stripSummary([{ status: 'blocked' }, { status: 'blocked' }])).toBe('2 Agents Running · 2 Need You');
  });
});

describe('labels', () => {
  it('says "Running", not "waiting", for a running agent', () => {
    expect(agentStatusWord({ status: 'running', waiting: false })).toBe('Running');
    expect(agentStatusWord({ status: 'blocked', waiting: false })).toBe('Needs You');
    expect(agentStatusWord({ status: 'idle', waiting: false })).toBe('Finished');
  });

  it('calls an agent waiting on its own background work "In Background", and spells it out', () => {
    const w = { status: 'idle' as const, waiting: true };
    expect(agentState(w)).toBe('waiting');
    expect(agentStatusWord(w)).toBe('In Background');
    expect(agentStatusDetail(w)).toMatch(/^Waiting on its own background work/);
    // The flag never outranks work: a resumed agent is Running.
    expect(agentStatusWord({ status: 'running', waiting: true })).toBe('Running');
  });

  it('falls back to a short id for an agent that has not spoken', () => {
    expect(agentLabel({ label: null, agentId: 'a1b2c3d4e5f6' })).toBe('Agent a1b2c3d4');
    expect(agentLabel({ label: 'Review the diff', agentId: 'x' })).toBe('Review the diff');
  });
});

describe('nextExpiry', () => {
  it('is the earliest moment any status goes stale', () => {
    expect(nextExpiry([])).toBeNull();
    expect(nextExpiry([{ expiresAt: null }, { expiresAt: 9_000 }, { expiresAt: 5_000 }])).toBe(5_000);
  });
});

/** A tool call row as the strip reads it from the agent's transcript. */
const call = (toolName: string, input: Record<string, unknown>, targetPath: string | null = null): Message => ({
  id: 0,
  taskId: null,
  sessionId: 's',
  seq: 100,
  role: 'tool_use',
  toolName,
  targetPath,
  body: null,
  rawJson: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: toolName, input }] } }),
  agentId: 'a',
  ts: 0,
});

describe('agentTitle (#377)', () => {
  it('is the name the Agent call gave, and the prompt line without one', () => {
    expect(agentTitle({ name: 'Build #365 polling', label: 'Fix GitHub issue #365', agentId: 'a' })).toBe('Build #365 polling');
    expect(agentTitle({ name: null, label: 'Fix GitHub issue #365', agentId: 'a' })).toBe('Fix GitHub issue #365');
    expect(agentTitle({ name: null, label: null, agentId: 'a1b2c3d4e5f6' })).toBe('Agent a1b2c3d4');
  });
});

describe('agentActivity (#377)', () => {
  const at = (lastCall: Message | null, o: Partial<SubagentRun> = {}) => agentActivity(run({ agentId: 'a', status: 'running', lastCall, ...o }));

  it('reads a command as its description, as the terminal does', () => {
    expect(at(call('Bash', { command: 'npx vitest run --reporter json', description: 'Running vitest JSON reporter for totals' }))).toBe(
      'Running vitest JSON reporter for totals',
    );
  });

  it('reads a command without a description as its row does', () => {
    expect(at(call('Bash', { command: 'git status' }))).toBe('Bash git status');
  });

  it('reads any other call in the words of its transcript row', () => {
    expect(at(call('Read', { file_path: '/w/src/ui/app/useLayout.ts' }, '/w/src/ui/app/useLayout.ts'))).toBe('Read useLayout.ts');
    expect(at(call('Grep', { pattern: 'listSubagents', glob: 'src/**' }))).toBe('Grep /listSubagents/ in src/**');
    expect(at(call('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }, '/w/a.ts'))).toBe('Edit a.ts');
    expect(at(call('mcp__x__y', {}))).toBe('mcp__x__y');
  });

  it('says Starting… for an agent at work before its first call, and nothing for one that stopped', () => {
    expect(at(null)).toBe('Starting…');
    expect(at(null, { status: 'blocked' })).toBe('Starting…');
    expect(at(null, { status: 'idle' })).toBe('');
    expect(at(null, { status: 'idle', waiting: true })).toBe('');
  });

  it('still says what an agent waiting on its own work last did', () => {
    expect(at(call('Bash', { command: 'sleep 1', description: 'Wait for CI' }), { status: 'idle', waiting: true })).toBe('Wait for CI');
  });
});

describe('agentTokens (#377)', () => {
  it('reads the count as the terminal shortens it, and nothing without one', () => {
    expect(agentTokens({ tokens: 345_212 })).toBe('345.2k tokens');
    expect(agentTokens({ tokens: null })).toBeNull();
    expect(agentTokens({ tokens: 1 })).toBe('1 token');
  });
});
