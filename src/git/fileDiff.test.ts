import { afterEach, describe, expect, it } from 'vitest';
import {
  composeFileDiff,
  loadTaskFileDiff,
  looksBinary,
  MAX_DIFF_BYTES,
  parseLsTree,
  parseRenames,
  readAtRev,
  sideFromText,
} from './fileDiff';
import type { Side } from './fileDiff';
import { setGitRunner } from './worktree';
import type { GitResult, GitRunner } from './worktree';

const text = (t: string): Side => ({ kind: 'text', text: t });
const absent: Side = { kind: 'absent' };

describe('sideFromText', () => {
  it('reads null as a file that does not exist', () => {
    expect(sideFromText(null)).toEqual({ kind: 'absent' });
  });
  it('treats an empty file as text, not as absent', () => {
    expect(sideFromText('')).toEqual({ kind: 'text', text: '' });
  });
  it('sniffs binary the way git does: a NUL near the start', () => {
    expect(looksBinary('PNG\0\0\x01')).toBe(true);
    expect(looksBinary('plain\ntext')).toBe(false);
    expect(looksBinary(`${'a'.repeat(9000)}\0`)).toBe(false);
    expect(sideFromText('a\0b').kind).toBe('binary');
  });
  it('refuses past the size guard rather than diffing on the UI thread', () => {
    const big = 'x'.repeat(MAX_DIFF_BYTES + 1);
    expect(sideFromText(big)).toEqual({ kind: 'too-large', bytes: MAX_DIFF_BYTES + 1 });
  });
});

describe('composeFileDiff', () => {
  it('modified: both sides, real line numbers', () => {
    const r = composeFileDiff(text('a\nb\nc\n'), text('a\nB\nc\n'), 'src/x.ts');
    expect(r.kind).toBe('diff');
    if (r.kind !== 'diff') return;
    expect(r.change).toBe('modified');
    expect(r.diff.path).toBe('src/x.ts');
    expect(r.diff.lang).toBe('typescript');
    const changed = r.diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
    expect(changed.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['del', 2, null],
      ['add', null, 2],
    ]);
    expect(r.oldText).toBe('a\nb\nc\n');
    expect(r.newText).toBe('a\nB\nc\n');
  });

  it('added on the branch: everything is an addition', () => {
    const r = composeFileDiff(absent, text('one\ntwo\n'), 'new.md');
    expect(r.kind === 'diff' && r.change).toBe('added');
    if (r.kind !== 'diff') return;
    expect(r.diff.hunks.flatMap((h) => h.lines).every((l) => l.kind === 'add')).toBe(true);
  });

  it('deleted in the worktree: everything is a deletion', () => {
    const r = composeFileDiff(text('gone\n'), absent, 'old.md');
    expect(r.kind === 'diff' && r.change).toBe('deleted');
    if (r.kind !== 'diff') return;
    expect(r.diff.hunks.flatMap((h) => h.lines).map((l) => l.kind)).toEqual(['del']);
  });

  it('renamed: the path takes the "old → new" form the diff header draws', () => {
    const r = composeFileDiff(text('same\n'), text('same\n'), 'src/new.ts', 'src/old.ts');
    expect(r.kind).toBe('diff');
    if (r.kind !== 'diff') return;
    expect(r.change).toBe('renamed');
    expect(r.diff.path).toBe('src/old.ts → src/new.ts');
    expect(r.diff.hunks).toEqual([]);
  });

  it('an edit back to the original reads as unchanged, not as an empty diff of a change', () => {
    const r = composeFileDiff(text('x\n'), text('x\n'), 'a.ts');
    expect(r.kind === 'diff' && r.change).toBe('unchanged');
  });

  it('binary on either side shows no text diff but keeps what changed', () => {
    expect(composeFileDiff(absent, { kind: 'binary' }, 'logo.png')).toEqual({ kind: 'binary', change: 'added' });
    expect(composeFileDiff({ kind: 'binary' }, text('now text'), 'f')).toEqual({ kind: 'binary', change: 'modified' });
  });

  it('too large on either side wins over binary', () => {
    expect(composeFileDiff({ kind: 'too-large', bytes: 9e6 }, { kind: 'binary' }, 'big.bin')).toEqual({
      kind: 'too-large',
      change: 'modified',
      bytes: 9e6,
    });
  });

  it('neither side, and directories', () => {
    expect(composeFileDiff(absent, absent, 'nope')).toEqual({ kind: 'absent' });
    expect(composeFileDiff({ kind: 'not-a-file' }, text(''), 'src')).toEqual({ kind: 'not-a-file' });
  });
});

describe('parseLsTree', () => {
  it('reads blob size, and a tree as having none', () => {
    const out =
      '100644 blob 6a0c0d7e56929f8f79f288f79ef7d86a984231f3    1383\tpackage.json\0' +
      '040000 tree ebc79647bd389dc35714eab441d7d371612c0eee       -\tsrc\0';
    expect(parseLsTree(out)).toEqual([
      { mode: '100644', type: 'blob', object: '6a0c0d7e56929f8f79f288f79ef7d86a984231f3', size: 1383, path: 'package.json' },
      { mode: '040000', type: 'tree', object: 'ebc79647bd389dc35714eab441d7d371612c0eee', size: null, path: 'src' },
    ]);
  });
  it('keeps a path with spaces and tabs verbatim', () => {
    expect(parseLsTree('100644 blob abc 3\tmy dir/a\tb.txt\0')[0]?.path).toBe('my dir/a\tb.txt');
  });
  it('returns nothing for empty output (path not in that revision)', () => {
    expect(parseLsTree('')).toEqual([]);
  });
});

