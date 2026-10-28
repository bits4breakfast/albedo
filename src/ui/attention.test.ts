import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setAttentionBackend,
  announcementFor,
  attentionFor,
  attentionMarks,
  clearAttention,
  noteQuestion,
  noteStatusChange,
  notificationFor,
  NOTIFICATIONS_KEY,
  NOTIFY_MIN_INTERVAL_MS,
  onAttention,
  setNotificationsEnabled,
  shouldNotify,
} from './attention';

describe('attentionFor', () => {
  it('asks for attention when a task becomes blocked', () => {
    expect(attentionFor('running', 'blocked')).toBe('blocked');
    expect(attentionFor('idle', 'blocked')).toBe('blocked');
  });

  it('asks once when a running task finishes its turn', () => {
    expect(attentionFor('running', 'idle')).toBe('finished');
  });

  it('stays quiet when the same status is reported again', () => {
    // Capture ticks on every transcript append; a task blocked for ten minutes
    // must not bounce the dock on each one.
    expect(attentionFor('blocked', 'blocked')).toBeNull();
    expect(attentionFor('running', 'running')).toBeNull();
  });

  it('stays quiet for a prompt the user just answered themselves', () => {
    // blocked -> idle is you answering the permission prompt. Bouncing the
    // dock at someone for something they did a second ago is noise.
    expect(attentionFor('blocked', 'idle')).toBeNull();
  });

  it('stays quiet for starting, archiving and the rest', () => {
    expect(attentionFor('idle', 'running')).toBeNull();
    expect(attentionFor('running', 'archived')).toBeNull();
    expect(attentionFor('idle', 'done')).toBeNull();
  });
});

