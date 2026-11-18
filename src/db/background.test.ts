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
import { TIMER_RUNS_KEPT } from '../capture/timerRuns';
import { asyncAgent, backgroundShell, callLine, cronTimer, noticeAttachmentLine, notification, resultLine, timerFire, wakeup } from '../capture/backgroundFixtures';

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

  it("fetches each open timer's latest run lines, in one read, however many it has written (#443)", async () => {
    // A `/loop 5m` for four days: 1,150 run lines, more than the first read keeps.
    const first = SPAWNED + 1_000 + 285_000;
    const fires = Array.from({ length: 1_150 }, (_, i) => first + i * 285_000);
    const last = fires.at(-1)!;
    await seed([
      ...cronTimer('c1', 'job1', SPAWNED + 1_000, { cron: '*/5 * * * *', nextFireAt: first }),
      ...fires.map((t) => timerFire('job1', '*/5 * * * *', t)),
      // A job a CronDelete ended, and its lines: not asked for.
      ...cronTimer('c2', 'job2', SPAWNED + 2_000, { cron: '13,43 * * * *', nextFireAt: SPAWNED + 600_000 }),
      timerFire('job2', '13,43 * * * *', SPAWNED + 600_000),
      callLine('d2', 'CronDelete', { id: 'job2' }, SPAWNED + 700_000),
      // A job this session never created.
      timerFire('job3', '*/5 * * * *', last + 1_000),
    ]);
    const prepare = vi.spyOn(db, 'select');
    const rows = await backgroundRowsSince('s1', SPAWNED);
    // The two reads of #122, and one for every job's runs.
    expect(prepare).toHaveBeenCalledTimes(3);
    prepare.mockRestore();
    const runs = rows.filter((m) => m.role === 'system');
    expect(runs.map((m) => m.ts)).toEqual(fires.slice(-TIMER_RUNS_KEPT));
    const items = runningInBackground(rows, SPAWNED, last + 2_000);
    expect(items.map((i) => [i.kind, i.schedule?.firedAt.at(-1), i.nextRunAt])).toEqual([['timer', last, last + 285_000]]);
  });
});
