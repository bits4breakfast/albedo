// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYS } from '../ui/persisted';
import { buildBranchDiff, fileBlockIndex, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import {
  capGuides,
  clearWriteError,
  ensureNotes,
  focusNotes,
  guidesCodec,
  keepLastRead,
  lastReadOf,
  loadGuide,
  MAX_LAST_READS,
  loadReviewed,
  notesStateOf,
  retryNotes,
  resetGuideStoreForTests,
  reviewedKey,
  reviewingTaskIds,
  saveGuide,
  setReviewed,
  startWrite,
  writeStateOf,
} from './store';
import type { Guide } from './validate';
import { setOneshotRunner, type OneshotOutput } from './writer';

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

  it('stays bounded: a task whose guide is gone loses its marks at the next change', () => {
    saveGuide(1, guide(10));
    setReviewed(1, ['a.ts#aaaa'], true);
    setReviewed(2, ['b.ts#bbbb'], true); // no guide for task 2 yet: its own marks stay
    expect(loadReviewed(2).size).toBe(1);
    setReviewed(1, ['a.ts#cccc'], true);
    expect(loadReviewed(1).size).toBe(2);
    expect(loadReviewed(2).size).toBe(0);
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

describe('the last read of the branch (#199)', () => {
  it('keeps only the most recently read few tasks: a read holds both sides of every file', () => {
    const read = (n: number) => ({ diff: buildBranchDiff([], statReason), base: `b${n}`, fromMergeBase: true, uncommitted: new Set<string>() });
    for (let id = 1; id <= MAX_LAST_READS; id++) keepLastRead(id, read(id));
    keepLastRead(1, read(1)); // 1 read again: now the newest
    keepLastRead(99, read(99));
    expect(lastReadOf(2)).toBeNull();
    expect(lastReadOf(1)?.base).toBe('b1');
    expect(lastReadOf(99)?.base).toBe('b99');
  });
});

describe('which tasks are being reviewed (#219)', () => {
  it('a task with a guide and a mark that still names its blocks', () => {
    saveGuide(1, guide(10));
    saveGuide(2, guide(20));
    setReviewed(1, [reviewedKey('a.ts', ['aaaa'])], true);
    expect([...reviewingTaskIds()]).toEqual([1]);
  });

  it('not once the blocks a mark names are gone from the guide (rewritten after the branch moved)', () => {
    saveGuide(1, guide(10));
    setReviewed(1, [reviewedKey('a.ts', ['aaaa'])], true);
    saveGuide(1, { ...guide(30, 'moved'), files: { 'a.ts': ['bbbb'] } });
    expect(reviewingTaskIds().size).toBe(0);
  });

  it('not with no mark left, and not for a mark naming a file the guide has not got', () => {
    saveGuide(1, guide(10));
    setReviewed(1, [reviewedKey('a.ts', ['aaaa'])], true);
    setReviewed(1, [reviewedKey('a.ts', ['aaaa'])], false);
    expect(reviewingTaskIds().size).toBe(0);
    setReviewed(1, [reviewedKey('other.ts', ['aaaa'])], true);
    expect(reviewingTaskIds().size).toBe(0);
  });

  it('reads a path with # in it', () => {
    saveGuide(1, { ...guide(10), files: { 'docs/c#/a.md': ['aaaa'] } });
    setReviewed(1, [reviewedKey('docs/c#/a.md', ['aaaa'])], true);
    expect([...reviewingTaskIds()]).toEqual([1]);
  });
});

describe('notes, a group at a time (#224)', () => {
  let prev: ReturnType<typeof setOneshotRunner> | null = null;
  afterEach(() => {
    if (prev) setOneshotRunner(prev);
    prev = null;
  });

  const result = (structured: unknown): OneshotOutput => ({
    code: 0,
    stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }),
    stderr: '',
    timedOut: false,
  });
  /** Every call waits until the test answers it; `group` is the notes call's group title. */
  function controlled() {
    const calls: Array<{ group: string | null; prompt: string; answer: (o: OneshotOutput) => void }> = [];
    prev = setOneshotRunner(
      (req) =>
        new Promise<OneshotOutput>((answer) => {
          calls.push({ group: /^Group: (.*)$/m.exec(req.prompt)?.[1] ?? null, prompt: req.prompt, answer });
        }),
    );
    return calls;
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const notesFor = (paths: readonly string[], note: string) => result({ notes: paths.map((path) => ({ path, note: `${note} ${path}` })) });

  // Three groups of two files, each file +3 -3: every group is asked about.
  const big = (path: string) => edited(path, [3, 4, 5]);
  let diff: BranchDiff;
  const at = (path: string) => diff.files.find((f) => f.path === path)!.blocks;
  const makeGuide = (writtenAt: number, over: Partial<Guide> = {}): Guide => ({
    diffHash: diff.hash,
    writtenAt,
    base: 'main',
    groups: [
      { title: 'G1', summary: 'one', blocks: [...at('src/a1.ts'), ...at('src/a2.ts')] },
      { title: 'G2', summary: 'two', blocks: [...at('src/b1.ts'), ...at('src/b2.ts')] },
      { title: 'G3', summary: 'three', blocks: [...at('src/c1.ts'), ...at('src/c2.ts')] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
    ...over,
  });
  beforeEach(() => {
    diff = buildBranchDiff(['src/a1.ts', 'src/a2.ts', 'src/b1.ts', 'src/b2.ts', 'src/c1.ts', 'src/c2.ts'].map(big), statReason);
  });

  it('asks one group at a time, in reading order, and saves each group’s notes as they land', async () => {
    const calls = controlled();
    const g = makeGuide(10);
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['G1']);
    expect(notesStateOf(1, 10, 0)).toBe('pending');
    expect(notesStateOf(1, 10, 2)).toBe('pending');
    calls[0]!.answer(notesFor(['src/a1.ts', 'src/a2.ts'], 'why'));
    await settle();
    expect(loadGuide(1)!.groups[0]!.notes).toEqual({ 'src/a1.ts': 'why src/a1.ts', 'src/a2.ts': 'why src/a2.ts' });
    expect(notesStateOf(1, 10, 0)).toBeNull();
    expect(calls.map((c) => c.group)).toEqual(['G1', 'G2']);
  });

  it('the group in view goes next, ahead of the ones before it', async () => {
    const calls = controlled();
    const g = makeGuide(10);
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    // G1 is in flight; the reader moves to G3.
    focusNotes(1, 10, 2);
    calls[0]!.answer(notesFor([], ''));
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['G1', 'G3']);
    calls[1]!.answer(notesFor([], ''));
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['G1', 'G3', 'G2']);
  });

  it('a rewrite drops the queue, and a late answer for the old guide is never saved', async () => {
    const calls = controlled();
    const old = makeGuide(10);
    saveGuide(1, old);
    ensureNotes(1, old, diff);
    await settle();
    const next = makeGuide(20);
    saveGuide(1, next);
    ensureNotes(1, next, diff);
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['G1', 'G1']);
    calls[0]!.answer(notesFor(['src/a1.ts'], 'stale'));
    await settle();
    expect(loadGuide(1)!.groups[0]!.notes).toBeUndefined();
    // The old queue does not go on to G2.
    expect(calls).toHaveLength(2);
    calls[1]!.answer(notesFor(['src/a1.ts'], 'fresh'));
    await settle();
    expect(loadGuide(1)!.groups[0]!.notes).toEqual({ 'src/a1.ts': 'fresh src/a1.ts' });
    expect(notesStateOf(1, 10, 1)).toBeNull();
  });

  it('a failed call costs that group’s notes only: the guide stays, the rest go on, Retry asks again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = controlled();
    const g = makeGuide(10);
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    calls[0]!.answer({ code: null, stdout: '', stderr: '', timedOut: true });
    await settle();
    expect(notesStateOf(1, 10, 0)).toBe('failed');
    expect(loadGuide(1)!.groups.map((x) => x.title)).toEqual(['G1', 'G2', 'G3']);
    calls[1]!.answer(notesFor(['src/b1.ts'], 'why'));
    await settle();
    calls[2]!.answer(notesFor(['src/c1.ts'], 'why'));
    await settle();
    expect(loadGuide(1)!.groups[1]!.notes).toEqual({ 'src/b1.ts': 'why src/b1.ts' });
    expect(loadGuide(1)!.groups[0]!.notes).toBeUndefined();
    retryNotes(1, 10, 0);
    expect(notesStateOf(1, 10, 0)).toBe('pending');
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['G1', 'G2', 'G3', 'G1']);
    calls[3]!.answer(notesFor(['src/a2.ts'], 'why'));
    await settle();
    expect(loadGuide(1)!.groups[0]!.notes).toEqual({ 'src/a2.ts': 'why src/a2.ts' });
    expect(notesStateOf(1, 10, 0)).toBeNull();
    warn.mockRestore();
  });

  it('makes no call for groups with nothing to note', async () => {
    const calls = controlled();
    diff = buildBranchDiff(['src/a1.ts', 'src/a2.ts'].map((p) => edited(p, [3])), statReason);
    const g: Guide = {
      diffHash: diff.hash,
      writtenAt: 10,
      base: 'main',
      groups: [{ title: 'Small', summary: '', blocks: [...diff.order] }],
      files: fileBlockIndex(diff),
      fallback: null,
    };
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    expect(calls).toHaveLength(0);
    expect(notesStateOf(1, 10, 0)).toBeNull();
  });

  it('after a restart, asks only for the groups that still have no notes', async () => {
    const calls = controlled();
    const g = makeGuide(10);
    g.groups[0]!.notes = { 'src/a1.ts': 'kept' };
    g.groups[2]!.notes = {};
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['G2']);
  });

  it('an out-of-date guide gets no new notes', async () => {
    const calls = controlled();
    const g = makeGuide(10, { diffHash: 'moved' });
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('a folder guide gets notes too', async () => {
    const calls = controlled();
    const g = makeGuide(10, { fallback: 'Too many. Grouped by folder instead, with no summaries.' });
    g.groups = [{ title: 'src', summary: '', blocks: [...diff.order] }];
    saveGuide(1, g);
    ensureNotes(1, g, diff);
    await settle();
    expect(calls.map((c) => c.group)).toEqual(['src']);
    expect(calls[0]!.prompt).toContain('- src/a1.ts\n- src/a2.ts\n- src/b1.ts');
  });

  it('startWrite shows the groups first, then asks for their notes', async () => {
    const calls = controlled();
    const run = startWrite(1, diff, 'main');
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.group).toBeNull();
    expect(calls[0]!.prompt).not.toContain('Files to note');
    calls[0]!.answer(result({ groups: [{ title: 'All', summary: 'S', blocks: diff.order }] }));
    await run;
    expect(loadGuide(1)!.groups[0]!.notes).toBeUndefined();
    expect(writeStateOf(1)).toBeNull();
    await settle();
    expect(calls.map((c) => c.group)).toEqual([null, 'All']);
  });
});
