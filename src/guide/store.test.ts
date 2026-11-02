// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYS } from '../ui/persisted';
import { buildBranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import {
  capGuides,
  clearWriteError,
  guidesCodec,
  loadGuide,
  loadReviewed,
  resetGuideStoreForTests,
  reviewedKey,
  saveGuide,
  setReviewed,
  startWrite,
  writeStateOf,
} from './store';
import type { Guide } from './validate';
import { setOneshotRunner } from './writer';

/** A fresh in-memory store per test (REGRESSIONS: never the runtime's localStorage). */
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
  resetGuideStoreForTests();
});

const guide = (writtenAt: number, diffHash = 'h'): Guide => ({
  diffHash,
  writtenAt,
  base: 'main',
  groups: [{ title: 'T', summary: 'S', blocks: ['aaaa'] }],
  files: { 'a.ts': ['aaaa'] },
  fallback: null,
});

describe('the guide cache', () => {
  it('keeps one guide per task, read back as written', () => {
    saveGuide(1, guide(10));
    saveGuide(2, guide(20, 'other'));
    expect(loadGuide(1)).toEqual(guide(10));
    expect(loadGuide(2)?.diffHash).toBe('other');
    expect(loadGuide(3)).toBeNull();
  });

  it('stays bounded: the oldest written go first', () => {
    const all = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(i), guide(i)]));
    expect(Object.keys(capGuides(all, 3)).sort()).toEqual(['2', '3', '4']);
  });

  it('drops a malformed entry without losing the rest', () => {
    const raw = JSON.stringify({ 1: guide(1), 2: { diffHash: 3 } });
    expect(Object.keys(guidesCodec.decode(raw) ?? {})).toEqual(['1']);
    data.set(KEYS.reviewGuides, 'not json');
    expect(loadGuide(1)).toBeNull();
  });
});

describe('Reviewed', () => {
  it('is kept per task, and a changed file is no longer reviewed (its key follows its blocks)', () => {
    setReviewed(1, [reviewedKey('a.ts', ['aaaa'])], true);
    expect(loadReviewed(1).has(reviewedKey('a.ts', ['aaaa']))).toBe(true);
    expect(loadReviewed(1).has(reviewedKey('a.ts', ['bbbb']))).toBe(false);
    expect(loadReviewed(2).size).toBe(0);
    setReviewed(1, [reviewedKey('a.ts', ['aaaa'])], false);
    expect(loadReviewed(1).size).toBe(0);
    expect(data.has(KEYS.reviewGuideReviewed)).toBe(false);
  });
});

describe('startWrite', () => {
  let prev: ReturnType<typeof setOneshotRunner>;
  afterEach(() => setOneshotRunner(prev));

  it('saves the result for the task that asked, and is busy meanwhile', async () => {
    const diff = buildBranchDiff([edited('a.ts', [3])], statReason);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    prev = setOneshotRunner(async () => {
      await gate;
      const structured = { groups: [{ title: 'T', summary: 'S', blocks: diff.order }] };
      return { code: 0, stdout: JSON.stringify({ type: 'result', structured_output: structured }), stderr: '', timedOut: false };
    });
    const run = startWrite(7, diff, 'main');
    expect(writeStateOf(7)?.kind).toBe('writing');
    // A second request while one runs is ignored, not a second call.
    await startWrite(7, diff, 'main');
    release();
    await run;
    expect(writeStateOf(7)).toBeNull();
    expect(loadGuide(7)?.diffHash).toBe(diff.hash);
  });

  it('keeps an error to show, saves nothing, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prev = setOneshotRunner(async () => ({ code: null, stdout: '', stderr: '', timedOut: true }));
    await startWrite(8, buildBranchDiff([edited('a.ts', [3])], statReason), 'main');
    expect(writeStateOf(8)).toMatchObject({ kind: 'error', error: 'timeout' });
    expect(loadGuide(8)).toBeNull();
    expect(warn).toHaveBeenCalled();
    clearWriteError(8);
    expect(writeStateOf(8)).toBeNull();
    warn.mockRestore();
  });
});
