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
import { listSubagents, liveRuns } from './subagents';
import { parseLine } from '../capture/adapter';
import {
  agentNotification,
  asyncAgent,
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
