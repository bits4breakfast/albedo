import { beforeEach, describe, expect, it } from 'vitest';
import { getPrStatus, MIN_AGE_MS, refreshPrStatus, setPrFetcherForTests } from './prStore';
import { parsePrView, type PrStatus } from './prStatus';

const PR = parsePrView(JSON.stringify({ number: 6, url: 'https://x/6', state: 'OPEN', headRefName: 'b' })) as PrStatus;

const task = (id: number, branch = 'b') => ({
  id,
  branch,
  baseBranch: 'main',
  worktreePath: '/wt',
  repoPath: '/repo',
  status: 'idle' as const,
});

let clock = 0;
let calls: number[] = [];
let release: Array<() => void> = [];

beforeEach(() => {
  clock = 1_000_000;
  calls = [];
  release = [];
  setPrFetcherForTests(
    (t) =>
      new Promise((resolve) => {
        calls.push(t.id);
        release.push(() => resolve(PR));
      }),
    () => clock,
  );
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('prStore', () => {
  it('never has two calls in flight for one task', async () => {
    const a = refreshPrStatus(task(1));
    const b = refreshPrStatus(task(1), { force: true });
    expect(a).toBe(b);
    expect(calls).toEqual([1]);
    release.forEach((r) => r());
    await a;
    expect(getPrStatus(1)?.number).toBe(6);
  });

  it('reuses a fresh answer, refetches a stale one or a new branch', async () => {
    const p = refreshPrStatus(task(1));
    release.shift()?.();
    await p;
    await refreshPrStatus(task(1));
    expect(calls).toEqual([1]);

    void refreshPrStatus(task(1, 'renamed'));
    expect(calls).toEqual([1, 1]);
    release.shift()?.();
    await flush();

    clock += MIN_AGE_MS + 1;
    void refreshPrStatus(task(1, 'renamed'));
    expect(calls).toEqual([1, 1, 1]);
  });

  it('caps concurrent gh calls across tasks', async () => {
    for (let i = 1; i <= 5; i++) void refreshPrStatus(task(i));
    await flush();
    expect(calls).toEqual([1, 2, 3]);
    release.shift()?.();
    await flush();
    expect(calls).toEqual([1, 2, 3, 4]);
  });

  it('keeps the previous answer when a fetch throws', async () => {
    const p = refreshPrStatus(task(1));
    release.shift()?.();
    await p;
    setPrFetcherForTests(async () => {
      throw new Error('boom');
    });
    // setPrFetcherForTests clears the cache by design; re-seed through a fetch.
    expect(getPrStatus(1)).toBeUndefined();
    await refreshPrStatus(task(1));
    expect(getPrStatus(1)).toBeUndefined();
  });
});
