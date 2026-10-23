/**
 * @vitest-environment jsdom
 *
 * The one send gateway: a button's prompt is held like a composer message,
 * and no two writes to one session ever overlap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every write, in order, as the pty would see it. */
const writes: string[] = [];
vi.mock('../Terminal', () => ({
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  // As the real one: the paste, a pause, then Enter, as two writes.
  submitPty: vi.fn(async (_taskId: number, text: string) => {
    writes.push(`paste:${text}`);
    await new Promise((r) => setTimeout(r, 50));
    writes.push(`enter:${text}`);
    return true;
  }),
}));
vi.mock('./composerBridge', () => ({ insertIntoComposer: vi.fn(() => true) }));

import { ptyLiveSince, submitPty } from '../Terminal';
import { __resetConnectivity } from '../../lib/connectivity';
import { sendPrompt } from '../sendPrompt';
import { __resetOutbox, heldFor, holdMessage, releaseHeld } from './outbox';
import { isSlashCommand, sendToSession, submitLocked } from './send';
import { __resetTurns, isTurnRunning, noteTaskSessions } from './turn';
import { recordQueueOperations, seedQueue } from '../../capture/queue';

let online = true;

beforeEach(() => {
  // A fresh, working store per test. jsdom's own persists across tests on
  // Node 22 and is not a working Storage at all on Node 25 (Node's global
  // one shadows it), so neither can be relied on.
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  vi.useFakeTimers();
  writes.length = 0;
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  __resetConnectivity(async () => online);
  __resetOutbox();
});

afterEach(() => {
  __resetConnectivity();
  __resetOutbox();
  __resetTurns();
  vi.mocked(ptyLiveSince).mockReturnValue(null);
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('holding', () => {
  it('holds a button’s prompt offline, behind what is already held, and reports it as held', async () => {
    holdMessage(1, 'typed first');
    online = false;
    window.dispatchEvent(new Event('offline'));
    expect(await sendPrompt({ id: 1, status: 'idle' }, 'Push the branch')).toBe('held');
    expect(heldFor(1).map((h) => h.text)).toEqual(['typed first', 'Push the branch']);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('holds behind held messages online too, so it cannot overtake them', async () => {
    holdMessage(1, 'waiting for the session');
    expect(await sendToSession(1, 'and then this')).toBe('held');
    expect(heldFor(1).map((h) => h.text)).toEqual(['waiting for the session', 'and then this']);
  });

  it('holds a command like a message, in order: the release sends only into an idle session', async () => {
    holdMessage(1, 'starts a turn once released');
    expect(await sendToSession(1, '/model opus')).toBe('held');
    expect(heldFor(1).map((h) => h.text)).toEqual(['starts a turn once released', '/model opus']);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('sends a command at once in an idle session', async () => {
    const sent = sendToSession(1, '/compact');
    await vi.advanceTimersByTimeAsync(100);
    expect(await sent).toBe('sent');
  });

  it('sends at once with nothing held and the connection up', async () => {
    const sent = sendToSession(1, '/clear');
    await vi.advanceTimersByTimeAsync(100);
    expect(await sent).toBe('sent');
    expect(writes).toEqual(['paste:/clear', 'enter:/clear']);
  });
});

describe('a running turn (#61)', () => {
  const fact = (op: 'prompt' | 'turn-end', ts: number) =>
    recordQueueOperations([op === 'prompt' ? { op, sessionId: 'send-s1', text: 'p', ts } : { op, sessionId: 'send-s1', ts }]);

  beforeEach(() => {
    seedQueue(['send-s1'], []);
    vi.mocked(ptyLiveSince).mockReturnValue(Date.now() - 60_000);
    noteTaskSessions([{ id: 1, sessionId: 'send-s1' }]);
    fact('prompt', Date.now() - 1_000);
  });

  afterEach(() => seedQueue(['send-s1'], []));

  it('holds a button\u2019s prompt for the turn, and reports it as held', async () => {
    expect(await sendPrompt({ id: 1, status: 'running' }, 'Create the PR')).toBe('held');
    expect(heldFor(1).map((h) => h.text)).toEqual(['Create the PR']);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('holds a button\u2019s command for the turn too', async () => {
    expect(await sendToSession(1, '/compact')).toBe('held');
    expect(heldFor(1).map((h) => h.text)).toEqual(['/compact']);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('a delivered submit counts as a turn starting until the transcript says otherwise', async () => {
    fact('turn-end', Date.now() - 500);
    expect(isTurnRunning(1)).toBe(false);
    const sent = sendToSession(1, 'go');
    await vi.advanceTimersByTimeAsync(100);
    expect(await sent).toBe('sent');
    expect(isTurnRunning(1)).toBe(true);
    // So the next message is held rather than typed into the turn it started.
    expect(await sendToSession(1, 'and then')).toBe('held');
  });
});

describe('one write at a time', () => {
  it('two sends at once never interleave: each Enter follows its own paste', async () => {
    const a = submitLocked(1, 'from a button');
    const b = submitLocked(1, 'from the composer');
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([a, b]);
    expect(writes).toEqual(['paste:from a button', 'enter:from a button', 'paste:from the composer', 'enter:from the composer']);
  });

  it('a button send waits for a release under way', async () => {
    holdMessage(1, 'held one');
    const release = releaseHeld(1, (t) => submitLocked(1, t));
    // Released and empty now, but the write is still in its pause.
    const button = submitLocked(1, 'Create the PR');
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([release, button]);
    expect(writes).toEqual(['paste:held one', 'enter:held one', 'paste:Create the PR', 'enter:Create the PR']);
  });

  it('other sessions are not held up', async () => {
    void submitLocked(1, 'one');
    void submitLocked(2, 'two');
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['paste:one', 'paste:two']);
    await vi.advanceTimersByTimeAsync(100);
  });
});

describe('isSlashCommand', () => {
  it('is a command name after a slash, trimmed, arguments or not', () => {
    for (const t of ['/clear', '/compact', '  /model opus  ', '/model claude-opus-5-5', '/review:pr 12', '/clear\n']) {
      expect(isSlashCommand(t)).toBe(true);
    }
  });

  it('is not a path, a lone slash, or text that mentions a command', () => {
    for (const t of ['/Users/me/Desktop/shot.png look', '/', '/ clear', '/2fa is broken', 'run /clear', '', 'see a/b']) {
      expect(isSlashCommand(t)).toBe(false);
    }
  });
});
