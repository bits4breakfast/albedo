import { describe, expect, it } from 'vitest';
import { buildRuns, labelFrom, liveRuns } from './subagents';
import { RUNNING_WINDOW_MS } from '../capture/status';

const now = Date.now();
const agg = (agent_id: string, n: number, first_ts: number, last_ts: number) => ({
  agent_id,
  n,
  first_ts,
  last_ts,
});
const tail = (
  agent_id: string,
  seq: number,
  role: string,
  ts: number,
  body: string | null = null,
  raw: Record<string, unknown> = {},
) => ({ agent_id, seq, role, ts, body, raw_json: JSON.stringify({ agentId: agent_id, ...raw }) });

describe('labelFrom', () => {
  it('takes the first non-empty line', () => {
    expect(labelFrom('\n\n  Review the diff  \nand report')).toBe('Review the diff');
  });

  it('truncates rather than letting a prompt run across the strip', () => {
    expect(labelFrom('x'.repeat(200))).toHaveLength(60);
    expect(labelFrom('x'.repeat(200))?.endsWith('…')).toBe(true);
  });

  it('returns null for nothing usable', () => {
    expect(labelFrom(null)).toBeNull();
    expect(labelFrom('   \n  ')).toBeNull();
  });
});

describe('buildRuns', () => {
  it('groups a session’s rows by the agent that wrote them', () => {
    const runs = buildRuns(
      [agg('aaa', 12, 1_000, now), agg('bbb', 3, 2_000, now)],
      [
        tail('aaa', 0, 'user', 1_000, 'Review the backend diff'),
        tail('aaa', 100, 'assistant', now, null, { message: { stop_reason: 'end_turn' } }),
        tail('bbb', 0, 'user', 2_000, 'Check the CSS contrast'),
      ],
    );
    expect(runs.map((r) => r.agentId)).toEqual(['aaa', 'bbb']);
    expect(runs[0]?.label).toBe('Review the backend diff');
    expect(runs[1]?.label).toBe('Check the CSS contrast');
    expect(runs[0]?.messages).toBe(12);
  });

  it('labels from the OPENING prompt, not whatever arrived last', () => {
    // The tail query returns newest-first, so taking rows[0] would label every
    // agent with its most recent line instead of what it was asked to do.
    const runs = buildRuns(
      [agg('aaa', 2, 1_000, 5_000)],
      [
        tail('aaa', 500, 'user', 5_000, 'a much later tool result'),
        tail('aaa', 0, 'user', 1_000, 'the original assignment'),
      ],
    );
    expect(runs[0]?.label).toBe('the original assignment');
  });

  it('reads an unanswered trailing tool_use as running, not blocked', () => {
    // A tool that is still executing has no result yet; so does a permission
    // prompt, and the transcript cannot tell them apart. Prompts are reported
    // at the task level (hook events), so here it is work in progress.
    const runs = buildRuns(
      [agg('aaa', 2, now - 1_000, now)],
      [
        tail('aaa', 0, 'user', now - 1_000, 'go'),
        tail('aaa', 100, 'tool_use', now, null, {
          message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
        }),
      ],
    );
    expect(runs[0]?.status).toBe('running');
  });

  it('survives an agent with aggregates but no tail rows', () => {
    // The tail is capped, so a long-idle agent can fall out of it entirely.
    const runs = buildRuns([agg('old', 900, 1, 2)], []);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.label).toBeNull();
    expect(runs[0]?.messages).toBe(900);
  });
});

describe('liveRuns', () => {
  it('keeps only what is still working or waiting', () => {
    const runs = buildRuns(
      [agg('run', 1, now, now), agg('done', 1, 1, 1), agg('stuck', 1, now, now)],
      [
        tail('run', 0, 'user', now, 'working'),
        tail('done', 0, 'assistant', now - RUNNING_WINDOW_MS * 2, null, {
          message: { stop_reason: 'end_turn' },
        }),
        tail('stuck', 100, 'tool_use', now, null, {
          message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
        }),
      ],
    );
    expect(liveRuns(runs).map((r) => r.agentId).sort()).toEqual(['run', 'stuck']);
  });
});
