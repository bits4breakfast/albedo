/**
 * Going back to the Guide reads every changed file's base side again (#365):
 * an `ls-tree` and a `cat-file` per file, for a commit that cannot change.
 * Kept by commit id; never for `HEAD`, which moves; a failed read is not kept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setGitRunner, type GitRunner } from '../git/worktree';
import { forgetBaseReadsForTests, loadBranchDiff, MAX_BASE_READS } from './branchDiff';

const SHA = (n: number) => String(n).repeat(40).slice(0, 40);
const atBase: Record<string, string> = { 'a.ts': 'one\n', 'b.ts': 'x\n' };
const blobId: Record<string, string> = { 'a.ts': 'aaa1', 'b.ts': 'bbb2' };
const onDisk: Record<string, string> = { 'a.ts': 'two\n', 'b.ts': 'y\n' };

let mergeBase: string | null = SHA(1);
let reads: Array<{ cmd: string; rev?: string; cwd?: string }> = [];
let failCatFile = false;

const fake: GitRunner = async (args, cwd) => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const cmd = args[0] === '-c' ? args[2] : args[0];
  if (cmd === 'rev-parse') return { code: 128, stdout: '', stderr: 'no upstream' };
  if (cmd === 'merge-base') return mergeBase ? ok(`${mergeBase}\n`) : { code: 1, stdout: '', stderr: '' };
  if (cmd === 'ls-files') return ok('');
  if (cmd === 'diff') return ok('1\t1\ta.ts\x001\t1\tb.ts\0');
  if (cmd === 'ls-tree') {
    reads.push({ cmd, rev: args[3], cwd });
    const path = args.at(-1)!;
    return ok(`100644 blob ${blobId[path]} ${atBase[path]!.length}\t${path}\0`);
  }
  if (cmd === 'cat-file') {
    reads.push({ cmd, cwd });
    if (failCatFile) return { code: 1, stdout: '', stderr: 'boom' };
    const path = Object.keys(blobId).find((p) => args[2] === blobId[p])!;
    return ok(atBase[path]!);
  }
  throw new Error(`unexpected git ${args.join(' ')}`);
};

let prev: GitRunner | null = null;
beforeEach(() => {
  prev = setGitRunner(fake);
  forgetBaseReadsForTests();
  mergeBase = SHA(1);
  reads = [];
  failCatFile = false;
});
afterEach(() => {
  if (prev) setGitRunner(prev);
});

const load = (wt = '/wt') => loadBranchDiff(wt, 'main', async (p) => onDisk[p] ?? null);
const shape = (l: Awaited<ReturnType<typeof load>>) => l.diff.files.map((f) => [f.path, f.change, f.added, f.removed]);

describe('loadBranchDiff: base sides kept by commit (#365)', () => {
  it('reads each file at the merge base once, and gives the same diff the second time', async () => {
    const first = await load();
    expect(reads).toHaveLength(4);
    reads = [];
    const again = await load();
    expect(reads).toEqual([]);
    expect(shape(again)).toEqual(shape(first));
    expect(again.diff.hash).toBe(first.diff.hash);
  });

  it('reads again at another commit, or in another folder', async () => {
    await load();
    reads = [];
    mergeBase = SHA(2);
    await load();
    expect(reads.filter((r) => r.cmd === 'ls-tree').map((r) => r.rev)).toEqual([SHA(2), SHA(2)]);
    reads = [];
    await load('/other');
    expect(reads.every((r) => r.cwd === '/other')).toBe(true);
    expect(reads).toHaveLength(4);
  });

  it('never keeps HEAD, which moves', async () => {
    mergeBase = null;
    await load();
    reads = [];
    await load();
    expect(reads).toHaveLength(4);
  });

  it('does not keep a read that failed', async () => {
    failCatFile = true;
    await expect(load()).rejects.toThrow();
    failCatFile = false;
    reads = [];
    await load();
    expect(reads.filter((r) => r.cmd === 'cat-file')).toHaveLength(2);
  });

  it('keeps the last few commits only', async () => {
    for (let i = 1; i <= MAX_BASE_READS + 1; i++) {
      mergeBase = SHA(i);
      await load();
    }
    reads = [];
    mergeBase = SHA(1);
    await load();
    expect(reads).toHaveLength(4);
    reads = [];
    mergeBase = SHA(MAX_BASE_READS + 1);
    await load();
    expect(reads).toEqual([]);
  });
});
