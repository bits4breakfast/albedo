/**
 * The Files pane, the guide and the file diff against a real git repository
 * (#363): what they read must not change, and reading it must not write
 * `.git/index`.
 *
 * Each test runs the commands the code ran before #363 (`git diff <rev>`
 * against the working tree, which refreshes and writes the index) beside the
 * new reads (the same diff with `diff.autoRefreshIndex=false`, which does
 * not), on a branch holding every kind of change the pane shows: committed
 * and uncommitted edits, additions, deletions, renames, binary files, mode
 * and type changes, an empty file, an intent-to-add file, untracked files,
 * paths git quotes, a repository `diff.algorithm` that changes the counts --
 * and files whose stat is stale but whose content is not, which the old
 * commands hid by refreshing the index. The new reads run first, while those
 * stats are still stale; the old commands run after, since they rewrite it.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchCommits,
  changeKinds,
  changeKindsSince,
  committedFileTimes,
  lineChanges,
  lineChangesSince,
  loadChangeSet,
  parseNameStatus,
  parseNumstat,
  setGitRunner,
  taskBase,
  type GitRunner,
} from './worktree';
import { loadBranchDiff, splitZ } from '../guide/branchDiff';
import { composeFileDiff, loadTaskFileDiff, parseRenames, readAtRev, renameSource, sideFromText } from './fileDiff';
import { buildBranchDiff, type ChangedFile } from '../guide/blocks';
import { statReason } from '../guide/budget';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

let root = '';
let restore: GitRunner | null = null;
const calls: string[][] = [];

function sh(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
}

function write(path: string, text: string | Buffer): void {
  writeFileSync(join(root, path), text);
}

function useRealGit(): void {
  calls.length = 0;
  restore = setGitRunner(async (args, cwd) => {
    calls.push(args);
    try {
      const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  });
}

afterEach(() => {
  if (restore) setGitRunner(restore);
  restore = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const STALE = ['same.txt', 'dir/same too.txt', 'tool.sh'];

/**
 * A branch `feat` off `main` with every kind of change, and three files whose
 * stat is stale but whose content is not. `origin/main` is main's upstream,
 * as on a real clone.
 */
