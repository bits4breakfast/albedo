/**
 * The branch sync's sweep (#365): one `git worktree list` per repo instead of
 * one git per task, with the per-task read kept for any folder that list
 * does not name. What gets written is pinned against the per-task read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Array<[number, unknown]>);
vi.mock('../db', async () => ({
  ...(await vi.importActual('../db')),
  updateTask: async (id: number, patch: unknown) => void writes.push([id, patch]),
}));

import type { Task } from '../types';
import { checkedOutBranches, syncBranches } from './branchSync';
import { setGitRunner, type GitRunner } from './worktree';

type T = Pick<Task, 'id' | 'branch' | 'worktreePath' | 'status' | 'createdBranch' | 'repoPath'>;
const task = (id: number, worktreePath: string, branch: string, repoPath = '/repo'): T => ({
  id,
  branch,
  worktreePath,
  repoPath,
  status: 'idle',
  createdBranch: true,
});

/** /repo with worktrees: /repo on main, /wt/a on feature-a, /wt/b detached, /wt/gone prunable. */
const LIST = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /wt/a',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature-a',
  '',
  'worktree /wt/b',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /wt/gone',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/old',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

/** What `symbolic-ref` answers in each folder, as git would. */
const HEADS: Record<string, string | null> = { '/repo': 'main', '/wt/a': 'feature-a', '/wt/b': null, '/elsewhere': 'side' };

let calls: Array<{ args: string[]; cwd?: string }> = [];
let prev: GitRunner;

beforeEach(() => {
  calls = [];
  writes.length = 0;
  prev = setGitRunner(async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'worktree') return cwd === '/broken' ? { code: 128, stdout: '', stderr: 'not a git repo' } : { code: 0, stdout: LIST, stderr: '' };
    if (args[0] === 'symbolic-ref') {
      const head = HEADS[cwd ?? ''];
      return head ? { code: 0, stdout: `${head}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
});
afterEach(() => {
  setGitRunner(prev);
});

describe('syncBranches (#365)', () => {
  it('asks git once per repo, however many tasks are in it', async () => {
    await syncBranches([task(1, '/repo', 'main'), task(2, '/wt/a', 'feature-a'), task(3, '/repo', 'main'), task(4, '/wt/b', 'x')]);
    expect(calls).toEqual([{ args: ['worktree', 'list', '--porcelain'], cwd: '/repo' }]);
  });

  it('writes what the per-task read would: a switched branch, nothing for a detached HEAD', async () => {
    const tasks = [task(1, '/repo', 'build-script'), task(2, '/wt/a/', 'feature-a'), task(3, '/wt/b', 'was-here')];
    await syncBranches(tasks);
    expect(writes).toEqual([[1, { branch: 'main', createdBranch: false }]]);
  });

  it('asks a folder the list does not name on its own: another spelling, a prunable one, a repo git cannot list', async () => {
    await syncBranches([task(5, '/elsewhere', 'main'), task(6, '/wt/gone', 'old'), task(7, '/elsewhere', 'side', '/broken')]);
    const perTask = calls.filter((c) => c.args[0] === 'symbolic-ref').map((c) => c.cwd);
    expect(perTask.sort()).toEqual(['/elsewhere', '/elsewhere', '/wt/gone']);
    expect(writes).toEqual([[5, { branch: 'side', createdBranch: false }]]);
  });

  it('leaves out archived tasks and tasks with no folder', async () => {
    await syncBranches([{ ...task(1, '/repo', 'x'), status: 'archived' }, task(2, '', 'x')]);
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('lists every worktree with its branch, and detached ones as none', async () => {
    const known = await checkedOutBranches('/repo');
    expect([...(known ?? [])]).toEqual([
      ['/repo', 'main'],
      ['/wt/a', 'feature-a'],
      ['/wt/b', null],
    ]);
    expect(await checkedOutBranches('/broken')).toBeNull();
  });
});
