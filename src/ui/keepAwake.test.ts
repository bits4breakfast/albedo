/**
 * What keeps the Mac awake (#283): a running task, or background work by
 * `runningInBackground` (#122) on a live terminal -- not a recurring timer --
 * and when the answer next changes without a new row.
 */

import { describe, expect, it } from 'vitest';

import { parseLine } from '../capture/adapter';
import { asyncAgent, backgroundShell, callLine, monitor, resultLine, wakeup } from '../capture/backgroundFixtures';
import type { Message, TaskStatus } from '../types';
import { keepAwakeReason, keepAwakeState, type AwakeTask } from './keepAwake';

const SPAWNED = Date.parse('2026-10-28T10:00:00.000Z');
const NOW = SPAWNED + 10 * 60_000;

function rows(lines: Record<string, unknown>[]): Message[] {
  let id = 0;
  return lines.flatMap((line, i) => parseLine(JSON.stringify(line), i).map((m) => ({ ...m, id: ++id, taskId: 1, agentId: null })));
}

function task(status: TaskStatus, lines: Record<string, unknown>[] = [], since: number | null = SPAWNED): AwakeTask {
  return { status, rows: rows(lines), since };
}

const recurringTimer = [
  callLine('c1', 'CronCreate', { cron: '*/5 * * * *', prompt: 'Poll CI until green', recurring: true }, SPAWNED + 1_000),
  resultLine('c1', { id: 'job1' }, SPAWNED + 1_050),
];

describe('keepAwakeState', () => {
  it('counts nothing with no tasks, or only idle ones', () => {
    expect(keepAwakeState([], NOW)).toEqual({ count: 0, nextAt: null });
    expect(keepAwakeState([task('idle'), task('blocked'), task('done')], NOW)).toEqual({ count: 0, nextAt: null });
  });

  it('counts each running task', () => {
    expect(keepAwakeState([task('running', [], null), task('running'), task('idle')], NOW)).toEqual({ count: 2, nextAt: null });
  });

  it('counts an idle task with a background shell, with no deadline', () => {
    expect(keepAwakeState([task('idle', backgroundShell('t1', 'b1', SPAWNED + 1_000))], NOW)).toEqual({ count: 1, nextAt: null });
  });

  it('counts an idle task with an agent in the background', () => {
    expect(keepAwakeState([task('idle', asyncAgent('a1', 'agent-1', SPAWNED + 1_000))], NOW).count).toBe(1);
  });

  it('counts a monitor until its timeout, and says when that is', () => {
    const t = task('idle', monitor('m1', 'mon1', SPAWNED + 1_000, 30 * 60_000));
    const expires = SPAWNED + 1_050 + 30 * 60_000;
    expect(keepAwakeState([t], NOW)).toEqual({ count: 1, nextAt: expires });
    expect(keepAwakeState([t], expires)).toEqual({ count: 0, nextAt: null });
  });

  it('counts a pending wake-up until it is due, and not after', () => {
    const t = task('idle', wakeup('w1', SPAWNED + 1_000, 20 * 60));
    const due = SPAWNED + 1_000 + 20 * 60_000;
    expect(keepAwakeState([t], NOW)).toEqual({ count: 1, nextAt: due });
    expect(keepAwakeState([t], due + 1)).toEqual({ count: 0, nextAt: null });
  });

  it('does not count a recurring timer, nor take its 7-day expiry as a deadline', () => {
    expect(keepAwakeState([task('idle', recurringTimer)], NOW)).toEqual({ count: 0, nextAt: null });
  });

  it('counts nothing in the background without a live terminal', () => {
    expect(keepAwakeState([task('idle', backgroundShell('t1', 'b1', SPAWNED + 1_000), null)], NOW).count).toBe(0);
  });

  it('counts a task once, running or not, and takes the earliest deadline across tasks', () => {
    const both = task('running', [...backgroundShell('t1', 'b1', SPAWNED + 1_000), ...wakeup('w1', SPAWNED + 2_000, 30 * 60)]);
    const other = task('blocked', wakeup('w2', SPAWNED + 3_000, 15 * 60));
    expect(keepAwakeState([both, other], NOW)).toEqual({ count: 2, nextAt: SPAWNED + 3_000 + 15 * 60_000 });
  });

  it('never counts an archived task', () => {
    expect(keepAwakeState([task('archived', backgroundShell('t1', 'b1', SPAWNED + 1_000))], NOW).count).toBe(0);
  });
});

describe('keepAwakeReason', () => {
  it('names the count', () => {
    expect(keepAwakeReason(1)).toBe('1 Claude Code task running');
    expect(keepAwakeReason(2)).toBe('2 Claude Code tasks running');
  });
});