function makeRepo(): void {
  root = mkdtempSync(join(tmpdir(), 'change-set-'));
  sh('init', '-q', '-b', 'main');
  sh('config', 'core.quotePath', 'true');
  // A setting only the porcelain reads: under it these counts differ from
  // the default algorithm's (histogram: +149 -18; myers: +132 -1).
  sh('config', 'diff.algorithm', 'histogram');
  write('algo.c', Array.from({ length: 30 }, (_, i) => `{\n  x${i}();\n}\n`).join('\n'));
  write('a.txt', 'a\nb\nc\n');
  write('gone.txt', 'gone\n');
  write('gone-later.txt', 'still here\n');
  write('big.txt', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n');
  write('bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]));
  write('bin-edit.dat', Buffer.from([0, 9, 9, 9]));
  write('same.txt', 'unchanged\n');
  execFileSync('mkdir', ['-p', join(root, 'dir')]);
  write('dir/same too.txt', 'unchanged too\n');
  write('tool.sh', 'echo hi\n');
  write('mode.sh', 'echo mode\n');
  write('typed.txt', 'a file, then a link\n');
  write('reverted.txt', 'original\n');
  write('empty-gone', '');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  sh('update-ref', 'refs/remotes/origin/main', 'main');
  sh('config', 'remote.origin.url', root);
  sh('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  sh('config', 'branch.main.remote', 'origin');
  sh('config', 'branch.main.merge', 'refs/heads/main');

  sh('checkout', '-q', '-b', 'feat');
  // Committed on the branch.
  write('a.txt', 'a\nB\nc\nd\n');
  write('algo.c', algoEdit(readFileSync(join(root, 'algo.c'), 'utf8')));
  sh('rm', '-q', 'gone.txt');
  sh('mv', 'big.txt', 'moved.txt');
  write('moved.txt', readFileSync(join(root, 'moved.txt'), 'utf8') + 'one more\n');
  write('added.txt', 'new\n');
  write('sp ace ü.txt', 'quoted path\n');
  write('bin-new.dat', Buffer.from([0, 7, 7]));
  chmodSync(join(root, 'mode.sh'), 0o755);
  unlinkSync(join(root, 'typed.txt'));
  symlinkSync('a.txt', join(root, 'typed.txt'));
  write('reverted.txt', 'changed on the branch\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'first');
  write('added.txt', 'new\nand more\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'second\twith a tab');

  // Not committed yet.
  write('a.txt', 'a\nB\nc\nd\ne\n'); // unstaged edit on a committed edit
  write('staged.txt', 'staged\n');
  sh('add', 'staged.txt');
  unlinkSync(join(root, 'gone-later.txt')); // unstaged deletion
  sh('rm', '-q', 'empty-gone'); // staged deletion of an empty file
  sh('mv', 'bin.dat', 'bin-moved.dat'); // staged rename of a binary file
  write('bin-edit.dat', Buffer.from([0, 9, 9, 8, 8]));
  write('empty-new', '');
  sh('add', 'empty-new');
  write('ita.txt', 'intent to add\n');
  sh('add', '-N', 'ita.txt');
  write('reverted.txt', 'original\n'); // back to the base's content: a change against HEAD only
  write('untracked.txt', 'untracked\n');
  write('sp ace untracked.txt', 'untracked too\n');

  // Refresh the index once, then make three stats stale without touching content.
  sh('status', '--porcelain');
  const past = new Date(Date.now() - 3 * 86_400_000);
  for (const p of STALE) utimesSync(join(root, p), past, past);
}

/** Inserts and drops lines in a fixed pattern, so diff algorithms disagree on the counts. */
function algoEdit(text: string): string {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (i % 3 === 0) out.push('{', '  y();', '}', '');
    if (i % 4 === 3) return;
    out.push(line);
  });
  return out.join('\n');
}

/** The index file's bytes and mtime: what a write would change. */
function indexState(): { mtime: number; bytes: string } {
  const p = join(root, '.git', 'index');
  return { mtime: statSync(p).mtimeMs, bytes: readFileSync(p).toString('base64') };
}

/** What the code ran before #363, verbatim. */
const before = {
  lineChanges: (against: string) => parseNumstat(sh('diff', '--numstat', '--no-renames', against)),
  changeKinds: (against: string) => parseNameStatus(sh('diff', '--name-status', '--no-renames', against)),
  renames: (base: string) => parseRenames(sh('diff', '--name-status', '-z', '-M', base, '--')),
  async branchDiff(base: string, read: (p: string) => Promise<string | null>) {
    const tracked = splitZ(sh('diff', '--name-only', '--no-renames', '-z', base, '--'));
    const loose = splitZ(sh('ls-files', '--others', '--exclude-standard', '-z'));
    const dirty = splitZ(sh('diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'));
    const all = [...new Set([...tracked, ...loose])];
    const changed: ChangedFile[] = [];
    for (const path of all) {
      const [oldSide, newText] = await Promise.all([readAtRev(root, base, path), read(path)]);
      changed.push({ path, result: composeFileDiff(oldSide, sideFromText(newText), path) });
    }
    return { diff: buildBranchDiff(changed, statReason), uncommitted: new Set([...dirty, ...loose]) };
  },
};

const readWorking = async (p: string): Promise<string | null> => {
  try {
    return readFileSync(join(root, p), 'utf8');
  } catch {
    return null;
  }
};

// Dozens of real git processes per test: generous under a loaded parallel run.
describe('the change set read without writing the index (#363)', { timeout: 60_000 }, () => {
  it('the repo really has stale stats: listed without the refresh, and git diff rewrites the index', () => {
    makeRepo();
    const listed = sh('-c', 'diff.autoRefreshIndex=false', 'diff', '--name-only', 'HEAD', '--').split('\n');
    for (const p of STALE) expect(listed).toContain(p);
    // The setting the fixture sets does change the counts.
    const counts = (alg: string) =>
      sh('-c', `diff.algorithm=${alg}`, 'diff', '--numstat', 'main', 'HEAD', '--', 'algo.c').split('\t').slice(0, 2);
    expect(counts('histogram')).not.toEqual(counts('myers'));
    const was = indexState();
    sh('diff', '--numstat', 'HEAD');
    expect(indexState()).not.toEqual(was);
  });

  it('leaves .git/index untouched: the pane, the guide and the file diff', async () => {
    makeRepo();
    useRealGit();
    const was = indexState();
    await loadChangeSet(root, 'main');
    await loadChangeSet(root, 'no-such-base');
    await lineChanges(root, 'main');
    await changeKinds(root, 'main');
    await loadBranchDiff(root, 'main', readWorking);
    await loadTaskFileDiff(root, 'main', 'moved.txt', readWorking);
    await loadTaskFileDiff(root, 'main', 'bin-moved.dat', readWorking);
    expect(indexState()).toEqual(was);
    const diffs = calls.filter((c) => c.includes('diff'));
    expect(diffs.length).toBeGreaterThan(0);
    for (const c of diffs) expect(c.slice(0, 3)).toEqual(['-c', 'diff.autoRefreshIndex=false', 'diff']);
  });

  it('the Files pane reads the same lines, kinds, commits and times as before', async () => {
    makeRepo();
    useRealGit();
    const merge = await taskBase(root, 'main');
    expect(merge).not.toBeNull();
    const now = await loadChangeSet(root, 'main');
    const separately = {
      lines: await lineChangesSince(root, merge!),
      kinds: await changeKindsSince(root, merge!),
      commits: await branchCommits(root, 'main'),
      committedAt: await committedFileTimes(root, 'main'),
    };
    const old = { lines: before.lineChanges(merge!), kinds: before.changeKinds(merge!) };

    expect(now.merge).toBe(merge);
    expect(now.lines).toEqual(old.lines);
    expect(now.kinds).toEqual(old.kinds);
    expect(separately.lines).toEqual(old.lines);
    expect(separately.kinds).toEqual(old.kinds);
    expect(now.commits).toEqual(separately.commits);
    expect(now.committedAt).toEqual(separately.committedAt);
    // The fixture does hold what it claims to.
    expect([...old.kinds.values()].sort()).toEqual(expect.arrayContaining(['A', 'D', 'M', 'T']));
    expect([...old.lines.values()]).toContainEqual({ added: null, deleted: null });
    expect(old.lines.get('algo.c')).toBeDefined();
    for (const p of STALE) expect(now.lines.has(p)).toBe(false);
    // A path git quotes is read and keyed the same way as before.
    expect(now.lines.has('"sp ace \\303\\274.txt"')).toBe(true);
    expect(now.commits.map((c) => c.subject)).toEqual(['second\twith a tab', 'first']);
  });

  it('against HEAD when there is no merge base, as before', async () => {
    makeRepo();
    useRealGit();
    const now = await loadChangeSet(root, 'no-such-base');
    expect(now.merge).toBeNull();
    expect(now.commits).toEqual([]);
    expect(now.committedAt).toEqual(new Map());
    expect(now.lines).toEqual(before.lineChanges('HEAD'));
    expect(now.kinds).toEqual(before.changeKinds('HEAD'));
  });

  it('asks git 5 times for the change set, not 14', async () => {
    makeRepo();
    useRealGit();
    await loadChangeSet(root, 'main');
    // rev-parse (main's upstream), merge-base, numstat, name-status, log.
    expect(calls.map((c) => (c[0] === '-c' ? c[2] : c[0]))).toEqual(['rev-parse', 'merge-base', 'diff', 'diff', 'log']);
  });

  it('the guide reads the same files and the same uncommitted set as before', async () => {
    makeRepo();
    useRealGit();
    const now = await loadBranchDiff(root, 'main', readWorking);
    const old = await before.branchDiff(now.base, readWorking);
    expect(now.diff).toEqual(old.diff);
    expect(now.uncommitted).toEqual(old.uncommitted);
    expect(now.diff.files.length).toBeGreaterThan(10);
  });

  it('the file diff finds the same renames as before', async () => {
    makeRepo();
    useRealGit();
    const base = (await taskBase(root, 'main'))!;
    const paths = ['moved.txt', 'bin-moved.dat', 'added.txt', 'staged.txt', 'a.txt', ...STALE];
    const found = new Map<string, string | null>();
    for (const p of paths) found.set(p, await renameSource(root, base, p));
    const old = before.renames(base);
    for (const p of paths) expect(found.get(p)).toBe(old.get(p) ?? null);
    expect(found.get('moved.txt')).toBe('big.txt');
    expect(found.get('bin-moved.dat')).toBe('bin.dat');
  });
});
