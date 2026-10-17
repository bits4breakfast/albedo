import { describe, expect, it } from 'vitest';
import {
  agentLabel,
  agentStatusWord,
  COLLAPSE_AFTER,
  elapsedMs,
  formatElapsed,
  shouldCollapse,
  spokenElapsed,
  stripSummary,
} from './subagentView';

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
    expect(elapsedMs({ firstTs: 1_000, lastTs: 5_000, status: 'running' }, 9_000)).toBe(8_000);
  });

  it('stops a finished agent at its last row', () => {
    expect(elapsedMs({ firstTs: 1_000, lastTs: 5_000, status: 'idle' }, 9_000)).toBe(4_000);
  });

  it('does not run backwards when the clock lags the newest row', () => {
    expect(elapsedMs({ firstTs: 1_000, lastTs: 5_000, status: 'running' }, 2_000)).toBe(4_000);
  });
});

describe('collapse', () => {
  it('keeps every row up to the threshold and folds past it', () => {
    expect(shouldCollapse(COLLAPSE_AFTER)).toBe(false);
    expect(shouldCollapse(COLLAPSE_AFTER + 1)).toBe(true);
  });

  it('summarises, calling out only what needs you', () => {
    expect(stripSummary([{ status: 'running' }])).toBe('1 agent running');
    expect(stripSummary([{ status: 'running' }, { status: 'running' }])).toBe('2 agents running');
    expect(stripSummary([{ status: 'running' }, { status: 'blocked' }])).toBe('2 agents running · 1 needs you');
    expect(stripSummary([{ status: 'blocked' }, { status: 'blocked' }])).toBe('2 agents running · 2 need you');
  });
});

describe('labels', () => {
  it('says "Running", not "waiting", for a running agent', () => {
    expect(agentStatusWord('running')).toBe('Running');
    expect(agentStatusWord('blocked')).toBe('Needs you');
    expect(agentStatusWord('idle')).toBe('Finished');
  });

  it('falls back to a short id for an agent that has not spoken', () => {
    expect(agentLabel({ label: null, agentId: 'a1b2c3d4e5f6' })).toBe('Agent a1b2c3d4');
    expect(agentLabel({ label: 'Review the diff', agentId: 'x' })).toBe('Review the diff');
  });
});
