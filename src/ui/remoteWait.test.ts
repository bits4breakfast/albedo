/**
 * @vitest-environment jsdom
 *
 * What Albedo knows after sending `/remote-control` (#343): the watch that
 * says Claude Code is probably showing Remote Control's menu in the terminal,
 * and what ends it. Driven through the real send gateway, queue and
 * remote-session stores; only the pty, the database and capture's events are
 * stand-ins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  presence: new Set<(id: number, live: boolean) => void>(),
  captures: new Set<(u: { sessionId: string }) => void>(),
  line: null as { url: string; ts: number } | null,
}));

vi.mock('./Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => 1),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: (cb: (id: number, live: boolean) => void) => {
    h.presence.add(cb);
    return () => void h.presence.delete(cb);
  },
}));
vi.mock('../db', () => ({ remoteControlLineSince: vi.fn(async () => h.line) }));
vi.mock('../capture', () => ({
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.captures.add(cb);
    return () => void h.captures.delete(cb);
  },
}));

const {
  __resetRemoteWaits,
  dismissRemoteWait,
  isRemoteControlCommand,
  MENU_AFTER_MS,
  noteRemoteAskOutcome,
  noteRemoteAsked,
  remoteWaitFor,
} = await import('./remoteWait');
const { submitLocked } = await import('./transcript/send');
const { __resetTurns, noteTaskSessions } = await import('./transcript/turn');
const { recordQueueOperations, seedQueue } = await import('../capture/queue');
const { __resetRemoteSessions, recordRemoteSessions } = await import('../capture/remoteSession');
const { __resetOutbox, holdMessage, heldFor, removeHeld } = await import('./transcript/outbox');

const URL = 'https://claude.ai/code/session_example';
const T0 = Date.parse('2026-11-10T20:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  h.line = null;
  noteTaskSessions([
    { id: 1, sessionId: 's1' },
    { id: 2, sessionId: 's2' },
  ]);
});

afterEach(() => {
  __resetRemoteWaits();
  __resetRemoteSessions();
  __resetTurns();
  __resetOutbox();
  seedQueue(['s1', 's2'], []);
  vi.useRealTimers();
});

/** Let the watch's lookups (promises) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function sendCommand(taskId = 1, text = '/remote-control'): Promise<void> {
  await submitLocked(taskId, text);
  await flush();
}

async function pastDeadline(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MENU_AFTER_MS + 1);
  await flush();
}

describe('the watch after /remote-control', () => {
  it('starts on the write, from any path through the gateway', async () => {
    await sendCommand();
    expect(remoteWaitFor(1)).toEqual({ phase: 'sent', at: T0 });
  });

  it('knows the command in both forms, and nothing else', () => {
    expect(isRemoteControlCommand('/remote-control')).toBe(true);
    expect(isRemoteControlCommand(' /rc ')).toBe(true);
    expect(isRemoteControlCommand('/remote-control my-laptop')).toBe(true);
    expect(isRemoteControlCommand('/rcx')).toBe(false);
    expect(isRemoteControlCommand('turn on /remote-control')).toBe(false);
  });

  it('ignores any other text', async () => {
    await sendCommand(1, 'hello');
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('takes it to be the menu when nothing is written within the deadline', async () => {
    await sendCommand();
    await vi.advanceTimersByTimeAsync(MENU_AFTER_MS - 100);
    await flush();
    expect(remoteWaitFor(1)?.phase).toBe('sent');
    await pastDeadline();
    expect(remoteWaitFor(1)).toEqual({ phase: 'menu', at: T0 });
  });

  it('ends at once when the "is active" line arrives', async () => {
    await sendCommand();
    h.line = { url: URL, ts: T0 + 800 };
    for (const cb of [...h.captures]) cb({ sessionId: 's1' });
    await flush();
    expect(remoteWaitFor(1)).toBeNull();
    await pastDeadline();
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('ends when the link is written with the next prompt (a session already on)', async () => {
    await sendCommand();
    await pastDeadline();
    expect(remoteWaitFor(1)?.phase).toBe('menu');
    recordRemoteSessions([{ sessionId: 's1', url: URL, ts: T0 + 60_000 }]);
    await flush();
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('a link written before the send says nothing about it', async () => {
    recordRemoteSessions([{ sessionId: 's1', url: URL, ts: T0 - 1_000 }]);
    await sendCommand();
    await pastDeadline();
    expect(remoteWaitFor(1)?.phase).toBe('menu');
  });

  it('ends the menu when the session moves on: a turn starts', async () => {
    await sendCommand();
    await pastDeadline();
    expect(remoteWaitFor(1)?.phase).toBe('menu');
    recordQueueOperations([{ op: 'prompt', sessionId: 's1', text: 'next', ts: T0 + 30_000 }]);
    await flush();
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('a session that moved on before the deadline never shows the menu', async () => {
    await sendCommand();
    recordQueueOperations([{ op: 'turn-stop', sessionId: 's1', ts: T0 + 700 }]);
    await flush();
    await pastDeadline();
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('activity from before the send does not end it', async () => {
    recordQueueOperations([{ op: 'prompt', sessionId: 's1', text: 'earlier', ts: T0 - 5_000 }]);
    await sendCommand();
    await pastDeadline();
    expect(remoteWaitFor(1)?.phase).toBe('menu');
  });

  it('ends with the pty', async () => {
    await sendCommand();
    await pastDeadline();
    for (const cb of [...h.presence]) cb(1, false);
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('is per task: another task is untouched, and its session cannot end this one', async () => {
    await sendCommand(1);
    expect(remoteWaitFor(2)).toBeNull();
    await pastDeadline();
    recordQueueOperations([{ op: 'prompt', sessionId: 's2', text: 'elsewhere', ts: T0 + 10_000 }]);
    recordRemoteSessions([{ sessionId: 's2', url: URL, ts: T0 + 10_000 }]);
    await flush();
    expect(remoteWaitFor(1)?.phase).toBe('menu');
    expect(remoteWaitFor(2)).toBeNull();
  });

  it('Dismiss ends it', async () => {
    await sendCommand();
    await pastDeadline();
    dismissRemoteWait(1);
    expect(remoteWaitFor(1)).toBeNull();
  });
});

describe('every send path starts it, because every path writes through the gateway', () => {
  it('a button (sendToSession, as the ⋯ item and the dialog send)', async () => {
    const { sendToSession } = await import('./transcript/send');
    expect(await sendToSession(1, '/remote-control')).toBe('sent');
    expect(remoteWaitFor(1)?.phase).toBe('sent');
  });

  it('the outbox, releasing it after the turn that held it', async () => {
    const { releaseHeld } = await import('./transcript/outbox');
    noteRemoteAsked(1);
    holdMessage(1, '/remote-control');
    expect(remoteWaitFor(1)).toEqual({ phase: 'asked' });
    await releaseHeld(1, (text) => submitLocked(1, text));
    expect(heldFor(1)).toEqual([]);
    expect(remoteWaitFor(1)?.phase).toBe('sent');
    await pastDeadline();
    expect(remoteWaitFor(1)?.phase).toBe('menu');
  });

  it('the message box, where it was typed as /rc', async () => {
    await sendCommand(1, '/rc');
    expect(remoteWaitFor(1)?.phase).toBe('sent');
  });

  it('a write that failed starts nothing', async () => {
    const { submitPty } = await import('./Terminal');
    vi.mocked(submitPty).mockResolvedValueOnce(false);
    await sendCommand();
    expect(remoteWaitFor(1)).toBeNull();
  });
});

describe('asked, before it is written', () => {
  it('is up from the click, and becomes the watch when written', async () => {
    noteRemoteAsked(1);
    expect(remoteWaitFor(1)).toEqual({ phase: 'asked' });
    await sendCommand();
    expect(remoteWaitFor(1)?.phase).toBe('sent');
  });

  it('ends when the command went to the message box or nowhere', () => {
    noteRemoteAsked(1);
    noteRemoteAskOutcome(1, 'composer');
    expect(remoteWaitFor(1)).toBeNull();
    noteRemoteAsked(1);
    noteRemoteAskOutcome(1, 'failed');
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('stays while held in the outbox, and ends if it is removed unsent', () => {
    noteRemoteAsked(1);
    holdMessage(1, '/remote-control');
    noteRemoteAskOutcome(1, 'held');
    expect(remoteWaitFor(1)).toEqual({ phase: 'asked' });
    const held = heldFor(1)[0]!;
    removeHeld(1, held.id);
    expect(remoteWaitFor(1)).toBeNull();
  });

  it('asking again while up changes nothing', async () => {
    await sendCommand();
    noteRemoteAsked(1);
    expect(remoteWaitFor(1)?.phase).toBe('sent');
  });
});
