/**
 * @vitest-environment jsdom
 *
 * When held messages go: with a fake probe for the network, a fake pty, and a
 * fake prompt channel. The release is the only code that sends without a
 * keystroke, so what it must never do is the point: send while offline, type
 * into a prompt, or resend what Claude Code already holds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../Terminal', () => {
  const listeners = new Set<(taskId: number, live: boolean) => void>();
  return {
    submitPty: vi.fn(async () => true),
    startPty: vi.fn(() => true),
    hasLivePty: vi.fn(() => true),
    ptyLiveSince: vi.fn(() => null),
    onPtyPresenceChange: vi.fn((cb: (taskId: number, live: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    __emitPresence: (taskId: number, live: boolean) => {
      for (const cb of [...listeners]) cb(taskId, live);
    },
  };
});

vi.mock('../../db/comments', () => ({ markCommentsSent: vi.fn(async () => {}) }));

vi.mock('../../capture/hookEvents', () => {
  const listeners = new Set<(taskId: number, prompt: unknown) => void>();
  const open = new Map<number, unknown>();
  return {
    pendingPrompt: vi.fn((taskId: number) => open.get(taskId) ?? null),
    onPromptChange: vi.fn((cb: (taskId: number, prompt: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    __setPrompt: (taskId: number, prompt: unknown) => {
      if (prompt === null) open.delete(taskId);
      else open.set(taskId, prompt);
      for (const cb of [...listeners]) cb(taskId, prompt);
    },
  };
});

import { hasLivePty, ptyLiveSince, startPty, submitPty } from '../Terminal';
import { PROBE_EVERY_MS, __resetConnectivity, isOffline, watchConnectivity } from '../../lib/connectivity';
import { __resetOutbox, heldFor, holdMessage, removeHeld, setEditing } from './outbox';
import {
  RETRY_MS,
  canRelease,
  conditionsFor,
  heldHint,
  heldLabel,
  noteShownStatus,
  sendNow,
  sendNowAllowed,
  sendNowOffered,
  sendNowOfferedFor,
  startOutboxRelease,
} from './outboxRelease';
import { START_GRACE_MS, __resetTurns, noteTaskSessions } from './turn';
import { recordQueueOperations, seedQueue } from '../../capture/queue';
import { setTrustWaiting } from '../../capture/workspaceTrust';

const term = (await import('../Terminal')) as unknown as { __emitPresence: (taskId: number, live: boolean) => void };
const hooks = (await import('../../capture/hookEvents')) as unknown as {
  __setPrompt: (taskId: number, prompt: unknown) => void;
};

let reachable = true;
const probe = vi.fn(async () => reachable);
let stop: (() => void) | null = null;

function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
}

/** Trust the probe (one success), then lose the API. */
async function goOffline(): Promise<void> {
  const unwatch = watchConnectivity();
  await vi.advanceTimersByTimeAsync(0);
  reachable = false;
  await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS);
  unwatch();
  expect(isOffline()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  installStorage();
  reachable = true;
  __resetConnectivity(probe);
  __resetOutbox();
  vi.mocked(hasLivePty).mockReturnValue(true);
  vi.mocked(submitPty).mockResolvedValue(true);
});

