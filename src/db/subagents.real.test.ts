/**
 * `listSubagents` on a real SQLite (#139): an async agent spawned long ago,
 * resumed by `SendMessage`, stopped while its own background work runs, gone
 * on by itself, and finished -- read through the shipped queries, as the
 * Agents strip and the task list read it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { insertMessages, resetDb } from './index';
import {
  __resetAgentNames,
  listSubagents,
  liveRuns,
  SPAWN_LEAD_MS,
  SPAWN_WINDOW_LINES,
  SUBAGENT_CALLS_SQL,
  SUBAGENT_LATEST_SQL,
  SUBAGENT_SPAWN_SQL,
} from './subagents';
import { parseLine } from '../capture/adapter';
import {
  agentNotification,
  asyncAgent,
  callLine,
  iso,
  noticeAttachmentLine,
  notification,
  resultLine,
  sendMessageResume,
  systemNoticeUserLine,
} from '../capture/backgroundFixtures';

const DAY = 24 * 3_600_000;

let db: TestDb;
let line = 0;

beforeEach(() => {
  resetDb();
  __resetAgentNames();
  db = createTestDb();
  harness.db = db;
});

async function seed(lines: Record<string, unknown>[], agentId: string | null = null): Promise<void> {
  await insertMessages(
    lines.flatMap((l) => parseLine(JSON.stringify({ ...l, sessionId: 's1' }), line++).map((m) => ({ ...m, agentId, taskId: 1 }))),
  );
}

/** The agent's own lines: a prompt, then a hand-back (a tool result). */
const own = (ts: number, text: string): Record<string, unknown>[] => [
  { type: 'user', isSidechain: true, timestamp: iso(ts), uuid: `u-${ts}`, message: { role: 'user', content: text } },
  { ...resultLine(`h-${ts}`, { success: true }, ts + 1_000), isSidechain: true },
];

describe('listSubagents across resumes (#139)', () => {
  it('times the current run, and reads "waiting on its own background work" as not running', async () => {
    const now = Date.now();
    const spawned = now - 14 * DAY;
    await seed(asyncAgent('g1', 'ag1', spawned));
    await seed(own(spawned + 100, 'Review the diff for regressions'), 'ag1');
    await seed([noticeAttachmentLine(agentNotification({ agentId: 'ag1', toolUseId: 'g1' }), spawned + 2_000)]);

    // Resumed a few minutes ago; it handed back, then said it is waiting.
    const resume = now - 5 * 60_000;
    await seed(sendMessageResume('sm1', 'ag1', resume));
    await seed(own(resume + 100, 'Carry on with the second half'), 'ag1');
    await seed([systemNoticeUserLine(agentNotification({ agentId: 'ag1', waiting: true }), resume + 2_000)]);
    // Unrelated work in the same session is not read as the agent's.
    await seed([noticeAttachmentLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), resume + 3_000)]);

    let [run] = await listSubagents('s1');
    expect(run).toMatchObject({ agentId: 'ag1', status: 'idle', waiting: true, runStartTs: resume + 50 });
    expect(run?.firstTs).toBe(spawned + 100);
    expect(liveRuns(await listSubagents('s1'))).toEqual([]);

    // Its own work reported and it went on by itself: Running, from then.
    const self = now - 10_000;
    await seed(own(self, 'Your monitor reported'), 'ag1');
    [run] = await listSubagents('s1');
    expect(run).toMatchObject({ status: 'running', waiting: false, runStartTs: self });

    // A plain completion: Finished.
    await seed([systemNoticeUserLine(agentNotification({ agentId: 'ag1' }), self + 2_000)]);
    [run] = await listSubagents('s1');
    expect(run).toMatchObject({ status: 'idle', waiting: false, runStartTs: self });
  });
});

/** One of the agent's own assistant lines: a tool call, with the usage Claude Code writes on it. */
const agentCall = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  ts: number,
  usage: Record<string, number> | null = { input_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000, output_tokens: 400 },
): Record<string, unknown> => {
  const line = callLine(id, name, input, ts, { isSidechain: true });
  const message = line['message'] as Record<string, unknown>;
  return { ...line, message: { ...message, id: `msg-${id}`, ...(usage ? { usage } : {}) } };
};

