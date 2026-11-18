/**
 * The fold from transcript rows to "what is running in the background"
 * (#122). Synthetic lines in the shapes Claude Code 2.1.312 writes
 * (backgroundFixtures.ts); the measurements behind them are in adapter.ts.
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '../types';
import { parseLine } from './adapter';
import { MONITOR_DEFAULT_TIMEOUT_MS, TIMER_MAX_MS, nextChangeAt, nextRunOf, runningInBackground } from './background';
import { cronNext } from '../lib/cron';
import { TIMER_RUNS_KEPT } from './timerRuns';
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
  timerFire,
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
/** A run's line is written a moment after the run (measured: 0.1-0.4 s). */
const LINE_LAG = 300;

/**
 * Claude Code 2.1.327's scheduler, as the reviewer read it, written out
 * independently of timerRuns.ts: the runs a job makes, each from the time of
 * the one before. `k` is the job's fraction (from its id, there).
 */
function claudeRuns(cron: string, createdAt: number, k: number, n: number): number[] {
  const out: number[] = [];
  let from = createdAt;
  for (let i = 0; i < n; i++) {
    const a = cronNext(cron, from)!;
    const r = cronNext(cron, a)! - a;
    const next = /^\*\/\d+ \* \* \* \*$/.test(cron) && r >= 300_000 && r < 315_000 ? from + r - 15_000 : a + Math.min(k * r, 30 * MIN);
    out.push(next);
    from = next;
  }
  return out;
}

/** The job's rows as the transcript has them after its first `fired` runs. */
function jobRows(cron: string, createdAt: number, runs: number[], fired: number, jobId = 'job1'): Message[] {
  return rows([
    ...cronTimer('c1', jobId, createdAt - 50, { cron, nextFireAt: runs[0]! }),
    // The latest few, as backgroundRowsSince reads them.
    ...runs.slice(Math.max(0, fired - TIMER_RUNS_KEPT), fired).map((at) => timerFire(jobId, cron, at + LINE_LAG)),
  ]);
}

/** After each run in turn, what the item says comes next, against what came. */
function predictions(cron: string, createdAt: number, k: number, n: number): { said: number | null; came: number }[] {
  const runs = claudeRuns(cron, createdAt, k, n + 1);
  const since = createdAt - MIN;
  const out = [{ said: runningInBackground(jobRows(cron, createdAt, runs, 0), since, createdAt + 1_000)[0]!.nextRunAt, came: runs[0]! }];
  for (let i = 1; i <= n; i++) {
    const now = runs[i - 1]! + 1_000;
    out.push({ said: runningInBackground(jobRows(cron, createdAt, runs, i), since, now)[0]?.nextRunAt ?? null, came: runs[i]! });
  }
  return out;
}

