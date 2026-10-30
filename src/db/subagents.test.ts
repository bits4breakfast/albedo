import { describe, expect, it } from 'vitest';
import { buildRuns, labelFrom, liveRuns, marksByAgent, selfResumeAfter } from './subagents';
import { RUNNING_WINDOW_MS } from '../capture/status';
import { parseLine } from '../capture/adapter';
import {
  agentNotification,
  noticeAttachmentLine,
  sendMessageResume,
  systemNoticeUserLine,
} from '../capture/backgroundFixtures';

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

// --- #139: resumed, and waiting on its own background work -----------------

/** Parent lines as the rows SUBAGENT_MARKS_SQL returns. */
const markRows = (lines: Record<string, unknown>[], ts: number) =>
  lines.flatMap((l, i) => parseLine(JSON.stringify(l), i).map((m) => ({ ts, seq: m.seq, role: m.role, raw_json: m.rawJson })));
const waitingAt = (agentId: string, ts: number) =>
  markRows([systemNoticeUserLine(agentNotification({ agentId, waiting: true }), ts)], ts);
const finishedAt = (agentId: string, ts: number) =>
  markRows([noticeAttachmentLine(agentNotification({ agentId }), ts)], ts);
const resumedAt = (agentId: string, ts: number) => markRows(sendMessageResume('sm', agentId, ts).slice(1), ts);
/** A hand-back: a tool result, which reads as activity for RUNNING_WINDOW_MS. */
const handBack = (agentId: string, ts: number) => tail(agentId, 50, 'tool_result', ts, 'ok');

describe('buildRuns: a subagent stopped, resumed, or waiting on its own work (#139)', () => {
  const DAY = 24 * 3_600_000;
  const spawned = now - 14 * DAY;

  it('reads "waiting on its own background work" as not running, even right after its last row', () => {
    const last = now - 3_000;
    const runs = buildRuns([agg('a1', 40, spawned, last)], [handBack('a1', last)], [], {
      marks: marksByAgent(waitingAt('a1', now - 1_000)),
      now,
    });
    expect(runs[0]).toMatchObject({ status: 'idle', waiting: true, expiresAt: null });
    expect(liveRuns(runs)).toEqual([]);
  });

  it('reads a plain completion as finished at once, not Running for the window', () => {
    const last = now - 3_000;
    // Without the notification, the hand-back alone reads as activity.
    expect(buildRuns([agg('a1', 40, spawned, last)], [handBack('a1', last)], [], { now })[0]?.status).toBe('running');
    const runs = buildRuns([agg('a1', 40, spawned, last)], [handBack('a1', last)], [], {
      marks: marksByAgent(finishedAt('a1', now - 1_000)),
      now,
    });
    expect(runs[0]).toMatchObject({ status: 'idle', waiting: false });
  });

  it('is Running again once it goes on by itself, counting from that resume', () => {
    const stop = now - 60_000;
    const resumed = now - 20_000;
    const runs = buildRuns(
      [agg('a1', 50, spawned, now - 1_000)],
      [tail('a1', 60, 'user', resumed, 'its monitor reported'), tail('a1', 61, 'tool_result', now - 1_000, 'ok')],
      [],
      { marks: marksByAgent(waitingAt('a1', stop)), selfResumedAt: new Map([['a1', resumed]]), now },
    );
    expect(runs[0]).toMatchObject({ status: 'running', waiting: false, runStartTs: resumed });
    expect(runs[0]?.expiresAt).toBe(now - 1_000 + RUNNING_WINDOW_MS + 1);
  });

  it('goes back to waiting when it falls quiet again before the next notification', () => {
    const stop = now - 10 * 60_000;
    const runs = buildRuns(
      [agg('a1', 50, spawned, now - 5 * 60_000)],
      [tail('a1', 61, 'tool_result', now - 5 * 60_000, 'ok')],
      [],
      { marks: marksByAgent(waitingAt('a1', stop)), now },
    );
    expect(runs[0]).toMatchObject({ status: 'idle', waiting: true });
  });

  it('a SendMessage after the stop resumes it: Running, timed from the resume', () => {
    const stop = now - 5 * DAY;
    const resume = now - 30_000;
    const runs = buildRuns(
      [agg('a1', 90, spawned, now - 2_000)],
      [tail('a1', 80, 'user', resume, 'Carry on'), tail('a1', 81, 'tool_result', now - 2_000, 'ok')],
      [],
      { marks: marksByAgent([...waitingAt('a1', stop), ...resumedAt('a1', resume)]), now },
    );
    expect(runs[0]).toMatchObject({ status: 'running', waiting: false, runStartTs: resume });
  });

  it('a later plain completion makes a waiting agent Finished', () => {
    const last = now - 60_000;
    const runs = buildRuns([agg('a1', 90, spawned, last)], [handBack('a1', last)], [], {
      marks: marksByAgent([...waitingAt('a1', now - 10 * 60_000), ...finishedAt('a1', last + 500)]),
      now,
    });
    expect(runs[0]).toMatchObject({ status: 'idle', waiting: false });
  });

  it('keeps marks to the agent they name', () => {
    const runs = buildRuns(
      [agg('a1', 2, now - 2_000, now - 1_000), agg('a2', 2, now - 2_000, now - 1_000)],
      [handBack('a1', now - 1_000), handBack('a2', now - 1_000)],
      [],
      { marks: marksByAgent(waitingAt('a2', now - 500)), now },
    );
    expect(runs.map((r) => [r.agentId, r.status, r.waiting])).toEqual([
      ['a1', 'running', false],
      ['a2', 'idle', true],
    ]);
  });
});

describe('selfResumeAfter', () => {
  it('is the latest stop before the newest row, unless SendMessage came after it', () => {
    expect(selfResumeAfter(undefined, 100)).toBeNull();
    expect(selfResumeAfter({ resumedAt: null, stops: [{ ts: 10, waiting: true }, { ts: 50, waiting: true }] }, 100)).toBe(50);
    // Stopped after its newest row: at rest, nothing to look up.
    expect(selfResumeAfter({ resumedAt: null, stops: [{ ts: 120, waiting: true }] }, 100)).toBeNull();
    expect(selfResumeAfter({ resumedAt: 60, stops: [{ ts: 50, waiting: true }] }, 100)).toBeNull();
  });
});