describe('marks and the OS bounce', () => {
  let bounces: boolean[];
  const setup = (focused: boolean) => {
    bounces = [];
    __setAttentionBackend((critical) => bounces.push(critical), focused);
  };

  beforeEach(() => setup(false));

  it('bounces critically for blocked and once for finished', () => {
    noteStatusChange(1, 'running', 'blocked');
    noteStatusChange(2, 'running', 'idle');
    expect(bounces).toEqual([true, false]);
  });

  it('does not bounce the dock when the window already has focus', () => {
    setup(true);
    noteStatusChange(1, 'running', 'blocked');
    expect(bounces).toEqual([]);
    // ...but the row is still marked: that is the whole in-window cue.
    expect(attentionMarks().get(1)).toBe('blocked');
  });

  it('marks the task in both focus states, so you can see which one', () => {
    noteStatusChange(7, 'running', 'blocked');
    expect(attentionMarks().get(7)).toBe('blocked');
  });

  it('clears when the task is selected', () => {
    noteStatusChange(7, 'running', 'blocked');
    clearAttention(7);
    expect(attentionMarks().has(7)).toBe(false);
  });

  it('notifies subscribers, and stops after the disposer runs', () => {
    const seen: number[] = [];
    const off = onAttention((m) => seen.push(m.size));
    expect(seen).toEqual([0]); // current state on subscribe
    noteStatusChange(1, 'running', 'blocked');
    expect(seen).toEqual([0, 1]);
    off();
    noteStatusChange(2, 'running', 'blocked');
    expect(seen).toEqual([0, 1]);
  });

  it('survives a throwing subscriber', () => {
    const good = vi.fn();
    onAttention(() => {
      throw new Error('boom');
    });
    onAttention(good);
    expect(() => noteStatusChange(1, 'running', 'blocked')).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});

describe('announcementFor', () => {
  const title = (id: number) => (id === 1 ? 'Fix login' : null);

  it('speaks for a task that newly needs you', () => {
    expect(announcementFor(new Map(), new Map([[1, 'blocked']]), title)).toBe(
      'Fix login needs you: waiting on a permission prompt.',
    );
  });

  it('speaks when a task finishes, falling back to the id without a title', () => {
    expect(announcementFor(new Map(), new Map([[2, 'finished']]), title)).toBe('Task 2 finished.');
  });

  it('stays silent for marks that persist or clear', () => {
    const marks = new Map([[1, 'blocked' as const]]);
    expect(announcementFor(marks, marks, title)).toBe('');
    expect(announcementFor(marks, new Map(), title)).toBe('');
  });

  it('speaks again when a mark changes kind', () => {
    expect(announcementFor(new Map([[1, 'blocked']]), new Map([[1, 'finished']]), title)).toBe(
      'Fix login finished.',
    );
  });
});

describe('system notifications', () => {
  let posted: { title: string; body: string; taskId: number }[];
  const setup = (focused: boolean) => {
    posted = [];
    __setAttentionBackend(() => {}, focused, (n) => posted.push(n));
  };

  // The suite runs in node: give the off switch a storage to live in.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    setup(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('quotes the question when a turn ends on one, instead of "finished"', () => {
    noteStatusChange(1, 'running', 'idle', 'Security audit', 'Fold these into the report, or do them now?');
    expect(posted).toEqual([{ title: 'Security audit', body: 'Fold these into the report, or do them now?', taskId: 1 }]);
    expect(attentionMarks().get(1)).toBe('question');
  });

  it('bounces once and posts for a question asked while agents keep the task running', () => {
    const bounces: boolean[] = [];
    __setAttentionBackend((critical) => bounces.push(critical), false, (n) => posted.push(n));
    noteQuestion(3, 'Audit', 'Shall I push?');
    expect(bounces).toEqual([false]);
    expect(posted).toEqual([{ title: 'Audit', body: 'Shall I push?', taskId: 3 }]);
  });

  it('never lets a question replace a prompt that is waiting on you', () => {
    noteStatusChange(4, 'running', 'blocked', 'Deploy');
    noteQuestion(4, 'Deploy', 'Go?');
    expect(attentionMarks().get(4)).toBe('blocked');
  });

  it('reads the switch from storage', () => {
    window.localStorage.setItem(NOTIFICATIONS_KEY, 'off');
    noteStatusChange(1, 'running', 'blocked', 'Fix login');
    expect(posted).toEqual([]);
  });

  it('names the task when it starts waiting on you or finishes, while unfocused', () => {
    noteStatusChange(1, 'running', 'blocked', 'Fix login');
    noteStatusChange(2, 'running', 'idle', 'Write docs');
    expect(posted.map((n) => n.title)).toEqual(['Fix login', 'Write docs']);
    expect(posted[0]?.body).toMatch(/waiting on you/i);
    expect(posted[1]?.body).toMatch(/finished/i);
  });

  it('stays quiet while the window has focus', () => {
    setup(true);
    noteStatusChange(1, 'running', 'blocked', 'Fix login');
    expect(posted).toEqual([]);
  });

  it('stays quiet for transitions that are not events', () => {
    noteStatusChange(1, 'blocked', 'idle', 'Fix login'); // you answered it
    noteStatusChange(1, 'idle', 'running', 'Fix login');
    expect(posted).toEqual([]);
  });

  it('is rate-limited per task', () => {
    noteStatusChange(1, 'running', 'idle', 'A');
    noteStatusChange(1, 'running', 'idle', 'A');
    noteStatusChange(2, 'running', 'idle', 'B');
    expect(posted.map((n) => n.title)).toEqual(['A', 'B']);
  });

  it('respects the off switch', () => {
    setNotificationsEnabled(false);
    noteStatusChange(1, 'running', 'blocked', 'Fix login');
    expect(posted).toEqual([]);
    setNotificationsEnabled(true);
    noteStatusChange(2, 'running', 'blocked', 'Other');
    expect(posted).toHaveLength(1);
  });

  it('falls back to the id for an untitled task', () => {
    expect(notificationFor('finished', '  ', 9).title).toBe('Task 9');
  });
});

describe('shouldNotify', () => {
  it('allows one per task and kind per interval', () => {
    const last = new Map<string, number>();
    expect(shouldNotify(last, 1, 'finished', 0)).toBe(true);
    expect(shouldNotify(last, 1, 'finished', NOTIFY_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldNotify(last, 1, 'finished', NOTIFY_MIN_INTERVAL_MS)).toBe(true);
  });

  it('never lets a recent "finished" swallow a "blocked"', () => {
    const last = new Map<string, number>();
    expect(shouldNotify(last, 1, 'finished', 0)).toBe(true);
    expect(shouldNotify(last, 1, 'blocked', 10)).toBe(true);
  });

  it('a suppressed attempt does not extend the window', () => {
    const last = new Map<string, number>();
    shouldNotify(last, 1, 'blocked', 0);
    shouldNotify(last, 1, 'blocked', NOTIFY_MIN_INTERVAL_MS / 2);
    expect(shouldNotify(last, 1, 'blocked', NOTIFY_MIN_INTERVAL_MS)).toBe(true);
  });
});