describe("a timer's next run (#443)", () => {
  // Measured: created at 10:50:55, first run 11:17:35.389, then every :17:35
  // and :47:35 -- the slots 13 and 43 plus 4m35.389s.
  const created = local(11, 18, 10, 50, 55);
  const first = local(11, 18, 11, 17, 35, 389);
  const since = created - MIN;
  const measured = (fires: number[] = []) =>
    rows([...cronTimer('c1', '4e553b62', created, { cron: '13,43 * * * *', nextFireAt: first }), ...fires.map((t) => timerFire('4e553b62', '13,43 * * * *', t))]);

  it('runs first at nextFireAt, then at each slot plus the wait the first run shows', () => {
    const at = (now: number, fires: number[] = []) => runningInBackground(measured(fires), since, now)[0]?.nextRunAt;
    expect(at(local(11, 18, 11, 0))).toBe(first);
    // The runs as they came (their lines' times).
    expect(at(local(11, 18, 11, 17, 37), [local(11, 18, 11, 17, 35, 753)])).toBeCloseTo(local(11, 18, 11, 47, 35, 389), 0);
    expect(at(local(11, 18, 11, 47, 37), [local(11, 18, 11, 17, 35, 753), local(11, 18, 11, 47, 36, 63)])).toBeCloseTo(
      local(11, 18, 12, 17, 35, 389),
      0,
    );
    const item = runningInBackground(measured(), since, local(11, 18, 11, 0))[0]!;
    expect(item.schedule).toEqual({ cron: '13,43 * * * *', once: false, firstRunAt: first, createdAt: created + 50, firedAt: [] });
  });

  it('counts a run due with no line for it yet as on time', () => {
    const at = (now: number) => runningInBackground(measured(), since, now)[0]?.nextRunAt;
    expect(at(local(11, 18, 13, 52))).toBeCloseTo(local(11, 18, 14, 17, 35, 389), 0);
    // Across midnight.
    expect(at(local(11, 18, 23, 50))).toBeCloseTo(local(11, 19, 0, 17, 35, 389), 0);
  });

  it('wakes the reader at the next run, so the time moves on', () => {
    expect(nextChangeAt(measured(), since, local(11, 18, 11, 0))).toBe(first);
    expect(nextChangeAt(measured(), since, first)).toBeCloseTo(local(11, 18, 11, 47, 35, 389), 0);
  });

  it('/loop 5m (*/5): every run from the last one, 15 s short of 5 minutes, over 14 runs', () => {
    const created5 = local(11, 18, 10, 50, 55);
    const seen = predictions('*/5 * * * *', created5, 0.3, 14);
    expect(seen).toHaveLength(15);
    // Off the slot grid and drifting: 4m45s apart.
    expect(seen[2]!.came - seen[1]!.came).toBe(5 * MIN - 15_000);
    // Each said within the line's lag of when it came.
    for (const { said, came } of seen) expect(Math.abs(said! - came)).toBeLessThanOrEqual(LINE_LAG);
  });

  it('/loop 5m: a run that came late moves every run after it', () => {
    const c = local(11, 18, 10, 0, 10);
    const runs = claudeRuns('*/5 * * * *', c, 0, 1);
    const late = runs[0]! + 2 * MIN;
    const r = rows([...cronTimer('c1', 'job1', c - 50, { cron: '*/5 * * * *', nextFireAt: runs[0]! }), timerFire('job1', '*/5 * * * *', late)]);
    expect(runningInBackground(r, c - MIN, late + 1_000)[0]?.nextRunAt).toBe(late + 5 * MIN - 15_000);
  });

  it('an uneven cron waits after each slot by that slot\'s gap: 09:00 and 13:00 4 h, 17:00 16 h, capped at 30 min', () => {
    // Created Wed 18 Nov 08:00; k = 0.1: 24 min after 09:00 and 13:00, 30 (not 96) after 17:00.
    const c = local(11, 18, 8, 0);
    const seen = predictions('0 9,13,17 * * 1-5', c, 0.1, 5);
    expect(seen.map((s) => s.came)).toEqual([
      local(11, 18, 9, 24),
      local(11, 18, 13, 24),
      local(11, 18, 17, 30),
      local(11, 19, 9, 24),
      local(11, 19, 13, 24),
      local(11, 19, 17, 30),
    ]);
    for (const { said, came } of seen) expect(Math.abs(said! - came)).toBeLessThan(1);
  });

  it('0 9-17 * * *: 15 min after each hourly slot, 30 after 17:00, then the next morning', () => {
    const c = local(11, 18, 8, 30);
    const seen = predictions('0 9-17 * * *', c, 0.25, 11);
    expect(seen[0]!.came).toBe(local(11, 18, 9, 15));
    expect(seen[8]!.came).toBe(local(11, 18, 17, 30));
    expect(seen[9]!.came).toBe(local(11, 19, 9, 15));
    for (const { said, came } of seen) expect(Math.abs(said! - came)).toBeLessThan(1);
  });

  it('a first run 30 min after its slot hit the cap, and the cap stands for every slot', () => {
    // Created Wed 18:00: first slot Thu 09:00, gap 4 h, k = 0.3 -> 72 min, capped at 30.
    const c = local(11, 18, 18, 0);
    const seen = predictions('0 9,13,17 * * 1-5', c, 0.3, 4);
    expect(seen[0]!.came).toBe(local(11, 19, 9, 30));
    for (const { said, came } of seen) expect(Math.abs(said! - came)).toBeLessThan(1);
  });

  it('a capped first run says only how long the wait is at least: each slot gets the earliest it can run, until a run under the cap shows it', () => {
    // k = 0.083: about 5 min after an hourly slot, but capped after 17:00
    // (16 h gap). Created Fri 20 Nov 16:51, so the first run is the capped one.
    const c = local(11, 20, 16, 51);
    const seen = predictions('0 9-17 * * *', c, 0.083, 10);
    expect(seen[0]!.came).toBe(local(11, 20, 17, 30));
    // Sat 09:00 runs at 09:04:58.8; all that 17:30 says is k >= 30 min / 16 h,
    // so the earliest it can be: 09:01:52.5 -- never later than it comes.
    expect(seen[1]!.came).toBeCloseTo(local(11, 21, 9, 4, 58, 800), 0);
    expect(seen[1]!.said).toBeCloseTo(local(11, 21, 9, 1, 52, 500), 0);
    // From the run under the cap on, every run exactly.
    for (const { said, came } of seen.slice(2)) expect(Math.abs(said! - came)).toBeLessThan(LINE_LAG + 1);
    // Including the capped 17:00 one, and the morning after it.
    expect(seen.slice(2).some((x) => new Date(x.came).getHours() === 17)).toBe(true);
  });

  it('reads a wait longer than half the gap, should the multiplier change', () => {
    // k = 0.8: 24 min after each half-hour slot.
    const seen = predictions('13,43 * * * *', local(11, 18, 10, 50, 55), 0.8, 6);
    expect(seen[0]!.came).toBe(local(11, 18, 11, 37));
    for (const { said, came } of seen) expect(Math.abs(said! - came)).toBeLessThan(1);
  });

  it('a first run the model cannot explain gives no wait, and the next run line sets it', () => {
    const c = local(11, 18, 10, 10);
    // Reported 45 min after its slot (past the cap): not this model's run.
    const odd = local(11, 18, 11, 45);
    const after = (fires: number[], now: number) =>
      runningInBackground(
        rows([...cronTimer('c1', 'job1', c, { cron: '0 * * * *', nextFireAt: odd }), ...fires.map((t) => timerFire('job1', '0 * * * *', t))]),
        c - MIN,
        now,
      )[0]?.nextRunAt;
    expect(after([odd], odd + 1_000)).toBe(local(11, 18, 12, 0));
    // 12:06 came (k = 0.1): 13:06 next.
    expect(after([odd, local(11, 18, 12, 6)], local(11, 18, 12, 6, 1))).toBe(local(11, 18, 13, 6));
  });

  it('runs once more at or past 7 days, then is gone', () => {
    const runs = claudeRuns('13,43 * * * *', created + 50, (first - local(11, 18, 11, 13)) / (30 * MIN), 400);
    const mark = created + 50 + TIMER_MAX_MS;
    const final = runs.find((t) => t >= mark)!;
    const before = runs[runs.indexOf(final) - 1]!;
    // Every run up to the one before the last has come.
    const r = rows([
      ...cronTimer('c1', '4e553b62', created, { cron: '13,43 * * * *', nextFireAt: first }),
      timerFire('4e553b62', '13,43 * * * *', before + LINE_LAG),
    ]);
    const item = runningInBackground(r, since, before + 1_000)[0]!;
    expect(item.nextRunAt).toBeCloseTo(final, 0);
    expect(item.until).toBeCloseTo(final, 0);
    expect(final).toBeGreaterThanOrEqual(mark);
    expect(final - mark).toBeLessThan(30 * MIN);
    expect(nextChangeAt(r, since, before + 1_000)).toBeCloseTo(final, 0);
    expect(runningInBackground(r, since, final - 1)).toHaveLength(1);
    expect(runningInBackground(r, since, final + 1)).toEqual([]);
    // Its line ends it at once, whatever the clock says.
    const ran = rows([
      ...cronTimer('c1', '4e553b62', created, { cron: '13,43 * * * *', nextFireAt: first }),
      timerFire('4e553b62', '13,43 * * * *', final + LINE_LAG),
    ]);
    expect(runningInBackground(ran, since, final - 1)).toEqual([]);
    // Without any line, the last run is still the first at or past the mark.
    expect(runningInBackground(measured(), since, final - 1)[0]?.until).toBeCloseTo(final, 0);
  });

  it("leaves another job's run line alone", () => {
    const r = rows([
      ...cronTimer('c1', '4e553b62', created, { cron: '13,43 * * * *', nextFireAt: first }),
      timerFire('other', '*/5 * * * *', local(11, 18, 11, 5)),
    ]);
    expect(runningInBackground(r, since, local(11, 18, 11, 6))[0]?.schedule?.firedAt).toEqual([]);
  });

  it('shows a one-shot until its run, and ends it at its run line', () => {
    const run = local(11, 18, 15, 0);
    const r = rows(cronTimer('c2', 'job2', created, { cron: '0 15 18 11 *', nextFireAt: run, recurring: false }));
    const before = runningInBackground(r, since, local(11, 18, 13, 52));
    expect(before.map((i) => [i.kind, i.nextRunAt, i.until, i.schedule?.once])).toEqual([['timer', run, run, true]]);
    expect(nextChangeAt(r, since, local(11, 18, 13, 52))).toBe(run);
    expect(runningInBackground(r, since, run)).toEqual([]);
    // Run early: its line ends it.
    const ran = rows([...cronTimer('c2', 'job2', created, { cron: '0 15 18 11 *', nextFireAt: run, recurring: false }), timerFire('job2', '0 15 18 11 *', run - 60_000)]);
    expect(runningInBackground(ran, since, run - 30_000)).toEqual([]);
  });

  it("takes a one-shot's run from its cron when the result does not say", () => {
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

  it('keeps a recurring timer whose cron it cannot read, with its first run only, for 7 days', () => {
    const r = rows(cronTimer('c5', 'job5', created, { cron: '@every-while', nextFireAt: first }));
    expect(runningInBackground(r, since, local(11, 18, 11, 0))[0]?.nextRunAt).toBe(first);
    const later = runningInBackground(r, since, local(11, 18, 12, 0));
    expect(later.map((i) => [i.kind, i.nextRunAt, i.until])).toEqual([['timer', null, created + 50 + TIMER_MAX_MS]]);
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
