/**
 * The fold from transcript rows to "what is running in the background"
 * (#122). Synthetic lines in the shapes Claude Code 2.1.312 writes
 * (backgroundFixtures.ts); the measurements behind them are in adapter.ts.
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '../types';
import { parseLine } from './adapter';
import { MONITOR_DEFAULT_TIMEOUT_MS, TIMER_MAX_MS, nextChangeAt, nextRunOf, runningInBackground, timerOffsetMs } from './background';
import {
  asyncAgent,
  backgroundShell,
  callLine,
  cronTimer,
  monitor,
  noticeAttachmentLine,
  noticeUserLine,
  notification,
  resultLine,
  stopWakeups,
  taskStop,
  taskStopMissing,
  wakeup,
} from './backgroundFixtures';

const SPAWNED = Date.parse('2026-10-28T10:00:00.000Z');
const NOW = SPAWNED + 60 * 60_000;

/** Rows as the DB holds them: one id per row, in line order. */
function rows(lines: Record<string, unknown>[], agentId: string | null = null): Message[] {
  let id = 0;
  return lines.flatMap((line, i) =>
    parseLine(JSON.stringify(line), i).map((m) => ({ ...m, id: ++id, taskId: 1, agentId })),
  );
}

const keys = (r: Message[], since: number | null = SPAWNED, now = NOW) => runningInBackground(r, since, now).map((i) => i.key);

