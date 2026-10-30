/**
 * @vitest-environment jsdom
 *
 * Renaming a task (#152): the title that is saved, and where the session's
 * `/rename` goes -- through the real send gateway and outbox, with only the
 * pty and the prompt gate stood in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  live: new Set<number>(),
  presence: new Set<(taskId: number, live: boolean) => void>(),
  writes: [] as [number, string][],
  prompt: false,
}));

vi.mock('./Terminal', () => ({
  hasLivePty: (id: number) => h.live.has(id),
  ptyLiveSince: (id: number) => (h.live.has(id) ? Date.now() - 60_000 : null),
  onPtyPresenceChange: (cb: (taskId: number, live: boolean) => void) => {
    h.presence.add(cb);
    return () => void h.presence.delete(cb);
  },
  submitPty: vi.fn(async (taskId: number, text: string) => {
    h.writes.push([taskId, text]);
    return true;
  }),
}));
vi.mock('./transcript/outboxRelease', () => ({ promptOpen: () => h.prompt }));

import { __resetConnectivity } from '../lib/connectivity';
import { __resetOutbox, heldFor, holdMessage } from './transcript/outbox';
import { __resetTurns, noteTaskSessions } from './transcript/turn';
import { recordQueueOperations, seedQueue } from '../capture/queue';
import {
  __resetSessionRename,
  MAX_TITLE,
  oneLine,
  pendingSessionRename,
  RENAME_HINT,
  renameCommand,
  renamedTitle,
  renameSession,
  renameTaskAndSession,
} from './taskRename';

function goLive(taskId: number): void {
  h.live.add(taskId);
  for (const cb of [...h.presence]) cb(taskId, true);
}

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  __resetConnectivity(async () => true);
  __resetOutbox();
  __resetSessionRename();
  h.live.clear();
  h.presence.clear();
  h.writes.length = 0;
  h.prompt = false;
});

afterEach(() => {
  __resetConnectivity();
  __resetOutbox();
  __resetTurns();
  __resetSessionRename();
});

describe('renamedTitle: what a rename saves', () => {
  it('trims, and makes one line of whitespace and control characters', () => {
    expect(renamedTitle('  Fix the login  ', 'old')).toBe('Fix the login');
    expect(renamedTitle('Fix\nthe\t\tlogin', 'old')).toBe('Fix the login');
    expect(renamedTitle('Fix\u001b[2Jlogin', 'old')).toBe('Fix [2Jlogin');
  });

  it('refuses empty and whitespace only: the old title stays', () => {
    expect(renamedTitle('', 'old')).toBeNull();
    expect(renamedTitle('   \n\t', 'old')).toBeNull();
  });

  it('saves nothing when nothing changed', () => {
    expect(renamedTitle(' old ', 'old')).toBeNull();
  });

  it(`caps at ${MAX_TITLE} characters, never cutting an emoji in half`, () => {
    expect(renamedTitle('a'.repeat(MAX_TITLE + 50), 'old')).toBe('a'.repeat(MAX_TITLE));
    const emoji = renamedTitle('😀'.repeat(MAX_TITLE + 1), 'old');
    expect(Array.from(emoji ?? '')).toHaveLength(MAX_TITLE);
    expect(emoji?.endsWith('😀')).toBe(true);
  });

  it('says on the hint that the branch and folder stay', () => {
    expect(RENAME_HINT).toContain('branch and the folder stay');
    expect(RENAME_HINT).toContain('/rename');
  });
});

describe('renameCommand', () => {
  it('is one line, and never a bare /rename (which makes a name up)', () => {
    expect(renameCommand('Fix\nlogin ')).toBe('/rename Fix login');
    expect(renameCommand('  ')).toBeNull();
    expect(oneLine('a\r\nb')).toBe('a b');
  });
});

describe('renameSession: where /rename goes', () => {
  it('a live, idle session: sent now, through the gateway', async () => {
    h.live.add(1);
    expect(await renameSession({ id: 1, sessionId: 's1' }, 'New name')).toBe('sent');
    expect(h.writes).toEqual([[1, '/rename New name']]);
  });

  it('a live session mid-turn: held in the outbox, not typed into the turn', async () => {
    h.live.add(1);
    seedQueue(['rn-s1'], []);
    noteTaskSessions([{ id: 1, sessionId: 'rn-s1' }]);
    recordQueueOperations([{ op: 'prompt', sessionId: 'rn-s1', text: 'p', ts: Date.now() - 1_000 }]);
    try {
      expect(await renameSession({ id: 1, sessionId: 'rn-s1' }, 'New name')).toBe('held');
      expect(heldFor(1).map((m) => m.text)).toEqual(['/rename New name']);
      expect(h.writes).toEqual([]);
    } finally {
      seedQueue(['rn-s1'], []);
    }
  });

  it('a live session behind held messages: held after them, in order', async () => {
    h.live.add(1);
    holdMessage(1, 'typed first');
    expect(await renameSession({ id: 1, sessionId: 's1' }, 'New name')).toBe('held');
    expect(heldFor(1).map((m) => m.text)).toEqual(['typed first', '/rename New name']);
    expect(h.writes).toEqual([]);
  });

  it('a live session waiting on a prompt: held, never typed into it, never put in the message box', async () => {
    h.live.add(1);
    h.prompt = true;
    expect(await renameSession({ id: 1, sessionId: 's1' }, 'New name')).toBe('held');
    expect(heldFor(1).map((m) => m.text)).toEqual(['/rename New name']);
    expect(h.writes).toEqual([]);
  });

  it('no session yet: nothing to send, the first spawn names it', async () => {
    expect(await renameSession({ id: 1, sessionId: null }, 'New name')).toBe('on-start');
    expect(pendingSessionRename(1)).toBeNull();
    expect(heldFor(1)).toEqual([]);
  });

  it('a session not running: nothing now, and nothing starts it', async () => {
    expect(await renameSession({ id: 1, sessionId: 's1' }, 'New name')).toBe('pending');
    expect(heldFor(1)).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(pendingSessionRename(1)).toBe('/rename New name');
  });

  it('queued once when it next runs, with the latest title only', async () => {
    await renameSession({ id: 1, sessionId: 's1' }, 'First');
    await renameSession({ id: 1, sessionId: 's1' }, 'Second');
    goLive(2); // another task: nothing for it
    expect(heldFor(2)).toEqual([]);
    goLive(1);
    expect(heldFor(1).map((m) => m.text)).toEqual(['/rename Second']);
    expect(pendingSessionRename(1)).toBeNull();
    // Once: a later start (a restart) queues nothing more.
    goLive(1);
    expect(heldFor(1).map((m) => m.text)).toEqual(['/rename Second']);
  });

  it('a rename while live drops one still waiting from before', async () => {
    await renameSession({ id: 1, sessionId: 's1' }, 'Stale');
    h.live.add(1);
    expect(await renameSession({ id: 1, sessionId: 's1' }, 'Fresh')).toBe('sent');
    expect(pendingSessionRename(1)).toBeNull();
    goLive(1);
    expect(heldFor(1)).toEqual([]);
    expect(h.writes).toEqual([[1, '/rename Fresh']]);
  });
});

describe('renameTaskAndSession', () => {
  it('saves the title first, then sends', async () => {
    h.live.add(1);
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push('save');
      return true;
    });
    const session = vi.fn(async () => {
      order.push('session');
      return 'sent' as const;
    });
    expect(await renameTaskAndSession({ id: 1, sessionId: 's1' }, 'New', save, session)).toBe('sent');
    expect(save).toHaveBeenCalledWith(1, 'New');
    expect(order).toEqual(['save', 'session']);
  });

  it('sends nothing when the title could not be saved', async () => {
    const session = vi.fn();
    expect(await renameTaskAndSession({ id: 1, sessionId: 's1' }, 'New', async () => false, session)).toBe('failed');
    expect(session).not.toHaveBeenCalled();
  });
});
