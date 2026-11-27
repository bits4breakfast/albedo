// @vitest-environment jsdom
/**
 * Draft first, ready when checks pass (#464): the draft PR that Create PR
 * opened is marked ready for review once -- only when every check passes,
 * only while the review still holds (unless it went through "Create PR
 * without Review…"), only if it is yours and its head is in this repository,
 * never for a draft Albedo did not ask for, never carried to a later PR, and
 * never twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrStatus } from './prStatus';
import type { ReviewGate } from '../guide/gate';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/me' }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: async () => {}, writeTextFile: async () => {} }));

const { setPrFetcherForTests, refreshPrStatus } = await import('./prStore');
const { setReviewed } = await import('../guide/store');
const {
  BIND_WINDOW_MS,
  bindRecord,
  checkDraft,
  draftHint,
  draftRecordOf,
  draftStep,
  notePrRequested,
  setDraftReadyForTests,
  MAX_RECORDS,
} = await import('./draftReady');

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
  headSha: 'abc', mergedAt: null, review: null, checks: { kind: 'passing', total: 3 }, lines: [],
  author: 'me', crossRepository: false, ...over,
});
const READY: ReviewGate = { kind: 'ready', total: 2 };
const STALE: ReviewGate = { kind: 'stale', commitsSince: 1 };
/** A record bound to PR #12. */
const rec = (escape = false, done: number[] = []) => ({ at: 1, escape, done, pr: 12 });

