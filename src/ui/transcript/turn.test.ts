/**
 * Whether a turn is running, for the outbox's hold (#61): the rule over the
 * facts, and the store that keeps the facts and says when they change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let spawned: number | null = null;
vi.mock('../Terminal', () => ({ ptyLiveSince: () => spawned }));

import { recordQueueOperations, seedQueue } from '../../capture/queue';
import {
  START_GRACE_MS,
  __resetTurns,
  isTurnRunning,
  noteSubmitted,
  noteTaskSessions,
  onTurnChange,
  turnRunning,
  turnSettlesAt,
  type TurnFacts,
} from './turn';

const T = Date.parse('2026-10-23T09:00:00.000Z');

/** A live pty spawned a minute before T, nothing else known. */
const base: TurnFacts = {
  liveSince: T - 60_000,
  running: false,
  startedAt: null,
  endedAt: null,
  submittedAt: null,
  queued: 0,
  injectedAt: null,
  now: T,
};

describe('turnRunning', () => {
  it('runs while the marks say so, however long it is silent', () => {
    const on = { ...base, running: true, startedAt: T - 5_000, endedAt: T - 6_000 };
    expect(turnRunning(on)).toBe(true);
    // Thinking, or writing a big file: no row for 20 minutes is not the end.
    expect(turnRunning({ ...on, now: T + 20 * 60_000 })).toBe(true);
    expect(turnRunning({ ...on, running: false, endedAt: T - 1_000 })).toBe(false);
  });

  it('ignores a start from before this pty was spawned: a resumed session starts between turns', () => {
    expect(turnRunning({ ...base, running: true, startedAt: T - 120_000 })).toBe(false);
  });

  it('is never running without a live pty', () => {
    expect(
      turnRunning({ ...base, liveSince: null, running: true, startedAt: T, queued: 2, submittedAt: T, injectedAt: T }),
    ).toBe(false);
  });

  it('counts typed entries in Claude Code’s queue: it takes them as a turn within seconds', () => {
    expect(turnRunning({ ...base, endedAt: T - 5, queued: 1 })).toBe(true);
  });

  it('counts a message Claude Code gave itself as a turn about to start, for the grace only', () => {
    const notified = { ...base, endedAt: T - 10_000, injectedAt: T - 1_000 };
    expect(turnRunning(notified)).toBe(true);
    expect(turnSettlesAt(notified)).toBe(T - 1_000 + START_GRACE_MS);
    // No turn came: it does not hold anything for longer.
    expect(turnRunning({ ...notified, now: T - 1_000 + START_GRACE_MS })).toBe(false);
    // From before the last turn end: that turn took it.
    expect(turnRunning({ ...notified, endedAt: T - 500 })).toBe(false);
  });

  it('counts a submit since the last turn end as a turn starting, for the grace only', () => {
    const sent = { ...base, endedAt: T - 10_000, submittedAt: T - 1_000 };
    expect(turnRunning(sent)).toBe(true);
    expect(turnSettlesAt(sent)).toBe(T - 1_000 + START_GRACE_MS);
    // Its prompt landed: the marks decide from here, grace or not.
    expect(turnRunning({ ...sent, running: true, startedAt: T - 900, now: T + START_GRACE_MS })).toBe(true);
    // A command that ran without a turn has ended it.
    expect(turnRunning({ ...sent, startedAt: T - 900, endedAt: T - 900 })).toBe(false);
    // No fact ever came: the submit started nothing, and nothing is kept forever.
    expect(turnRunning({ ...sent, now: T - 1_000 + START_GRACE_MS })).toBe(false);
    // A submit to an earlier process says nothing about this one.
    expect(turnRunning({ ...sent, liveSince: T })).toBe(false);
  });
});

