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

import { hasLivePty, startPty, submitPty } from '../Terminal';
import { PROBE_EVERY_MS, __resetConnectivity, isOffline, watchConnectivity } from '../../lib/connectivity';
import { __resetOutbox, heldFor, holdMessage } from './outbox';
import { RETRY_MS, canRelease, heldLabel, noteShownStatus, startOutboxRelease } from './outboxRelease';
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
  hooks.__setPrompt(1, null);
  __resetConnectivity();
  __resetOutbox();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the gate', () => {
  it('opens only online with no prompt showing', () => {
    expect(canRelease({ offline: false, promptOpen: false })).toBe(true);
    expect(canRelease({ offline: true, promptOpen: false })).toBe(false);
    expect(canRelease({ offline: false, promptOpen: true })).toBe(false);
  });

  it('says what actually stops the messages', () => {
    const ok = { offline: false, promptOpen: false, live: true, headMaybeSent: false, failed: false };
    expect(heldLabel(ok)).toBe('Sending');
    expect(heldLabel({ ...ok, headMaybeSent: true, offline: true })).toBe(
      'Waiting for you to resend or remove the first message',
    );
    expect(heldLabel({ ...ok, offline: true, promptOpen: true })).toBe('Waiting for connection');
    expect(heldLabel({ ...ok, promptOpen: true })).toBe('Waiting for your answer');
    expect(heldLabel({ ...ok, live: false })).toBe('Waiting for the session to start');
    expect(heldLabel({ ...ok, failed: true })).toBe('Couldn\u2019t send \u2014 retrying');
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
