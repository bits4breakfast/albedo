import { afterEach, describe, expect, it } from 'vitest';
import { setGitRunner, type GitRunner } from '../git/worktree';
import { loadBranchDiff, splitZ } from './branchDiff';

/** A repo where a.ts changed on the branch, b.ts is uncommitted, new.ts untracked. */
const atBase: Record<string, string> = { 'a.ts': 'one\n', 'b.ts': 'x\n' };
const blobId: Record<string, string> = { 'a.ts': 'aaa1', 'b.ts': 'bbb2' };
const onDisk: Record<string, string> = { 'a.ts': 'two\n', 'b.ts': 'y\n', 'new.ts': 'n\n' };

const fake: GitRunner = async (args) => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const [cmd] = args;
  if (cmd === 'rev-parse') return { code: 128, stdout: '', stderr: 'no upstream' };
  if (cmd === 'merge-base') return ok('base123\n');
  if (cmd === 'ls-files') return ok('new.ts\0');
  if (cmd === 'diff' && args.includes('base123')) return ok('a.ts\0b.ts\0');
  if (cmd === 'diff' && args.includes('HEAD')) return ok('b.ts\0');
  if (cmd === 'ls-tree') {
    const path = args.at(-1)!;
    const text = atBase[path];
    return ok(text === undefined ? '' : `100644 blob ${blobId[path]} ${text.length}\t${path}\0`);
  }
  if (cmd === 'cat-file') {
    const path = Object.keys(blobId).find((p) => args[2] === blobId[p])!;
    return ok(atBase[path]!);
  }
  throw new Error(`unexpected git ${args.join(' ')}`);
};

let prev: GitRunner | null = null;
afterEach(() => {
  if (prev) setGitRunner(prev);
});

describe('loadBranchDiff', () => {
  it('reads committed, uncommitted and untracked changes against the merge base', async () => {
    prev = setGitRunner(fake);
    const asked: string[] = [];
    const loaded = await loadBranchDiff('/wt', 'main', async (p) => {
      asked.push(p);
      return onDisk[p] ?? null;
    });
    expect(loaded.base).toBe('base123');
    expect(loaded.fromMergeBase).toBe(true);
    expect(loaded.diff.files.map((f) => [f.path, f.change, f.added, f.removed])).toEqual([
      ['a.ts', 'modified', 1, 1],
      ['b.ts', 'modified', 1, 1],
      ['new.ts', 'added', 1, 0],
    ]);
    expect([...loaded.uncommitted].sort()).toEqual(['b.ts', 'new.ts']);
    expect(asked.sort()).toEqual(['a.ts', 'b.ts', 'new.ts']);
  });

  it('splits NUL-separated paths', () => {
    expect(splitZ('a\0b c\0')).toEqual(['a', 'b c']);
    expect(splitZ('')).toEqual([]);
  });
});