describe('draftStep', () => {
  it('marks ready the bound draft, its checks passing, the review holding, yours', () => {
    expect(draftStep(rec(), pr(), READY, 'me')).toBe('ready');
    // Not known yet: the branch has to be read first.
    expect(draftStep(rec(), pr(), null, 'me')).toBe('gate');
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

  it('never for another PR, an unbound or retired record, one already done, or a PR that is not a draft', () => {
    expect(draftStep(null, pr(), READY)).toBeNull();
    expect(draftStep({ at: 1, escape: false, done: [] }, pr(), READY)).toBeNull();
    expect(draftStep({ ...rec(), retired: true }, pr(), READY)).toBeNull();
    expect(draftStep(rec(), pr({ number: 13 }), READY)).toBeNull();
    expect(draftStep(rec(false, [12]), pr(), READY)).toBeNull();
    expect(draftStep(rec(), pr({ state: 'open' }), READY)).toBeNull();
    expect(draftStep(rec(), null, READY)).toBeNull();
    expect(draftStep(rec(), undefined, READY)).toBeNull();
  });

  it('only yours, from this repository', () => {
    expect(draftStep(rec(), pr({ author: 'someone' }), READY, 'me')).toBeNull();
    expect(draftStep(rec(), pr(), READY, null)).toBeNull();
    expect(draftStep(rec(), pr({ crossRepository: true }), READY, 'me')).toBeNull();
    expect(draftStep(rec(), pr({ crossRepository: undefined }), READY, 'me')).toBeNull();
  });
});

describe('bindRecord: one record, one PR', () => {
  const fresh = { at: 1_000, escape: false, done: [] as number[] };

  it('binds to the first PR seen after Create PR, a draft', () => {
    expect(bindRecord(fresh, pr(), 2_000)).toEqual({ ...fresh, pr: 12 });
    // Nothing yet: waits.
    expect(bindRecord(fresh, null, 2_000)).toEqual(fresh);
  });

  it('a first PR that is not a draft retires it: Claude opened it ready, or it is another PR', () => {
    const retired = bindRecord(fresh, pr({ state: 'open' }), 2_000);
    expect(retired).toEqual({ ...fresh, pr: 12, retired: true, done: [12] });
    // Converted back to a draft later: still never touched.
    expect(draftStep(bindRecord(retired, pr(), 3_000), pr(), READY, 'me')).toBeNull();
  });

  it('never moves to a later PR: #12 closed, a new draft #13 inherits nothing, escape or not', () => {
    const bound = bindRecord({ ...fresh, escape: true }, pr(), 2_000);
    const later = pr({ number: 13 });
    expect(bindRecord(bound, later, 3_000)).toEqual(bound);
    expect(draftStep(bound, later, READY, 'me')).toBeNull();
  });

  it('expires when no PR came within the window: a draft made weeks later is left alone', () => {
    const expired = bindRecord(fresh, null, fresh.at + BIND_WINDOW_MS + 1);
    expect(expired.retired).toBe(true);
    expect(bindRecord(fresh, pr(), fresh.at + BIND_WINDOW_MS + 1).retired).toBe(true);
    expect(draftStep(bindRecord(expired, pr(), Date.now()), pr(), READY, 'me')).toBeNull();
  });
});

describe('draftHint', () => {
  const now = 2;
  it('says when the draft opens for review', () => {
    const unbound = { at: 1, escape: false, done: [] as number[] };
    expect(draftHint(unbound, pr({ checks: { kind: 'pending', pending: 1, total: 3 } }), READY, now)).toBe('Opens for review when checks pass');
    expect(draftHint(rec(), pr(), STALE, now)).toBe('Opens for review once the guide is reviewed again');
    expect(draftHint(rec(true), pr(), STALE, now)).toBe('Opens for review when checks pass');
  });

  it('says nothing for a failing check, a PR done, another PR, a fork, or none of ours', () => {
    expect(draftHint(rec(), pr({ checks: { kind: 'failing', failing: 1, total: 3 } }), READY, now)).toBeNull();
    expect(draftHint(rec(false, [12]), pr(), READY, now)).toBeNull();
    expect(draftHint(rec(), pr({ number: 13 }), READY, now)).toBeNull();
    expect(draftHint(rec(), pr({ crossRepository: true }), READY, now)).toBeNull();
    expect(draftHint(null, pr(), READY, now)).toBeNull();
  });
});

describe('the record', () => {
  it('a later press starts over, unbound, and keeps the PRs done', () => {
    data.set('albedo.pr.draftReady', JSON.stringify({ 4: { at: 10, escape: true, done: [3], pr: 3, retired: true } }));
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
  /** The seams: the write, the gate, the read's head (the PR's own by default), and gh's login. */
  function seams(
    write: () => { ok: true } | { ok: false; message: string },
    gate: () => Promise<ReviewGate>,
    opts: { head?: string | null; viewer?: string | null } = {},
  ): number[] {
    const marked: number[] = [];
    setDraftReadyForTests(async (p) => (marked.push(p.number), write()), gate, {
      head: () => (opts.head === undefined ? 'abc' : opts.head),
      viewer: async () => (opts.viewer === undefined ? 'me' : opts.viewer),
    });
    return marked;
  }

  it('marks it ready once, logs it, and never again -- not on a rerun, not after a failure', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    const marked = seams(() => ({ ok: false, message: 'HTTP 502' }), async () => READY);
    await checkDraft(task);
    expect(marked).toEqual([12]);
    expect(draftRecordOf(task.id)).toMatchObject({ pr: 12, done: [12], retired: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('PR #12 not marked ready: HTTP 502'));
    // gh failed: still never repeated.
    await checkDraft(task);
    await checkDraft(task);
    expect(marked).toEqual([12]);
  });

  it('two checks at once write once', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    const marked = seams(() => ({ ok: true }), async () => READY);
    await Promise.all([checkDraft(task), checkDraft(task)]);
    expect(marked).toEqual([12]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('PR #12 marked ready for review'));
  });

  it('does nothing on failing checks, or while they run -- and stays bound to that PR', async () => {
    notePrRequested(task.id, false);
    const marked = seams(() => ({ ok: true }), async () => READY);
    await withPr(pr({ checks: { kind: 'failing', failing: 1, total: 3 } }));
    await checkDraft(task);
    await withPr(pr({ checks: { kind: 'pending', pending: 1, total: 3 } }));
    await checkDraft(task);
    expect(marked).toEqual([]);
    expect(draftRecordOf(task.id)).toMatchObject({ pr: 12, done: [] });
  });

  it('waits while the guide is out of date, then marks it once reviewed again', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    let gate: ReviewGate = STALE;
    const looked = vi.fn(async () => gate);
    const marked = seams(() => ({ ok: true }), looked);
    await checkDraft(task);
    expect(marked).toEqual([]);
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

  it('not when GitHub’s head is not the commit the review read: a push from elsewhere holds it', async () => {
    notePrRequested(task.id, false);
    await withPr(pr({ headSha: 'remote-only' }));
    const marked = seams(() => ({ ok: true }), async () => READY, { head: 'abc' });
    await checkDraft(task);
    expect(marked).toEqual([]);
  });

  it('not when the PR moved on while the branch was read', async () => {
    notePrRequested(task.id, false);
    await withPr(pr());
    const marked = seams(
      () => ({ ok: true }),
      async () => {
        // A push lands while the gate is read.
        await withPr(pr({ headSha: 'def' }));
        return READY;
      },
    );
    await checkDraft(task);
    expect(marked).toEqual([]);
  });

  it('not someone else’s PR, nor while gh’s login is unknown', async () => {
    notePrRequested(task.id, true);
    await withPr(pr({ author: 'someone' }));
    const marked = seams(() => ({ ok: true }), async () => READY);
    await checkDraft(task);
    expect(marked).toEqual([]);
    notePrRequested(task.id, true);
    await withPr(pr());
    const unknown = seams(() => ({ ok: true }), async () => READY, { viewer: null });
    await checkDraft(task);
    expect(unknown).toEqual([]);
  });

  it('through the escape hatch, the guide is not looked at', async () => {
    notePrRequested(task.id, true);
    await withPr(pr());
    const looked = vi.fn(async () => STALE);
    const marked = seams(() => ({ ok: true }), looked);
    await checkDraft(task);
    expect(marked).toEqual([12]);
    expect(looked).not.toHaveBeenCalled();
  });

  it('a record never carries to a later PR: #12 opened ready, a draft #13 later is left alone', async () => {
    notePrRequested(task.id, true);
    await withPr(pr({ state: 'open' }));
    const marked = seams(() => ({ ok: true }), async () => READY);
    await checkDraft(task);
    expect(draftRecordOf(task.id)).toMatchObject({ pr: 12, retired: true });
    await withPr(pr({ number: 13 }));
    await checkDraft(task);
    expect(marked).toEqual([]);
  });

  it('leaves a draft alone that Create PR did not ask for', async () => {
    await withPr(pr());
    const marked = seams(() => ({ ok: true }), async () => READY);
    await checkDraft(task);
    expect(marked).toEqual([]);
  });
});
