/**
 * The fold from transcript rows to "what is running in the background"
 * (#122). Synthetic lines in the shapes Claude Code 2.1.312 writes
 * (backgroundFixtures.ts); the measurements behind them are in adapter.ts.
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '../types';
import { parseLine } from './adapter';
import { MONITOR_DEFAULT_TIMEOUT_MS, nextChangeAt, runningInBackground } from './background';
import {
  asyncAgent,
  backgroundShell,
  callLine,
  monitor,
  noticeAttachmentLine,
  noticeUserLine,
  notification,
  resultLine,
  stopWakeups,
  taskStop,
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

  it('keeps a recurring timer until CronDelete, and never shows a one-shot (not measured)', () => {
    const created = [
      callLine('c1', 'CronCreate', { cron: '*/5 * * * *', prompt: 'Poll CI until green', recurring: true }, SPAWNED + 1_000),
      resultLine('c1', { id: 'job1' }, SPAWNED + 1_050),
      callLine('c2', 'CronCreate', { cron: '30 14 28 10 *', prompt: 'Remind me', recurring: false }, SPAWNED + 2_000),
      resultLine('c2', { id: 'job2' }, SPAWNED + 2_050),
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