afterEach(() => {
  stop?.();
  stop = null;
  __resetTurns();
  hooks.__setPrompt(1, null);
  __resetConnectivity();
  __resetOutbox();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the gate', () => {
  it('opens only online with no prompt showing', () => {
    expect(canRelease({ offline: false, promptOpen: false, turnRunning: false })).toBe(true);
    expect(canRelease({ offline: true, promptOpen: false, turnRunning: false })).toBe(false);
    expect(canRelease({ offline: false, promptOpen: true, turnRunning: false })).toBe(false);
    expect(canRelease({ offline: false, promptOpen: false, turnRunning: true })).toBe(false);
  });

  it('says what actually stops the messages', () => {
    const ok = { offline: false, promptOpen: false, turnRunning: false, live: true, headMaybeSent: false, failed: false };
    expect(heldLabel(ok)).toBe('Sending');
    expect(heldLabel({ ...ok, headMaybeSent: true, offline: true })).toBe(
      'Waiting for you to resend or remove the first message',
    );
    expect(heldLabel({ ...ok, offline: true, promptOpen: true })).toBe('Waiting for connection');
    expect(heldLabel({ ...ok, promptOpen: true })).toBe('Waiting for your answer');
    expect(heldLabel({ ...ok, live: false })).toBe('Waiting for the session to start');
    expect(heldLabel({ ...ok, failed: true })).toBe('Couldn\u2019t send \u2014 retrying');
    expect(heldLabel({ ...ok, turnRunning: true })).toBe('Queued');
    // A prompt is the turn's, and says more than the turn does.
    expect(heldLabel({ ...ok, turnRunning: true, promptOpen: true })).toBe('Waiting for your answer');
  });

  it('says when they will go, where it can', () => {
    const ok = { offline: false, promptOpen: false, turnRunning: false, live: true, headMaybeSent: false, failed: false };
    expect(heldHint(ok)).toBeNull();
    expect(heldHint({ ...ok, offline: true, turnRunning: true })).toBe('sent in order once it is back');
    expect(heldHint({ ...ok, turnRunning: true })).toBe('sent when Claude finishes this turn');
    expect(heldHint({ ...ok, turnRunning: true, promptOpen: true })).toBeNull();
    expect(heldHint({ ...ok, turnRunning: true, headMaybeSent: true })).toBeNull();
  });

  it('offers Send Now only for what the turn alone holds, and allows it with no prompt and a live session', () => {
    const turn = { offline: false, promptOpen: false, turnRunning: true, live: true, headMaybeSent: false, failed: false };
    expect(sendNowOffered(turn)).toBe(true);
    expect(sendNowAllowed(turn)).toBe(true);
    expect(sendNowOffered({ ...turn, turnRunning: false })).toBe(false);
    expect(sendNowOffered({ ...turn, offline: true })).toBe(false);
    expect(sendNowOffered({ ...turn, promptOpen: true })).toBe(true);
    expect(sendNowAllowed({ ...turn, promptOpen: true })).toBe(false);
    expect(sendNowAllowed({ ...turn, live: false })).toBe(false);
  });
});

