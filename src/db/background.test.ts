/**
 * `backgroundRowsSince` on a real SQLite (#122): the rows the background
 * fold needs, from the task's session, written since its pty was spawned,
 * with both halves of every start -- also the ones only one half of which
 * the SQL can preselect.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { backgroundRowsSince, insertMessages, resetDb } from './index';
import { parseLine } from '../capture/adapter';
import { runningInBackground } from '../capture/background';
import { asyncAgent, backgroundShell, callLine, noticeAttachmentLine, notification, resultLine, wakeup } from '../capture/backgroundFixtures';

const SPAWNED = Date.parse('2026-10-28T10:00:00.000Z');
const NOW = SPAWNED + 60_000;

let db: TestDb;
let line = 0;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

async function seed(lines: Record<string, unknown>[], sessionId = 's1', agentId: string | null = null): Promise<void> {
  await insertMessages(
    lines.flatMap((l) => parseLine(JSON.stringify({ ...l, sessionId }), line++).map((m) => ({ ...m, agentId, taskId: 1 }))),
  );
}

const running = async (since = SPAWNED) => runningInBackground(await backgroundRowsSince('s1', since), since, NOW).map((i) => [i.kind, i.description]);

describe('backgroundRowsSince', () => {
  it('finds a background shell, and its end delivered into a turn', async () => {
    await seed(backgroundShell('t1', 'b1', SPAWNED + 1_000));
    expect(await running()).toEqual([['shell', 'Poll CI until green']]);
    await seed([noticeAttachmentLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), SPAWNED + 5_000)]);
    expect(await running()).toEqual([]);
  });

  it('fetches the call of an agent async by default, which has no flag to preselect', async () => {
    await seed(asyncAgent('g1', 'a1', SPAWNED + 1_000));
    expect(await running()).toEqual([['agent', 'Review the diff for regressions']]);
  });

  it('fetches the call of a shell moved to the background by its timeout', async () => {
    await seed([
      callLine('t1', 'Bash', { command: 'npm test', description: 'Run the test suite' }, SPAWNED + 1_000),
      resultLine('t1', { backgroundTaskId: 'b1', timedOutAfterMs: 120_000 }, SPAWNED + 121_000),
    ]);
    expect(await running()).toEqual([['shell', 'Run the test suite']]);
  });

  it('reads nothing from before the spawn, another session, or a subagent', async () => {
    await seed(backgroundShell('t0', 'b0', SPAWNED - 5_000));
    await seed(backgroundShell('t1', 'b1', SPAWNED + 1_000), 's2');
    await seed(wakeup('w1', SPAWNED + 1_000, 600), 's1', 'agent-1');
    expect(await backgroundRowsSince('s1', SPAWNED)).toEqual([]);
  });

  it('returns rows oldest first, ready for the fold', async () => {
    await seed([...wakeup('w1', SPAWNED + 2_000, 600), ...backgroundShell('t1', 'b1', SPAWNED + 1_000)]);
    const rows = await backgroundRowsSince('s1', SPAWNED);
    expect(rows.map((r) => r.ts)).toEqual([...rows.map((r) => r.ts)].sort((a, b) => a - b));
    expect(await running()).toEqual([
      ['shell', 'Poll CI until green'],
      ['wakeup', 'Timer: wait 5 minutes before the next check'],
    ]);
  });
});
