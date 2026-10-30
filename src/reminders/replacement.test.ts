/**
 * The new task a reminder opens when its own is gone: each step of the rule
 * in replacement.ts, against a scripted git and a real SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../db/testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { resetDb } from '../db';
import { createProject } from '../db/projects';
import { setGitRunner, setPathExistsProbe, type GitResult, type GitRunner } from '../git/worktree';
import type { Reminder } from '../types';
import { __setHomeDir, openReplacementTask, replacementTitle } from './replacement';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
let calls: string[][];
let restoreGit: GitRunner;
let restoreProbe: (p: string) => Promise<boolean>;
let projectId: number;

/** git as scripted: which refs exist, and what worktree list prints. */
function script(o: { branches?: string[]; commits?: string[]; worktrees?: string; failAdd?: boolean }): GitRunner {
  return async (args): Promise<GitResult> => {
    calls.push(args);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const no = { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      const ref = args[args.length - 1]!;
      if (ref.startsWith('refs/heads/')) return (o.branches ?? []).includes(ref.slice(11)) ? ok(SHA) : no;
      return (o.commits ?? []).includes(ref.replace('^{commit}', '')) ? ok(ref) : no;
    }
    if (args[0] === 'symbolic-ref') return ok('origin/main\n');
    if (args[0] === 'worktree' && args[1] === 'list') return ok(o.worktrees ?? '');
    if (args[0] === 'worktree' && args[1] === 'add') return o.failAdd ? { code: 128, stdout: '', stderr: 'fatal: nope' } : ok();
    return no;
  };
}

function reminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 4, taskId: 1, projectId, text: 'Check the deploy\nmore', dueAt: 0, createdAt: 0, updatedAt: 0,
    createdBy: 'user', sessionId: null, transcriptPath: null, repoPath: '/repo', worktreePath: '/wt/old',
    branch: 'fix/login-retry', headSha: SHA, brief: null, state: 'fired', firedAt: 0, cardTaskId: null,
    ...over,
  };
}

beforeEach(async () => {
  resetDb();
  harness.db = createTestDb();
  calls = [];
  restoreGit = setGitRunner(script({}));
  restoreProbe = setPathExistsProbe(async () => false);
  __setHomeDir(async () => '/home/me');
  projectId = (await createProject({ name: 'repo', repoPath: '/repo', worktreeRoot: '/wts', defaultBaseBranch: 'main' })).id;
});
afterEach(() => {
  setGitRunner(restoreGit);
  setPathExistsProbe(restoreProbe);
});

const adds = () => calls.filter((a) => a[0] === 'worktree' && a[1] === 'add');

describe('openReplacementTask', () => {
  it('titles the task from the first line', () => {
    expect(replacementTitle({ text: 'Check the deploy\nmore' })).toBe('Reminder: Check the deploy');
    expect(replacementTitle({ text: '   ' })).toBe('Reminder: from an earlier task');
  });

  it('a chat comes back as a chat in the main checkout, with no git at all', async () => {
    const t = await openReplacementTask(reminder({ branch: '' }));
    expect(t).toMatchObject({ kind: 'chat', worktreePath: '/repo', ownsWorktree: false, projectId });
    expect(calls).toEqual([]);
  });

  it('the branch, checked out in a worktree already: the task runs there, not owned', async () => {
    setGitRunner(script({
      branches: ['fix/login-retry'],
      worktrees: `worktree /repo\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree /wts/kept\nHEAD ${SHA}\nbranch refs/heads/fix/login-retry\n`,
    }));
    const t = await openReplacementTask(reminder());
    expect(t).toMatchObject({ kind: 'work', branch: 'fix/login-retry', worktreePath: '/wts/kept', ownsWorktree: false, createdBranch: false });
    expect(adds()).toEqual([]);
  });

  it('the branch, not checked out: a new worktree on it, owned, branch not ours', async () => {
    setGitRunner(script({ branches: ['fix/login-retry'] }));
    const t = await openReplacementTask(reminder());
    expect(adds()).toEqual([['worktree', 'add', '--', '/wts/fix-login-retry', 'fix/login-retry']]);
    expect(t).toMatchObject({ branch: 'fix/login-retry', worktreePath: '/wts/fix-login-retry', ownsWorktree: true, createdBranch: false, baseBranch: 'main' });
  });

  it('the branch gone, the commit still there: a new branch cut from it', async () => {
    setGitRunner(script({ commits: [SHA] }));
    const t = await openReplacementTask(reminder());
    const [add] = adds();
    expect(add?.slice(0, 5)).toEqual(['worktree', 'add', '--no-track', '-b', t.branch]);
    expect(add?.[add.length - 1]).toBe(SHA);
    expect(t.branch).toMatch(/^reminder-4-check-the-deploy/);
    expect(t).toMatchObject({ ownsWorktree: true, createdBranch: true, baseBranch: 'main' });
  });

  it('neither left: a new branch from the project default base, in a free folder', async () => {
    let taken = 1;
    setPathExistsProbe(async () => taken-- > 0); // the first folder name is taken
    const t = await openReplacementTask(reminder());
    const [add] = adds();
    expect(add?.[add.length - 1]).toBe('main');
    expect(t.worktreePath).toMatch(/-2$/);
  });

  it('git refusing: a chat in the main checkout, so the card still shows, and it says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setGitRunner(script({ failAdd: true }));
    const t = await openReplacementTask(reminder());
    expect(t).toMatchObject({ kind: 'chat', worktreePath: '/repo' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('no project: throws, and the scheduler tries again later', async () => {
    await expect(openReplacementTask(reminder({ projectId: null, repoPath: '/elsewhere' }))).rejects.toThrow('no project');
  });
});