describe('the release', () => {
  it('holds while offline and sends in order, through submitPty, once the probe succeeds', async () => {
    await goOffline();
    stop = startOutboxRelease();
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    holdMessage(2, 'for another task');
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 2);
    expect(submitPty).not.toHaveBeenCalled();

    reachable = true;
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS);
    expect(isOffline()).toBe(false);
    // In order within a task; each task has its own pty, so tasks go side by side.
    const calls = vi.mocked(submitPty).mock.calls;
    expect(calls.filter(([id]) => id === 1)).toEqual([
      [1, 'one'],
      [1, 'two'],
    ]);
    expect(calls.filter(([id]) => id === 2)).toEqual([[2, 'for another task']]);
    expect(heldFor(1)).toEqual([]);
    expect(heldFor(2)).toEqual([]);
  });

  it('never resends: an outbox emptied by a release has nothing for the next trigger', async () => {
    stop = startOutboxRelease();
    holdMessage(1, 'once');
    await vi.advanceTimersByTimeAsync(0);
    term.__emitPresence(1, true);
    hooks.__setPrompt(1, null);
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'once']]);
  });

  it('waits out a prompt rather than typing into it', async () => {
    hooks.__setPrompt(1, { kind: 'question' });
    stop = startOutboxRelease();
    holdMessage(1, 'after the question');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    hooks.__setPrompt(1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).toHaveBeenCalledWith(1, 'after the question');
  });

  it('shares the composer\u2019s gate: the trust dialog and a blocked status hold it too', async () => {
    setTrustWaiting(1, true);
    stop = startOutboxRelease();
    holdMessage(1, 'after trust');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    noteShownStatus(1, 'blocked');
    setTrustWaiting(1, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    noteShownStatus(1, 'running');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).toHaveBeenCalledWith(1, 'after trust');
    noteShownStatus(null, null);
  });

  it('tries a failed write again after a pause', async () => {
    vi.mocked(submitPty).mockResolvedValueOnce(false);
    stop = startOutboxRelease();
    holdMessage(1, 'flaky');
    await vi.advanceTimersByTimeAsync(0);
    expect(heldFor(1)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(heldFor(1)).toEqual([]);
    expect(submitPty).toHaveBeenCalledTimes(2);
  });

  it('stops the rest when a prompt opens halfway through', async () => {
    vi.mocked(submitPty).mockImplementation(async (_id, text) => {
      if (text === 'one') hooks.__setPrompt(1, { kind: 'permission' });
      return true;
    });
    stop = startOutboxRelease();
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'one']]);
    expect(heldFor(1).map((h) => h.text)).toEqual(['two']);
  });

  it('starts a session that is not running, and sends when it is live', async () => {
    vi.mocked(hasLivePty).mockReturnValue(false);
    stop = startOutboxRelease();
    holdMessage(1, 'wake up');
    await vi.advanceTimersByTimeAsync(0);
    expect(startPty).toHaveBeenCalledWith(1);
    expect(submitPty).not.toHaveBeenCalled();
    vi.mocked(hasLivePty).mockReturnValue(true);
    term.__emitPresence(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).toHaveBeenCalledWith(1, 'wake up');
  });

  it('keeps a message whose write fails, at the head, for the next trigger', async () => {
    vi.mocked(submitPty).mockResolvedValueOnce(false);
    stop = startOutboxRelease();
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    await vi.advanceTimersByTimeAsync(0);
    expect(heldFor(1).map((h) => h.text)).toEqual(['one', 'two']);
    term.__emitPresence(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([
      [1, 'one'],
      [1, 'one'],
      [1, 'two'],
    ]);
  });

  it('sends what a previous run held, once the session is up', async () => {
    holdMessage(4, 'from before the restart');
    __resetOutbox(); // the restart: memory gone, storage kept
    vi.mocked(hasLivePty).mockReturnValue(false);
    stop = startOutboxRelease();
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    vi.mocked(hasLivePty).mockReturnValue(true);
    term.__emitPresence(4, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).toHaveBeenCalledWith(4, 'from before the restart');
  });

  it('watches the connection only while something is held', async () => {
    stop = startOutboxRelease();
    await vi.advanceTimersByTimeAsync(PROBE_EVERY_MS * 3);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('a running turn (#61)', () => {
  const T = Date.parse('2026-10-23T09:00:00.000Z');
  const S = 'release-turn-session';
  const at = (ms: number) => vi.setSystemTime(T + ms);
  /** The transcript's facts for the session, as the watcher records them. */
  const started = (ts: number) => recordQueueOperations([{ op: 'prompt', sessionId: S, text: 'p', ts }]);
  const ended = (ts: number) => recordQueueOperations([{ op: 'turn-end', sessionId: S, ts }]);
  const interrupted = (ts: number) =>
    recordQueueOperations([
      { op: 'prompt', sessionId: S, text: '[Request interrupted by user]', ts },
      { op: 'turn-stop', sessionId: S, ts },
    ]);

  beforeEach(() => {
    at(0);
    seedQueue([S], []);
    vi.mocked(ptyLiveSince).mockReturnValue(T - 60_000);
    noteTaskSessions([{ id: 1, sessionId: S }]);
  });

  afterEach(() => seedQueue([S], []));

  it('holds while a turn runs, and sends when it ends -- one turn per message, in order', async () => {
    started(T - 1_000);
    stop = startOutboxRelease();
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();

    at(1_000);
    ended(T + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    // 'one' starts a turn the transcript has not shown yet: 'two' waits for it.
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'one']]);
    expect(heldFor(1).map((h) => h.text)).toEqual(['two']);

    at(2_000);
    started(T + 2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).toHaveBeenCalledTimes(1);

    at(9_000);
    ended(T + 9_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([
      [1, 'one'],
      [1, 'two'],
    ]);
    expect(heldFor(1)).toEqual([]);
  });

  it('keeps holding through a long silence mid-turn: no row is not a turn end', async () => {
    started(T - 1_000);
    stop = startOutboxRelease();
    holdMessage(1, 'after the big write');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('sends at once after an interrupt: Esc, or a refused dialog, ends the turn', async () => {
    started(T - 5_000);
    stop = startOutboxRelease();
    holdMessage(1, 'no, do it this way');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    interrupted(T);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'no, do it this way']]);
  });

  it('never sends while a prompt is pending, even once the turn has ended', async () => {
    started(T - 1_000);
    hooks.__setPrompt(1, { kind: 'question' });
    stop = startOutboxRelease();
    holdMessage(1, 'after the turn');
    ended(T);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    hooks.__setPrompt(1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'after the turn']]);
  });

  it('sends once when the turn ending and the prompt closing come together', async () => {
    started(T - 1_000);
    hooks.__setPrompt(1, { kind: 'permission' });
    stop = startOutboxRelease();
    holdMessage(1, 'once');
    hooks.__setPrompt(1, null);
    ended(T);
    term.__emitPresence(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'once']]);
  });

  it('holds a command like a message, and sends it only into an idle session', async () => {
    started(T - 1_000);
    stop = startOutboxRelease();
    holdMessage(1, '/compact');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
    ended(T);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, '/compact']]);
  });

  it('does not hold the rest forever when a start never reaches the transcript', async () => {
    ended(T - 10_000);
    stop = startOutboxRelease();
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'one']]);
    await vi.advanceTimersByTimeAsync(START_GRACE_MS + 1);
    expect(vi.mocked(submitPty).mock.calls).toEqual([
      [1, 'one'],
      [1, 'two'],
    ]);
  });

  it('waits for a turn a finished agent’s notification is about to start', async () => {
    ended(T - 10_000);
    recordQueueOperations([{ op: 'enqueue', sessionId: S, text: '<task-notification>done</task-notification>', ts: T }]);
    stop = startOutboxRelease();
    holdMessage(1, 'next');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('releases nothing into a turn Claude Code starts from its own queue (dequeued at once, no prompt line)', async () => {
    ended(T - 10_000);
    stop = startOutboxRelease();
    recordQueueOperations([{ op: 'enqueue', sessionId: S, text: '<agent-message from="a">done</agent-message>', ts: T }]);
    recordQueueOperations([{ op: 'dequeue', sessionId: S, ts: T + 7 }]);
    // Sent from the composer between the dequeue and the turn's first sign.
    holdMessage(1, 'after the agent');
    await vi.advanceTimersByTimeAsync(80);
    expect(submitPty).not.toHaveBeenCalled();
    recordQueueOperations([{ op: 'turn-step', sessionId: S, ts: T + 80 }]); // its API call
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(submitPty).not.toHaveBeenCalled();
    ended(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'after the agent']]);
  });

  it('is not stuck by a notification line written after a turn end with no turn following', async () => {
    started(T - 5_000);
    stop = startOutboxRelease();
    holdMessage(1, 'next');
    recordQueueOperations([
      { op: 'dequeue', sessionId: S, ts: T + 2 },
      { op: 'turn-end', sessionId: S, ts: T },
      { op: 'turn-stop', sessionId: S, ts: T + 1 },
      { op: 'prompt', sessionId: S, text: '<task-notification>\n<task-id>x</task-id>', ts: T + 3 },
    ]);
    await vi.advanceTimersByTimeAsync(START_GRACE_MS + 10);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'next']]);
  });

  it('sends what is left after an edit and a remove while held, as saved', async () => {
    started(T - 1_000);
    stop = startOutboxRelease();
    const one = holdMessage(1, 'one');
    const two = holdMessage(1, 'two');
    removeHeld(1, one!.id);
    setEditing(1, two!.id, true);
    ended(T);
    await vi.advanceTimersByTimeAsync(0);
    expect(submitPty).not.toHaveBeenCalled(); // open for editing
    setEditing(1, two!.id, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'two']]);
  });

  it('pays no attention to a turn from before this session was spawned', async () => {
    vi.mocked(ptyLiveSince).mockReturnValue(T);
    started(T - 30_000);
    stop = startOutboxRelease();
    holdMessage(1, 'after a restart');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'after a restart']]);
  });

  it('Send Now types one into the running turn, at the person’s word, and only when it may', async () => {
    started(T - 1_000);
    stop = startOutboxRelease();
    holdMessage(1, 'one');
    const two = holdMessage(1, 'two');
    expect(sendNowOffered(conditionsFor(1))).toBe(true);
    hooks.__setPrompt(1, { kind: 'question' });
    expect(sendNowAllowed(conditionsFor(1))).toBe(false);
    expect(await sendNow(1, two!.id)).toBe(false);
    hooks.__setPrompt(1, null);
    expect(await sendNow(1, two!.id)).toBe(true);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'two']]);
    expect(heldFor(1).map((h) => h.text)).toEqual(['one']);
  });

  it('never offers or sends a command now: it only goes into an idle session', async () => {
    started(T - 1_000);
    stop = startOutboxRelease();
    const cmd = holdMessage(1, '/clear');
    expect(sendNowOfferedFor(conditionsFor(1), '/clear')).toBe(false);
    expect(sendNowOfferedFor(conditionsFor(1), 'a message')).toBe(true);
    expect(await sendNow(1, cmd!.id)).toBe(false);
    expect(submitPty).not.toHaveBeenCalled();
  });
});