describe('parseRenames', () => {
  it('maps destination to source and skips plain records', () => {
    const out = 'M\0src/App.tsx\0R087\0src/old name.ts\0src/new name.ts\0A\0x\0C100\0a\0b\0D\0gone\0';
    expect([...parseRenames(out)]).toEqual([['src/new name.ts', 'src/old name.ts']]);
  });
});

// ---------------------------------------------------------------------------
// Loaders, against a fake git
// ---------------------------------------------------------------------------

type Script = (args: string[]) => GitResult | undefined;

let restore: GitRunner | null = null;
function fakeGit(script: Script): string[][] {
  const calls: string[][] = [];
  restore = setGitRunner(async (args) => {
    calls.push(args);
    return script(args) ?? { code: 128, stdout: '', stderr: `fatal: unscripted ${args.join(' ')}` };
  });
  return calls;
}
afterEach(() => {
  if (restore) setGitRunner(restore);
  restore = null;
});

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
const blob = (path: string, sha: string, size: number) => ok(`100644 blob ${sha} ${size}\t${path}\0`);

describe('readAtRev', () => {
  it('reads a blob through cat-file', async () => {
    fakeGit((a) => {
      if (a[0] === 'ls-tree') return blob('a.ts', 'aaa', 4);
      if (a[0] === 'cat-file') return ok('old\n');
    });
    expect(await readAtRev('/w', 'base', 'a.ts')).toEqual({ kind: 'text', text: 'old\n' });
  });

  it('never reads a blob over the size guard', async () => {
    const calls = fakeGit((a) => (a[0] === 'ls-tree' ? blob('big.json', 'bbb', MAX_DIFF_BYTES + 1) : undefined));
    expect(await readAtRev('/w', 'base', 'big.json')).toEqual({ kind: 'too-large', bytes: MAX_DIFF_BYTES + 1 });
    expect(calls.some((c) => c[0] === 'cat-file')).toBe(false);
  });

  it('puts the path after --, and refuses an option-like revision', async () => {
    const calls = fakeGit((a) => (a[0] === 'ls-tree' ? ok('') : undefined));
    expect(await readAtRev('/w', 'base', '-rf')).toEqual({ kind: 'absent' });
    expect(calls[0]).toEqual(['ls-tree', '-l', '-z', 'base', '--', '-rf']);
    await expect(readAtRev('/w', '--all', 'a')).rejects.toThrow(/starts with "-"/);
  });
});

describe('loadTaskFileDiff', () => {
  /** taskBase: no upstream, merge base `mb`. */
  const base = (a: string[]): GitResult | undefined => {
    if (a[0] === 'rev-parse') return { code: 128, stdout: '', stderr: 'fatal: no upstream configured' };
    if (a[0] === 'merge-base') return ok('mb\n');
    return undefined;
  };

  it('diffs the merge base against the working tree', async () => {
    const calls = fakeGit(
      (a) =>
        base(a) ??
        (a[0] === 'ls-tree' ? blob('a.ts', 'aaa', 2) : a[0] === 'cat-file' ? ok('x\n') : undefined),
    );
    const r = await loadTaskFileDiff('/w', 'main', 'a.ts', async () => 'y\n');
    expect(r.base).toBe('mb');
    expect(r.fromMergeBase).toBe(true);
    expect(r.result.kind === 'diff' && r.result.change).toBe('modified');
    expect(calls.find((c) => c[0] === 'ls-tree')).toEqual(['ls-tree', '-l', '-z', 'mb', '--', 'a.ts']);
  });

  it('falls back to HEAD when there is no merge base', async () => {
    fakeGit((a) => {
      if (a[0] === 'rev-parse' || a[0] === 'merge-base') return { code: 1, stdout: '', stderr: '' };
      if (a[0] === 'ls-tree') return ok('');
    });
    const r = await loadTaskFileDiff('/w', 'gone', 'n.ts', async () => 'new\n');
    expect(r.base).toBe('HEAD');
    expect(r.fromMergeBase).toBe(false);
    expect(r.result.kind === 'diff' && r.result.change).toBe('added');
  });

  it('follows a rename when the path is new at the base', async () => {
    fakeGit((a) => {
      const b = base(a);
      if (b) return b;
      if (a[0] === 'ls-tree') return a[5] === 'old.ts' ? blob('old.ts', 'eee', 6) : ok('');
      if (a[0] === 'diff') return ok('R095\0old.ts\0new.ts\0');
      if (a[0] === 'cat-file') return ok('a\nb\nc\n');
    });
    const r = await loadTaskFileDiff('/w', 'main', 'new.ts', async () => 'a\nb\nC\n');
    expect(r.result.kind === 'diff' && r.result.change).toBe('renamed');
    expect(r.result.kind === 'diff' && r.result.diff.path).toBe('old.ts → new.ts');
  });

  it('a file deleted in the worktree is all deletions, and no rename lookup runs', async () => {
    const calls = fakeGit(
      (a) => base(a) ?? (a[0] === 'ls-tree' ? blob('d.ts', 'ddd', 2) : a[0] === 'cat-file' ? ok('z\n') : undefined),
    );
    const r = await loadTaskFileDiff('/w', 'main', 'd.ts', async () => null);
    expect(r.result.kind === 'diff' && r.result.change).toBe('deleted');
    expect(calls.some((c) => c[0] === 'diff')).toBe(false);
  });
});