describe('runningInBackground', () => {
  it('lists a background shell from its start until its notification', () => {
    const started = rows(backgroundShell('t1', 'b1', SPAWNED + 1_000));
    const items = runningInBackground(started, SPAWNED, NOW);
    expect(items).toEqual([
      {
        key: 't1',
        kind: 'shell',
        description: 'Poll CI until green',
        startedAt: SPAWNED + 1_000,
        until: null,
        rowId: 1,
        schedule: null,
        nextRunAt: null,
      },
    ]);

    const ended = rows([
      ...backgroundShell('t1', 'b1', SPAWNED + 1_000),
      noticeUserLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), SPAWNED + 5_000),
    ]);
    expect(keys(ended)).toEqual([]);
  });

  it('pairs the end to its start by tool-use id, leaving the others running', () => {
    const r = rows([
      ...backgroundShell('t1', 'b1', SPAWNED + 1_000),
      ...backgroundShell('t2', 'b2', SPAWNED + 2_000, 'Timer: wait 5 minutes before the next check'),
      noticeUserLine(notification({ taskIds: ['b2'], toolUseId: 't2', status: 'completed' }), SPAWNED + 3_000),
    ]);
    expect(keys(r)).toEqual(['t1']);
  });

  it('ends on a notification delivered into a running turn as an attachment', () => {
    const r = rows([
      ...backgroundShell('t1', 'b1', SPAWNED + 1_000),
      noticeAttachmentLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), SPAWNED + 3_000),
    ]);
    expect(keys(r)).toEqual([]);
  });

  it('ends on a failed or killed status as on completed', () => {
    for (const status of ['failed', 'killed', 'stopped']) {
      const r = rows([
        ...backgroundShell('t1', 'b1', SPAWNED + 1_000),
        noticeUserLine(
          notification({ taskIds: ['b1'], toolUseId: 't1', status, summary: 'Background command "Poll CI until green" failed with exit code 1' }),
          SPAWNED + 3_000,
        ),
      ]);
      expect(keys(r), status).toEqual([]);
    }
  });

  it('ends what a TaskStop names by task id, which writes no notification for a shell', () => {
    const r = rows([...backgroundShell('t1', 'b1', SPAWNED + 1_000), ...backgroundShell('t2', 'b2', SPAWNED + 2_000), ...taskStop('s1', 'b1', SPAWNED + 3_000)]);
    expect(keys(r)).toEqual(['t2']);
  });

  it('never opens a shell whose end was written before its start (#350)', () => {
    // A command that failed at once: its notice is stamped 11 ms before the
    // result that says it went to the background.
    const [call, result] = backgroundShell('t1', 'b1', SPAWNED + 1_000);
    const r = rows([
      call!,
      noticeAttachmentLine(notification({ taskIds: ['b1'], toolUseId: 't1', status: 'completed' }), SPAWNED + 1_039),
      { ...result!, timestamp: new Date(SPAWNED + 1_050).toISOString() },
    ]);
    expect(keys(r)).toEqual([]);
  });

  it('ends a shell that TaskStop says no longer exists (#350)', () => {
    const r = rows([...backgroundShell('t1', 'b1', SPAWNED + 1_000), ...backgroundShell('t2', 'b2', SPAWNED + 2_000), ...taskStopMissing('s1', 'b1', SPAWNED + 3_000)]);
    expect(keys(r)).toEqual(['t2']);
  });

  it('ends what a notification names by task id alone, as a resumed session reports leftovers', () => {
    const r = rows([
      ...backgroundShell('t1', 'b1', SPAWNED + 1_000),
      ...backgroundShell('t2', 'b2', SPAWNED + 2_000),
      noticeUserLine(notification({ taskIds: ['b1', 'b2'], status: 'stopped', summary: '2 background shell command tasks did not finish' }), SPAWNED + 3_000),
    ]);
    expect(keys(r)).toEqual([]);
  });

  it('keeps a monitor running through its events, which carry no status', () => {
    const r = rows([
      ...monitor('m1', 'bm', SPAWNED + 1_000),
      noticeUserLine(notification({ taskIds: ['bm'], summary: 'Monitor event: "Watch the build log"', event: 'step 3 of 7 passed' }), SPAWNED + 2_000),
      noticeAttachmentLine(notification({ taskIds: ['bm'], summary: 'Monitor event: "Watch the build log"', event: 'step 4 of 7 passed' }), SPAWNED + 3_000),
    ]);
    const items = runningInBackground(r, SPAWNED, SPAWNED + 4_000);
    expect(items.map((i) => [i.key, i.kind, i.description])).toEqual([['m1', 'monitor', 'Watch the build log']]);
  });

  it("ends a monitor on its script's end, a status with its tool-use id", () => {
    const r = rows([
      ...monitor('m1', 'bm', SPAWNED + 1_000),
      noticeAttachmentLine(notification({ taskIds: ['bm'], toolUseId: 'm1', status: 'completed', summary: 'Monitor "Watch the build log" stream ended' }), SPAWNED + 9_000),
    ]);
    expect(keys(r, SPAWNED, SPAWNED + 10_000)).toEqual([]);
  });

  it('ends a monitor at its timeout, which writes no status, and says when', () => {
    const r = rows(monitor('m1', 'bm', SPAWNED + 1_000, 10 * 60_000));
    const deadline = SPAWNED + 1_050 + 10 * 60_000;
    expect(keys(r, SPAWNED, deadline - 1)).toEqual(['m1']);
    expect(keys(r, SPAWNED, deadline)).toEqual([]);
    expect(nextChangeAt(r, SPAWNED, deadline - 1)).toBe(deadline);
  });

  it("gives a monitor whose result has no timeout Claude Code's default", () => {
    const r = rows([
      callLine('m1', 'Monitor', { command: 'tail -f build.log', description: 'Watch the build log' }, SPAWNED + 1_000),
      resultLine('m1', { taskId: 'bm', persistent: false }, SPAWNED + 1_050),
    ]);
    expect(nextChangeAt(r, SPAWNED, SPAWNED + 2_000)).toBe(SPAWNED + 1_050 + MONITOR_DEFAULT_TIMEOUT_MS);
  });

  it('shows a wake-up as pending until its time, then not at all', () => {
    const r = rows(wakeup('w1', SPAWNED + 1_000, 300));
    const due = SPAWNED + 1_000 + 300_000;
    const pending = runningInBackground(r, SPAWNED, due - 60_000);
    expect(pending.map((i) => [i.kind, i.description, i.until])).toEqual([['wakeup', 'Timer: wait 5 minutes before the next check', due]]);
    expect(nextChangeAt(r, SPAWNED, due - 60_000)).toBe(due);
    expect(keys(r, SPAWNED, due)).toEqual([]);
    expect(nextChangeAt(r, SPAWNED, due)).toBeNull();
  });

  it('keeps only the newest wake-up: the next one replaces it', () => {
    const r = rows([...wakeup('w1', SPAWNED + 1_000, 600), ...wakeup('w2', SPAWNED + 2_000, 300)]);
    expect(keys(r, SPAWNED, SPAWNED + 10_000)).toEqual(['w2']);
  });

  it('drops a pending wake-up when the loop is stopped', () => {
    const r = rows([...wakeup('w1', SPAWNED + 1_000, 600), ...stopWakeups('w2', SPAWNED + 2_000)]);
    expect(keys(r, SPAWNED, SPAWNED + 10_000)).toEqual([]);
  });

  it('ignores starts written before the pty was spawned: that process is gone', () => {
    const r = rows([...backgroundShell('t1', 'b1', SPAWNED - 5_000), ...wakeup('w1', SPAWNED - 4_000, 3600)]);
    expect(keys(r)).toEqual([]);
    // The rule is the spawn, not the clock: the same rows count from an earlier one.
    expect(keys(r, SPAWNED - 10_000, SPAWNED)).toEqual(['t1', 'w1']);
  });

  it('counts nothing without a live pty', () => {
    expect(keys(rows(backgroundShell('t1', 'b1', SPAWNED + 1_000)), null)).toEqual([]);
  });

  it("does not count a subagent's own background work", () => {
    const r = rows(backgroundShell('t1', 'b1', SPAWNED + 1_000), 'agent-1');
    expect(keys(r)).toEqual([]);
  });

  it('lists an agent that went async, with or without the flag', () => {
    const r = rows(asyncAgent('g1', 'a1', SPAWNED + 1_000));
    expect(runningInBackground(r, SPAWNED, NOW).map((i) => [i.kind, i.description])).toEqual([['agent', 'Review the diff for regressions']]);
    const done = rows([
      ...asyncAgent('g1', 'a1', SPAWNED + 1_000),
      noticeAttachmentLine(notification({ taskIds: ['a1'], toolUseId: 'g1', status: 'completed', summary: 'Agent "Review the diff" finished' }), SPAWNED + 9_000),
    ]);
    expect(keys(done)).toEqual([]);
  });

  it('does not list a call that ran in the foreground, failed or is still waiting for its result', () => {
    const r = rows([
      // An agent that ran to the end in the turn: no isAsync.
      callLine('g1', 'Agent', { description: 'Look something up', prompt: 'p' }, SPAWNED + 1_000),
      resultLine('g1', { status: 'completed', agentId: 'a1', content: [] }, SPAWNED + 2_000),
      // Refused at the permission prompt.
      callLine('t1', 'Bash', { command: 'sleep 300', run_in_background: true }, SPAWNED + 3_000),
      resultLine('t1', {}, SPAWNED + 4_000, { isError: true, text: 'The user denied this' }),
      // Asked, not answered yet.
      callLine('t2', 'Bash', { command: 'sleep 300', run_in_background: true }, SPAWNED + 5_000),
    ]);
    expect(keys(r)).toEqual([]);
  });

  it('lists a shell moved to the background by its timeout, which has no flag', () => {
    const r = rows([
      callLine('t1', 'Bash', { command: 'npm test', description: 'Run the test suite' }, SPAWNED + 1_000),
      resultLine('t1', { backgroundTaskId: 'b1', timedOutAfterMs: 120_000, stdout: '', stderr: '' }, SPAWNED + 121_000),
    ]);
    expect(runningInBackground(r, SPAWNED, NOW).map((i) => [i.kind, i.description])).toEqual([['shell', 'Run the test suite']]);
  });

  it('describes a shell without a description by its command, on one line', () => {
    const r = rows([
      callLine('t1', 'Bash', { command: 'sleep 300\necho done', run_in_background: true }, SPAWNED + 1_000),
      resultLine('t1', { backgroundTaskId: 'b1' }, SPAWNED + 1_050),
    ]);
    expect(runningInBackground(r, SPAWNED, NOW)[0]?.description).toBe('sleep 300');
  });

  it('keeps a recurring timer until CronDelete', () => {
    const created = [
      callLine('c1', 'CronCreate', { cron: '*/5 * * * *', prompt: 'Poll CI until green', recurring: true }, SPAWNED + 1_000),
      resultLine('c1', { id: 'job1' }, SPAWNED + 1_050),
    ];
    expect(runningInBackground(rows(created), SPAWNED, NOW).map((i) => [i.kind, i.description])).toEqual([['timer', 'Poll CI until green']]);
    expect(keys(rows([...created, callLine('d1', 'CronDelete', { id: 'job1' }, SPAWNED + 3_000)]))).toEqual([]);
    // A delete this cannot pair ends every timer rather than leave a dead one up.
    expect(keys(rows([...created, callLine('d1', 'CronDelete', {}, SPAWNED + 3_000)]))).toEqual([]);
  });

  it('lists oldest first, with the row to scroll to', () => {
    const r = rows([...wakeup('w1', SPAWNED + 5_000, 600), ...backgroundShell('t1', 'b1', SPAWNED + 1_000)]);
    // Read in time order whatever order the rows come in.
    const items = runningInBackground(r.reverse(), SPAWNED, SPAWNED + 10_000);
    expect(items.map((i) => [i.key, i.rowId])).toEqual([
      ['t1', 3],
      ['w1', 1],
    ]);
  });
});