describe('listSubagents with detail: name, doing now, tokens (#377)', () => {
  it('names an agent by its Agent call and says what it is doing now, with its tokens', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 60_000, 'Build #365 polling'));
    await seed(own(now - 59_000, 'Fix GitHub issue #365 in example/repo.\nYour worktree: /tmp/w'), 'ag1');
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/w/src/useLayout.ts' }, now - 30_000)], 'ag1');
    await seed(
      [
        agentCall('c2', 'Bash', { command: 'npx vitest run --reporter json', description: 'Running vitest JSON reporter for totals' }, now - 2_000, {
          input_tokens: 5,
          cache_read_input_tokens: 300_000,
          cache_creation_input_tokens: 44_000,
          output_tokens: 1_000,
        }),
      ],
      'ag1',
    );

    const [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({
      agentId: 'ag1',
      status: 'running',
      name: 'Build #365 polling',
      kind: 'general-purpose',
      label: 'Fix GitHub issue #365 in example/repo.',
      prompt: 'Fix GitHub issue #365 in example/repo.\nYour worktree: /tmp/w',
      tokens: 5 + 300_000 + 44_000 + 1_000,
    });
    expect(run?.lastCall).toMatchObject({ toolName: 'Bash', agentId: 'ag1' });
  });

  it('without detail, as the task list reads it, adds nothing and reads no more than before', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 60_000));
    await seed(own(now - 59_000, 'Review it'), 'ag1');
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 1_000)], 'ag1');
    const select = vi.spyOn(db, 'select');
    const [run] = await listSubagents('s1');
    expect(run).toMatchObject({ status: 'running', name: null, kind: null, lastCall: null, tokens: null, prompt: 'Review it' });
    // The aggregate, then tail, openings and marks: as before #377.
    expect(select).toHaveBeenCalledTimes(4);
  });

  it('reads nothing for a session without agents', async () => {
    await seed([callLine('b1', 'Bash', { command: 'ls' }, Date.now())]);
    const select = vi.spyOn(db, 'select');
    expect(await listSubagents('s1', { detail: true })).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('looks a name up once: later reads ask nothing about names', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 60_000, 'Review PR #375'));
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 1_000)], 'ag1');
    expect((await listSubagents('s1', { detail: true }))[0]?.name).toBe('Review PR #375');
    const select = vi.spyOn(db, 'select');
    expect((await listSubagents('s1', { detail: true }))[0]?.name).toBe('Review PR #375');
    const sqls = select.mock.calls.map((c) => String(c[0]));
    expect(sqls).not.toContain(SUBAGENT_CALLS_SQL);
    expect(sqls).not.toContain(SUBAGENT_SPAWN_SQL);
  });

  it('names an agent whose launch result is stored after its own first rows', async () => {
    const now = Date.now();
    const [call, result] = asyncAgent('g1', 'ag1', now - 60_000, 'Late result');
    await seed([call!]);
    await seed([agentCall('c1', 'Grep', { pattern: 'listSubagents', glob: 'src/**' }, now - 1_000)], 'ag1');
    let [run] = await listSubagents('s1', { detail: true });
    expect(run?.name).toBeNull();
    await seed([result!]);
    [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({ name: 'Late result', kind: 'general-purpose' });
  });

  it('names agents started together by one message, each by its own call', async () => {
    const now = Date.now();
    const both = {
      ...callLine('x', 'Agent', {}, now - 60_000),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'g1', name: 'Agent', input: { description: 'First', subagent_type: 'Explore' } },
          { type: 'tool_use', id: 'g2', name: 'Agent', input: { description: 'Second', subagent_type: 'Plan' } },
        ],
      },
    };
    await seed([both]);
    await seed([resultLine('g2', { isAsync: true, agentId: 'ag2' }, now - 59_900), resultLine('g1', { isAsync: true, agentId: 'ag1' }, now - 59_800)]);
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 2_000)], 'ag1');
    await seed([agentCall('c2', 'Read', { file_path: '/tmp/b.ts' }, now - 1_000)], 'ag2');
    const runs = await listSubagents('s1', { detail: true });
    expect(Object.fromEntries(runs.map((r) => [r.agentId, [r.name, r.kind]]))).toEqual({
      ag1: ['First', 'Explore'],
      ag2: ['Second', 'Plan'],
    });
  });

  it('stops looking for a result once the parent has written past the window without one', async () => {
    const now = Date.now();
    const [call] = asyncAgent('g1', 'ag1', now - 60_000);
    await seed([call!]);
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 1_000)], 'ag1');
    await listSubagents('s1', { detail: true });
    line += SPAWN_WINDOW_LINES + 1;
    await seed([callLine('b1', 'Bash', { command: 'ls' }, now - 500)]);
    await listSubagents('s1', { detail: true });
    const select = vi.spyOn(db, 'select');
    await listSubagents('s1', { detail: true });
    const sqls = select.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain(SUBAGENT_CALLS_SQL);
    expect(sqls).not.toContain(SUBAGENT_SPAWN_SQL);
  });

  it('starts with no call: no doing-now, and tokens from its newest usage record', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 5_000, 'Just started'));
    await seed([{ type: 'user', isSidechain: true, timestamp: iso(now - 4_000), uuid: 'u1', message: { role: 'user', content: 'Go' } }], 'ag1');
    let [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({ status: 'running', name: 'Just started', lastCall: null, tokens: null });

    // A line without usage after one with it: the newest usage record counts.
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 3_000)], 'ag1');
    await seed([agentCall('c2', 'Glob', { pattern: '**/*.ts' }, now - 2_000, null)], 'ag1');
    [run] = await listSubagents('s1', { detail: true });
    expect(run?.tokens).toBe(3 + 90_000 + 2_000 + 400);
    expect(run?.lastCall?.toolName).toBe('Glob');
  });

  it('reads the newest call by file order, not by clock', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 60_000));
    // Written later in the file, with an earlier timestamp.
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/first.ts' }, now - 1_000)], 'ag1');
    await seed([agentCall('c2', 'Read', { file_path: '/tmp/second.ts' }, now - 2_000)], 'ag1');
    const [run] = await listSubagents('s1', { detail: true });
    expect(run?.lastCall?.targetPath).toBe('/tmp/second.ts');
  });

  it('gives no detail to an agent the strip does not list', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 60_000, 'Done long ago'));
    await seed(own(now - 59_000, 'Review it'), 'ag1');
    await seed([noticeAttachmentLine(agentNotification({ agentId: 'ag1', toolUseId: 'g1' }), now - 50_000)]);
    const select = vi.spyOn(db, 'select');
    const [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({ status: 'idle', waiting: false, name: null, lastCall: null });
    expect(select).toHaveBeenCalledTimes(4);
  });

  it('keeps the strip when a detail read fails: only that detail is lost', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 60_000, 'Named'));
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 1_000)], 'ag1');
    const real = db.select.bind(db);
    const select = vi.spyOn(db, 'select');

    select.mockImplementation(((q: string, b?: unknown[]) =>
      q === SUBAGENT_LATEST_SQL ? Promise.reject(new Error('disk I/O error')) : real(q, b)) as typeof db.select);
    let [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({ agentId: 'ag1', status: 'running', name: 'Named', lastCall: null, tokens: null });

    __resetAgentNames();
    select.mockImplementation(((q: string, b?: unknown[]) =>
      q === SUBAGENT_CALLS_SQL ? Promise.reject(new Error('disk I/O error')) : real(q, b)) as typeof db.select);
    [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({ agentId: 'ag1', status: 'running', name: null });
    expect(run?.lastCall?.toolName).toBe('Read');
  });

  it('asks only about calls near the agents it lists, not every agent the session ran', async () => {
    const now = Date.now();
    const old = now - 3 * 3_600_000;
    await seed(asyncAgent('g0', 'ag0', old, 'Long done'));
    await seed(own(old + 100, 'Old work'), 'ag0');
    await seed([noticeAttachmentLine(agentNotification({ agentId: 'ag0', toolUseId: 'g0' }), old + 5_000)]);
    await seed(asyncAgent('g1', 'ag1', now - 60_000, 'Now'));
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 1_000)], 'ag1');
    const select = vi.spyOn(db, 'select');
    const runs = await listSubagents('s1', { detail: true });
    expect(runs.find((r) => r.agentId === 'ag1')?.name).toBe('Now');
    expect(select.mock.calls.filter((c) => c[0] === SUBAGENT_SPAWN_SQL)).toHaveLength(1);
    expect(SPAWN_LEAD_MS).toBeLessThan(now - old);
  });

  it('after a resume, says Starting… until its first call of the new run, and keeps its tokens', async () => {
    const now = Date.now();
    await seed(asyncAgent('g1', 'ag1', now - 600_000, 'Resumed one'));
    await seed([agentCall('c1', 'Read', { file_path: '/tmp/a.ts' }, now - 590_000)], 'ag1');
    await seed([noticeAttachmentLine(agentNotification({ agentId: 'ag1', toolUseId: 'g1' }), now - 580_000)]);
    const resume = now - 5_000;
    await seed(sendMessageResume('sm1', 'ag1', resume));
    await seed([{ type: 'user', isSidechain: true, timestamp: iso(resume + 100), uuid: 'u-r', message: { role: 'user', content: 'Carry on' } }], 'ag1');
    let [run] = await listSubagents('s1', { detail: true });
    expect(run).toMatchObject({ status: 'running', lastCall: null, tokens: 3 + 90_000 + 2_000 + 400 });

    await seed([agentCall('c2', 'Glob', { pattern: '*.ts' }, resume + 1_000)], 'ag1');
    [run] = await listSubagents('s1', { detail: true });
    expect(run?.lastCall?.toolName).toBe('Glob');
  });
});
