/**
 * @vitest-environment jsdom
 *
 * The queue of what sessions asked for (#157): what joins it, what replaces
 * what, what leaves, what survives a restart, and that nothing in it ever
 * starts a session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./attention', () => ({ noteAgentBlocked: vi.fn() }));

const attention = await import('./attention');
const { KEYS } = await import('./persisted');
const q = await import('./requestQueue');
type Req = import('./requestQueue').QueuedRequest;

const NOW = 1_793_692_800_000;
const DAY = 24 * 60 * 60 * 1000;
const known = { title: 'Fix login', archived: false };

let data: Map<string, string>;

beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  q.__resetRequests();
});
afterEach(() => vi.clearAllMocks());

const session = (id: string, taskId = 3, at = NOW): Req => ({
  id,
  taskId,
  at,
  tool: 'request_session',
  title: `Title ${id}`,
  prompt: 'Do the thing',
  reason: 'Separate work',
  project: null,
  branch: null,
});
const notice = (id: string, taskId = 3, at = NOW): Req => ({ id, taskId, at, tool: 'notify_blocked', message: `m ${id}` });
const reminder = (id: string, taskId = 3): Req => ({
  id,
  taskId,
  at: NOW,
  tool: 'create_reminder',
  text: 'Check',
  due: '2026-11-03T10:00:00+01:00',
  dueMs: NOW + 3_600_000,
  summary: 's',
});

describe('admit (pure)', () => {
  const empty = { items: [], handled: [] };

  it('turns away a seen id, an unknown or archived task, and anything a week old', () => {
    expect(q.admit({ items: [session('a')], handled: [] }, session('a'), known, NOW)).toEqual({ add: false, why: 'seen' });
    expect(q.admit({ items: [], handled: ['a'] }, session('a'), known, NOW)).toEqual({ add: false, why: 'seen' });
    expect(q.admit(empty, session('a'), { title: undefined, archived: false }, NOW)).toEqual({ add: false, why: 'unknown-task' });
    expect(q.admit(empty, session('a'), { title: 'x', archived: true }, NOW)).toEqual({ add: false, why: 'unknown-task' });
    expect(q.admit(empty, session('a', 3, NOW - 7 * DAY), known, NOW)).toEqual({ add: false, why: 'expired' });
  });

  it('caps pending requests of one kind per task', () => {
    let s: import('./requestQueue').QueueState = empty;
    for (let i = 0; i < q.MAX_PENDING_PER_TASK; i++) s = q.withRequest(s, session(`s${i}`), known, NOW);
    expect(q.admit(s, session('over'), known, NOW)).toEqual({ add: false, why: 'too-many' });
    expect(q.admit(s, session('other-task', 4), known, NOW)).toEqual({ add: true, replaces: null });
    expect(q.admit(s, reminder('r'), known, NOW)).toEqual({ add: true, replaces: null });
  });

  it('a newer notice from the same task replaces the older one', () => {
    const s = q.withRequest(empty, notice('n1'), known, NOW);
    expect(q.admit(s, notice('n2'), known, NOW)).toEqual({ add: true, replaces: 'n1' });
    const next = q.withRequest(s, notice('n2'), known, NOW);
    expect(next.items.map((r) => r.id)).toEqual(['n2']);
    expect(next.handled).toEqual(['n1']);
  });

  it('remembers refused ids, so a line read again is refused quietly', () => {
    const s = q.withRequest(empty, session('gone', 99), { title: undefined, archived: false }, NOW);
    expect(s.items).toEqual([]);
    expect(s.handled).toEqual(['gone']);
  });
});

describe('the store', () => {
  it('queues a session request without starting anything, and survives a restart', () => {
    q.receiveRequest(session('a'), known, NOW);
    expect(q.pendingRequests().map((r) => r.id)).toEqual(['a']);
    expect(attention.noteAgentBlocked).not.toHaveBeenCalled();
    q.__resetRequests();
    expect(q.pendingRequests()).toEqual([session('a')]);
    expect(data.has(KEYS.requestQueue)).toBe(true);
  });

  it('cues the user for a fresh notice, but not one written while Albedo was closed', () => {
    q.receiveRequest(notice('n1', 3, NOW - 1_000), known, NOW);
    expect(attention.noteAgentBlocked).toHaveBeenCalledWith(3, 'Fix login', 'm n1');
    vi.mocked(attention.noteAgentBlocked).mockClear();
    q.receiveRequest(notice('n2', 4, NOW - q.NOTICE_FRESH_MS), known, NOW);
    expect(attention.noteAgentBlocked).not.toHaveBeenCalled();
    expect(q.pendingRequests().map((r) => r.id)).toEqual(['n1', 'n2']);
  });

  it('keeps a reminder request pending until #156 can set it', () => {
    expect(q.handleCreateReminder(reminder('r') as never)).toBe('pending');
    q.receiveRequest(reminder('r'), known, NOW);
    expect(q.pendingRequests().map((r) => r.id)).toEqual(['r']);
  });

  it('a dismissed or resolved request leaves and does not come back', () => {
    q.receiveRequest(session('a'), known, NOW);
    q.receiveRequest(session('b'), known, NOW);
    q.dismissRequest('a');
    q.resolveRequest('b');
    expect(q.pendingRequests()).toEqual([]);
    q.receiveRequest(session('a'), known, NOW);
    expect(q.pendingRequests()).toEqual([]);
  });

  it('drops the requests of tasks that are gone, and old ones', () => {
    q.receiveRequest(session('keep', 3), known, NOW);
    q.receiveRequest(session('gone', 4), known, NOW);
    q.keepRequestsFor([3], NOW);
    expect(q.pendingRequests().map((r) => r.id)).toEqual(['keep']);
    q.keepRequestsFor([3], NOW + 7 * DAY);
    expect(q.pendingRequests()).toEqual([]);
  });

  it('reads a damaged store as empty, and skips entries that no longer parse', () => {
    data.set(KEYS.requestQueue, '{not json');
    expect(q.pendingRequests()).toEqual([]);
    q.__resetRequests();
    data.set(KEYS.requestQueue, JSON.stringify({ items: ['{"task":3}', 7], handled: ['x', 1] }));
    expect(q.pendingRequests()).toEqual([]);
  });
});