// --- when a timer next runs (#443) ------------------------------------------

/** Local time, month 1-12: the cron is local, so the suite holds in any zone. */
const local = (mo: number, d: number, h: number, mi: number, sec = 0, ms = 0) => new Date(2026, mo - 1, d, h, mi, sec, ms).getTime();
const MIN = 60_000;

describe('a timer\'s next run (#443)', () => {
  // Measured: created at 10:50:55, first run 11:17:35.389, then every :17:35
  // and :47:35 -- the slots 13 and 43 plus 4m35.389s.
  const created = local(11, 18, 10, 50, 55);
  const first = local(11, 18, 11, 17, 35, 389);
  const since = created - MIN;
  const measured = () => rows(cronTimer('c1', '4e553b62', created, { cron: '13,43 * * * *', nextFireAt: first }));

  it('runs first at nextFireAt, then at each slot plus the same offset', () => {
    const at = (now: number) => runningInBackground(measured(), since, now)[0]?.nextRunAt;
    expect(at(local(11, 18, 11, 0))).toBe(first);
    expect(at(first)).toBe(local(11, 18, 11, 47, 35, 389));
    expect(at(local(11, 18, 13, 52))).toBe(local(11, 18, 14, 17, 35, 389));
    // Across midnight.
    expect(at(local(11, 18, 23, 50))).toBe(local(11, 19, 0, 17, 35, 389));
    const item = runningInBackground(measured(), since, local(11, 18, 11, 0))[0]!;
    expect(item.schedule).toEqual({ cron: '13,43 * * * *', once: false, firstRunAt: first });
    expect(item.until).toBe(created + 50 + TIMER_MAX_MS);
  });

  it('wakes the reader at the next run, so the time moves on', () => {
    expect(nextChangeAt(measured(), since, local(11, 18, 11, 0))).toBe(first);
    expect(nextChangeAt(measured(), since, first)).toBe(local(11, 18, 11, 47, 35, 389));
  });

  it('has no next run past its 7 days, and is gone then', () => {
    const until = created + 50 + TIMER_MAX_MS;
    const last = runningInBackground(measured(), since, until - 10 * MIN)[0];
    // The slot after the expiry is not a run.
    expect(last?.nextRunAt === null || last!.nextRunAt! < until).toBe(true);
    expect(runningInBackground(measured(), since, until)).toEqual([]);
    expect(nextChangeAt(measured(), since, until)).toBeNull();
  });

  it('shows a one-shot until its run, and then nothing', () => {
    const run = local(11, 18, 15, 0);
    const r = rows(cronTimer('c2', 'job2', created, { cron: '0 15 18 11 *', nextFireAt: run, recurring: false }));
    const before = runningInBackground(r, since, local(11, 18, 13, 52));
    expect(before.map((i) => [i.kind, i.nextRunAt, i.until, i.schedule?.once])).toEqual([['timer', run, run, true]]);
    expect(nextChangeAt(r, since, local(11, 18, 13, 52))).toBe(run);
    expect(runningInBackground(r, since, run)).toEqual([]);
  });

  it('takes a one-shot\'s run from its cron when the result does not say', () => {
    const r = rows([
      callLine('c3', 'CronCreate', { cron: '0 15 18 11 *', prompt: 'Check once', recurring: false }, created),
      resultLine('c3', { id: 'job3' }, created + 50),
    ]);
    expect(runningInBackground(r, since, local(11, 18, 13, 52))[0]?.nextRunAt).toBe(local(11, 18, 15, 0));
    expect(runningInBackground(r, since, local(11, 18, 15, 0))).toEqual([]);
  });

  it('leaves out a one-shot whose run it cannot know', () => {
    const r = rows([
      callLine('c4', 'CronCreate', { cron: 'whenever', prompt: 'Check once', recurring: false }, created),
      resultLine('c4', { id: 'job4' }, created + 50),
    ]);
    expect(runningInBackground(r, since, local(11, 18, 13, 52))).toEqual([]);
  });

  it('keeps a recurring timer whose cron it cannot read, with its first run only', () => {
    const r = rows(cronTimer('c5', 'job5', created, { cron: '@every-while', nextFireAt: first }));
    expect(runningInBackground(r, since, local(11, 18, 11, 0))[0]?.nextRunAt).toBe(first);
    const later = runningInBackground(r, since, local(11, 18, 12, 0));
    expect(later.map((i) => [i.kind, i.nextRunAt])).toEqual([['timer', null]]);
  });

  it('gives a wake-up its due time as its next run, and other work none', () => {
    const r = rows([...wakeup('w1', created, 600), ...backgroundShell('t1', 'b1', created + 1_000)]);
    const items = runningInBackground(r, since, created + 2_000);
    expect(items.map((i) => [i.kind, i.nextRunAt])).toEqual([
      ['wakeup', created + 600_000],
      ['shell', null],
    ]);
  });

  it('nextRunOf: nothing for a timer with no schedule or a wake-up already due', () => {
    expect(nextRunOf({ kind: 'timer', until: null, schedule: null }, 0)).toBeNull();
    expect(nextRunOf({ kind: 'wakeup', until: 100, schedule: null }, 100)).toBeNull();
  });
});

describe('timerOffsetMs (#443)', () => {
  it('is how far the first run is past its slot, as measured', () => {
    expect(timerOffsetMs('13,43 * * * *', local(11, 18, 11, 17, 35, 389))).toBe(4 * MIN + 35_389);
    expect(timerOffsetMs('3-59/10 * * * *', local(11, 16, 17, 57, 16, 596))).toBe(4 * MIN + 16_596);
    expect(timerOffsetMs('3-59/10 * * * *', local(11, 16, 19, 3, 29, 472))).toBe(29_472);
    expect(timerOffsetMs('8 18 17 11 *', local(11, 17, 18, 8))).toBe(0);
  });

  it('reads a first run just before a slot as early, and anything else as none', () => {
    expect(timerOffsetMs('0 15 * * *', local(11, 18, 14, 58, 30))).toBe(-90_000);
    // Hours from any slot: no offset, rather than one taken from yesterday.
    expect(timerOffsetMs('0 9 * * *', local(11, 18, 13, 0))).toBe(0);
    expect(timerOffsetMs('not a cron', local(11, 18, 13, 0))).toBe(0);
  });
});