describe('the store', () => {
  const S = 'turn-store-session';
  const fact = (op: 'prompt' | 'turn-end' | 'turn-stop' | 'turn-step' | 'dequeue', ts: number, text = 'hi') =>
    op === 'prompt' ? { op, sessionId: S, text, ts } : { op, sessionId: S, ts };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    spawned = T - 60_000;
    __resetTurns();
    seedQueue([S], []);
  });

  afterEach(() => {
    __resetTurns();
    seedQueue([S], []);
    vi.useRealTimers();
  });

  it('follows the transcript’s prompts and turn ends for the task’s session', () => {
    const seen: number[] = [];
    const off = onTurnChange((id) => seen.push(id));
    noteTaskSessions([{ id: 1, sessionId: S }]);
    expect(isTurnRunning(1)).toBe(false);
    recordQueueOperations([fact('prompt', T - 5)]);
    expect(isTurnRunning(1)).toBe(true);
    recordQueueOperations([fact('turn-stop', T - 1)]);
    expect(isTurnRunning(1)).toBe(false);
    expect(seen.filter((id) => id === 1).length).toBeGreaterThanOrEqual(3);
    off();
  });

  it('says so again when a grace runs out', () => {
    const seen: number[] = [];
    const off = onTurnChange((id) => seen.push(id));
    noteTaskSessions([{ id: 1, sessionId: S }]);
    noteSubmitted(1);
    expect(isTurnRunning(1)).toBe(true);
    seen.length = 0;
    vi.advanceTimersByTime(START_GRACE_MS + 1);
    expect(seen).toEqual([1]);
    expect(isTurnRunning(1)).toBe(false);
    off();
  });

  it('follows Claude Code’s queue, typed entries and its own', () => {
    noteTaskSessions([{ id: 1, sessionId: S }]);
    recordQueueOperations([{ op: 'enqueue', sessionId: S, text: 'typed in the terminal', ts: T - 1 }]);
    expect(isTurnRunning(1)).toBe(true);
    recordQueueOperations([fact('turn-end', T - 1)]);
    recordQueueOperations([{ op: 'dequeue', sessionId: S, ts: T }]);
    // Taken, by a turn about to start, for the grace.
    expect(isTurnRunning(1)).toBe(true);
    vi.advanceTimersByTime(START_GRACE_MS + 1);
    expect(isTurnRunning(1)).toBe(false);
    recordQueueOperations([{ op: 'enqueue', sessionId: S, text: '<task-notification>done</task-notification>', ts: Date.now() }]);
    expect(isTurnRunning(1)).toBe(true);
  });

  it('a notification line after a turn end leaves no turn running past the grace (Claude Code often starts none)', () => {
    noteTaskSessions([{ id: 1, sessionId: S }]);
    recordQueueOperations([
      fact('prompt', T - 5_000, 'do it'),
      fact('turn-step', T - 4_000),
      { op: 'dequeue', sessionId: S, ts: T - 1 }, // written before the end lines, stamped after them
      fact('turn-end', T - 3),
      fact('turn-stop', T - 2),
      fact('prompt', T, '<task-notification>\n<task-id>x</task-id>'),
    ]);
    vi.advanceTimersByTime(START_GRACE_MS + 1);
    expect(isTurnRunning(1)).toBe(false);
  });

  it('a turn Claude Code starts from its own queue runs from its first API call, with nothing released before', () => {
    noteTaskSessions([{ id: 1, sessionId: S }]);
    recordQueueOperations([fact('turn-stop', T - 10_000)]);
    // Enqueued, dequeued 7 ms later, then an isMeta line: no prompt fact.
    recordQueueOperations([{ op: 'enqueue', sessionId: S, text: '<agent-message from="a">hi</agent-message>', ts: T }]);
    recordQueueOperations([{ op: 'dequeue', sessionId: S, ts: T + 7 }]);
    expect(isTurnRunning(1)).toBe(true);
    recordQueueOperations([fact('turn-step', T + 80)]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(isTurnRunning(1)).toBe(true);
    recordQueueOperations([fact('turn-end', Date.now())]);
    expect(isTurnRunning(1)).toBe(false);
  });
});
