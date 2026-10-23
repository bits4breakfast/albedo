/**
 * @vitest-environment jsdom
 *
 * The per-task draft store: what is kept, what clears it, and that it still
 * works with no storage at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KEYS } from '../persisted';
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_WRITE_DELAY_MS,
  __resetDrafts,
  draftsCodec,
  dropDraft,
  flushDrafts,
  getDraft,
  keepDraftsFor,
  keepUnsent,
  saveDraft,
  withoutExpired,
} from './drafts';

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** This environment's localStorage is not a working Storage: give it one. */
function installStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): void {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  const data = new Map<string, string>();
  installStorage({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  });
  __resetDrafts();
});

afterEach(() => {
  __resetDrafts();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** What a restart sees: storage only. */
function restart(): void {
  flushDrafts();
  __resetDrafts();
}

describe('draftsCodec', () => {
  it('round-trips text and pastes, and drops a malformed entry rather than everything', () => {
    const drafts = new Map([[3, { text: 'hi [Pasted text #1 +4 lines]', pastes: [[1, 'a\nb\nc\nd']] as const, savedAt: T0 }]]);
    const raw = draftsCodec.encode(drafts) as string;
    const back = draftsCodec.decode(raw);
    expect(back).toEqual(drafts);

    const mixed = JSON.stringify({ ...JSON.parse(raw), 4: { text: 7 }, x: { text: 'a', pastes: [], savedAt: 1 } });
    expect([...(draftsCodec.decode(mixed) ?? new Map()).keys()]).toEqual([3]);
  });

  it('removes the key when there are no drafts', () => {
    expect(draftsCodec.encode(new Map())).toBeNull();
  });

  it('withoutExpired keeps the same map when nothing is a week old', () => {
    const drafts = new Map([[1, { text: 'a', pastes: [], savedAt: T0 }]]);
    expect(withoutExpired(drafts, T0 + DAY)).toBe(drafts);
    expect(withoutExpired(drafts, T0 + DRAFT_MAX_AGE_MS).size).toBe(0);
  });
});

describe('the store', () => {
  it('keeps one draft per task', () => {
    saveDraft(1, 'for A', new Map());
    saveDraft(2, 'for B', new Map());
    expect(getDraft(1)?.text).toBe('for A');
    expect(getDraft(2)?.text).toBe('for B');
  });

  it('keeps the pastes the placeholders stand for', () => {
    saveDraft(1, 'see [Pasted text #2 +3 lines]', new Map([[2, 'x\ny\nz']]));
    expect(getDraft(1)?.pastes).toEqual([[2, 'x\ny\nz']]);
  });

  it('treats an empty or whitespace-only draft as none', () => {
    saveDraft(1, 'something', new Map());
    saveDraft(1, '  \n', new Map());
    expect(getDraft(1)).toBeNull();
  });

  it('survives a restart, written after the delay rather than on every keystroke', () => {
    saveDraft(1, 'typed', new Map([[1, 'pasted']]));
    expect(window.localStorage.getItem(KEYS.composerDrafts)).toBeNull();
    vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
    expect(window.localStorage.getItem(KEYS.composerDrafts)).not.toBeNull();

    __resetDrafts();
    expect(getDraft(1)).toEqual({ text: 'typed', pastes: [[1, 'pasted']], savedAt: T0 });
  });

  it('drops a dropped draft from storage too', () => {
    saveDraft(1, 'typed', new Map());
    restart();
    dropDraft(1);
    restart();
    expect(getDraft(1)).toBeNull();
    expect(window.localStorage.getItem(KEYS.composerDrafts)).toBeNull();
  });

  it('expires a draft once it is a week old', () => {
    saveDraft(1, 'old', new Map());
    saveDraft(2, 'newer', new Map(), T0 + 3 * DAY);
    expect(getDraft(1, T0 + DRAFT_MAX_AGE_MS - 1)?.text).toBe('old');
    expect(getDraft(1, T0 + DRAFT_MAX_AGE_MS)).toBeNull();

    // And a restart a week later does not bring it back.
    saveDraft(3, 'fresh', new Map());
    restart();
    vi.setSystemTime(T0 + DRAFT_MAX_AGE_MS);
    expect(getDraft(3)).toBeNull();
    expect(getDraft(2)?.text).toBe('newer');
  });

  it('marks a cancelled send as not sent, until its text changes', () => {
    keepUnsent(1, 'held', new Map([[1, 'p']]));
    expect(getDraft(1)).toEqual({ text: 'held', pastes: [[1, 'p']], savedAt: T0, notSent: true });
    restart();
    saveDraft(1, 'held', new Map([[1, 'p']])); // the restore writing it back
    expect(getDraft(1)?.notSent).toBe(true);
    saveDraft(1, 'held, edited', new Map());
    expect(getDraft(1)?.notSent).toBeUndefined();
  });

  it('keepDraftsFor drops archived and deleted tasks, and the expired', () => {
    saveDraft(1, 'live', new Map());
    saveDraft(2, 'archived', new Map());
    saveDraft(3, 'old', new Map(), T0 - DRAFT_MAX_AGE_MS);
    keepDraftsFor([1, 3, 9]);
    expect(getDraft(1)?.text).toBe('live');
    expect(getDraft(2)).toBeNull();
    expect(getDraft(3)).toBeNull();
  });

  it('still keeps drafts within the session when storage throws', () => {
    const denied = () => {
      throw new Error('denied');
    };
    installStorage({ getItem: denied, setItem: denied, removeItem: denied });
    saveDraft(1, 'kept in memory', new Map());
    expect(() => vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS)).not.toThrow();
    expect(getDraft(1)?.text).toBe('kept in memory');
  });
});
