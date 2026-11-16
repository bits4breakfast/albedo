/**
 * A task's base against a real git repository (#237). The owner's case: a
 * task cut from a parent feature branch, whose local copy was deleted once it
 * merged -- only `origin/<parent>` is left -- and whose PR was retargeted to
 * `main`. Before the fix `taskBase` found no merge base, and the Files pane
 * read that as "No changes yet".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseOrUpstream, loadChangeSet, setGitRunner, taskBase, type GitRunner } from './worktree';
import { loadBranchDiff } from '../guide/branchDiff';

let root: string;
let restore: GitRunner | null = null;

function sh(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

function commit(path: string, text: string, message: string): void {
  writeFileSync(join(root, path), text);
  sh('add', path);
  sh('commit', '-q', '-m', message);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'measured-base-'));
  sh('init', '-q', '-b', 'main');
  commit('base.txt', 'base\n', 'base');
  // The parent feature branch, then the task's branch on top of it.
  sh('checkout', '-q', '-b', 'feature-a');
  commit('a.txt', 'a\n', 'feature a');
  sh('checkout', '-q', '-b', 'feature-b');
  commit('b1.txt', 'b1\n', 'feature b one');
  commit('b2.txt', 'b2\n', 'feature b two');
  // Only origin's copy of the parent is left: the local branch is deleted.
  sh('update-ref', 'refs/remotes/origin/feature-a', 'feature-a');
  sh('update-ref', 'refs/remotes/origin/main', 'main');
  sh('branch', '-q', '-D', 'feature-a');
  restore = setGitRunner(async (args, cwd) => {
    try {
      const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  });
});

afterAll(() => {
  if (restore) setGitRunner(restore);
  rmSync(root, { recursive: true, force: true });
});

describe('a base with no local branch, only origin’s (#237)', () => {
  it('is measured against origin/<base>', async () => {
    expect(await baseOrUpstream(root, 'feature-a')).toBe('origin/feature-a');
    expect(await taskBase(root, 'feature-a')).not.toBeNull();
  });

  it('lists the branch’s own changes, not an empty set', async () => {
    const set = await loadChangeSet(root, 'feature-a');
    expect([...set.lines.keys()].sort()).toEqual(['b1.txt', 'b2.txt']);
    expect(set.commits.map((c) => c.subject)).toEqual(['feature b two', 'feature b one']);
  });

  it('measured against main instead -- the PR’s base -- the parent’s commits count too', async () => {
    expect([...(await loadChangeSet(root, 'main')).lines.keys()].sort()).toEqual(['a.txt', 'b1.txt', 'b2.txt']);
    const read = await loadBranchDiff(root, 'main', async () => null);
    expect(read.fromMergeBase).toBe(true);
  });

  it('a base git has nowhere still has no merge base, which callers must say', async () => {
    expect(await taskBase(root, 'gone-everywhere')).toBeNull();
    const read = await loadBranchDiff(root, 'gone-everywhere', async () => null);
    expect(read.fromMergeBase).toBe(false);
  });

  it('a local base is still the local branch (or its upstream), never origin’s by default', async () => {
    expect(await baseOrUpstream(root, 'main')).toBe('main');
  });

  it("the main checkout's browse diff (base '') is unchanged: HEAD's upstream, else nothing", async () => {
    // feature-b has no upstream configured: '' resolves to '' as before.
    expect(await baseOrUpstream(root, '')).toBe('');
    expect(await taskBase(root, '')).toBeNull();
  });
});
