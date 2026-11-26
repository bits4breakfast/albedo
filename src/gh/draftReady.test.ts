// @vitest-environment jsdom
/**
 * Draft first, ready when checks pass (#464): a draft PR that Create PR asked
 * for is marked ready for review once -- only when every check passes, only
 * while the review still holds (unless it went through "Create PR without
 * Review…"), never for a draft Albedo did not ask for, never twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrStatus } from './prStatus';
import type { ReviewGate } from '../guide/gate';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/me' }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: async () => {}, writeTextFile: async () => {} }));

const { setPrFetcherForTests, refreshPrStatus } = await import('./prStore');
const { setReviewed } = await import('../guide/store');
const { checkDraft, draftHint, draftRecordOf, draftStep, notePrRequested, setDraftReadyForTests, MAX_RECORDS } = await import('./draftReady');

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
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setDraftReadyForTests();
  vi.restoreAllMocks();
});

const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
  number: 12, url: 'https://github.com/o/r/pull/12', title: 'x', state: 'draft', headRefName: 'feat', baseRefName: 'main',
  headSha: 'abc', mergedAt: null, review: null, checks: { kind: 'passing', total: 3 }, lines: [], ...over,
});
const READY: ReviewGate = { kind: 'ready', total: 2 };
const STALE: ReviewGate = { kind: 'stale', commitsSince: 1 };
const rec = (escape = false, done: number[] = []) => ({ at: 1, escape, done });

describe('draftStep', () => {
  it('marks ready a draft Albedo asked for, its checks passing, the review holding', () => {
    expect(draftStep(rec(), pr(), READY)).toBe('ready');
    // Not known yet: the branch has to be read first.
    expect(draftStep(rec(), pr(), null)).toBe('gate');
  });

  it('waits while checks run or none are reported yet', () => {
    expect(draftStep(rec(), pr({ checks: { kind: 'pending', pending: 1, total: 3 } }), READY)).toBe('checks');
    expect(draftStep(rec(), pr({ checks: { kind: 'none' } }), READY)).toBe('checks');
  });

  it('never on a failing check: it stays a draft', () => {
    expect(draftStep(rec(), pr({ checks: { kind: 'failing', failing: 1, total: 3 } }), READY)).toBeNull();
    expect(draftStep(rec(true), pr({ checks: { kind: 'failing', failing: 1, total: 3 } }), null)).toBeNull();
  });

  it('never when the guide went out of date since, unless it came through the escape hatch', () => {
    expect(draftStep(rec(), pr(), STALE)).toBeNull();
    expect(draftStep(rec(), pr(), { kind: 'reviewing', reviewed: 1, total: 2 })).toBeNull();
    expect(draftStep(rec(true), pr(), null)).toBe('ready');
    expect(draftStep(rec(true), pr(), STALE)).toBe('ready');
  });

  it('never for a draft Albedo did not ask for, one already done, or a PR that is not a draft', () => {
    expect(draftStep(null, pr(), READY)).toBeNull();
    expect(draftStep(rec(false, [12]), pr(), READY)).toBeNull();
    expect(draftStep(rec(), pr({ state: 'open' }), READY)).toBeNull();
    expect(draftStep(rec(), null, READY)).toBeNull();
    expect(draftStep(rec(), undefined, READY)).toBeNull();
  });
});

describe('draftHint', () => {
  it('says when the draft opens for review', () => {
    expect(draftHint(rec(), pr({ checks: { kind: 'pending', pending: 1, total: 3 } }), READY)).toBe('Opens for review when checks pass');
    expect(draftHint(rec(), pr(), STALE)).toBe('Opens for review once the guide is reviewed again');
    expect(draftHint(rec(true), pr(), STALE)).toBe('Opens for review when checks pass');
    expect(draftHint(rec(), pr({ checks: { kind: 'failing', failing: 1, total: 3 } }), READY)).toBeNull();
    expect(draftHint(rec(false, [12]), pr(), READY)).toBeNull();
    expect(draftHint(null, pr(), READY)).toBeNull();
  });
});

describe('the record', () => {
  it('a later press says whether it skipped the review, and keeps the PRs done', () => {
    notePrRequested(4, true, 10);
    data.set('albedo.pr.draftReady', JSON.stringify({ 4: { at: 10, escape: true, done: [3] } }));
    notePrRequested(4, false, 20);
    expect(draftRecordOf(4)).toEqual({ at: 20, escape: false, done: [3] });
  });

  it('keeps the newest tasks only', () => {
    for (let i = 0; i < MAX_RECORDS + 5; i++) notePrRequested(i, false, i);
    expect(draftRecordOf(0)).toBeNull();
    expect(draftRecordOf(MAX_RECORDS + 4)).not.toBeNull();
  });
});

describe('checkDraft: the one write', () => {
  const task = {
    id: 21, title: 't', kind: 'work', status: 'idle', repoPath: '/r', worktreePath: '/wt', branch: 'feat', baseBranch: 'main',
    reviewUrl: null, lastActivityAt: 1,
  } as const;

  async function withPr(p: PrStatus | null): Promise<void> {
    setPrFetcherForTests(async () => p);
    await refreshPrStatus(task, { force: true });
  }

  it('marks it ready once, logs it, and never again -- not on a rerun, not after a failure', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    const marked: number[] = [];
    setDraftReadyForTests(async (p) => (marked.push(p.number), { ok: false, message: 'HTTP 502' }), async () => READY);
    await checkDraft(task);
    expect(marked).toEqual([12]);
    expect(draftRecordOf(task.id)?.done).toEqual([12]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('PR #12 not marked ready: HTTP 502'));
    // gh failed: still never repeated.
    await checkDraft(task);
    await checkDraft(task);
    expect(marked).toEqual([12]);
  });

  it('two checks at once write once', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    const marked: number[] = [];
    setDraftReadyForTests(async (p) => (marked.push(p.number), { ok: true }), async () => READY);
    await Promise.all([checkDraft(task), checkDraft(task)]);
    expect(marked).toEqual([12]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('PR #12 marked ready for review'));
  });

  it('does nothing on failing checks, or while they run', async () => {
    notePrRequested(task.id, false);
    const marked: number[] = [];
    setDraftReadyForTests(async (p) => (marked.push(p.number), { ok: true }), async () => READY);
    await withPr(pr({ checks: { kind: 'failing', failing: 1, total: 3 } }));
    await checkDraft(task);
    await withPr(pr({ checks: { kind: 'pending', pending: 1, total: 3 } }));
    await checkDraft(task);
    expect(marked).toEqual([]);
    expect(draftRecordOf(task.id)?.done).toEqual([]);
  });

  it('waits while the guide is out of date, then marks it once reviewed again', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    const marked: number[] = [];
    let gate: ReviewGate = STALE;
    const looked = vi.fn(async () => gate);
    setDraftReadyForTests(async (p) => (marked.push(p.number), { ok: true }), looked);
    await checkDraft(task);
    expect(marked).toEqual([]);
    expect(draftRecordOf(task.id)?.done).toEqual([]);
    // Polled again, nothing changed: the branch is not read again.
    await checkDraft(task);
    expect(looked).toHaveBeenCalledTimes(1);
    // Reviewed again: a mark is what changes, and the next look marks it ready.
    gate = READY;
    setReviewed(task.id, ['src/a.ts#b1'], true);
    await checkDraft(task);
    expect(looked).toHaveBeenCalledTimes(2);
    expect(marked).toEqual([12]);
  });

  it('through the escape hatch, the guide is not looked at', async () => {
    notePrRequested(task.id, true);
    await withPr(pr());
    const marked: number[] = [];
    const looked = vi.fn(async () => STALE);
    setDraftReadyForTests(async (p) => (marked.push(p.number), { ok: true }), looked);
    await checkDraft(task);
    expect(marked).toEqual([12]);
    expect(looked).not.toHaveBeenCalled();
  });

  it('leaves a draft alone that Create PR did not ask for', async () => {
    await withPr(pr());
    const marked: number[] = [];
    setDraftReadyForTests(async (p) => (marked.push(p.number), { ok: true }), async () => READY);
    await checkDraft(task);
    expect(marked).toEqual([]);
  });
});
