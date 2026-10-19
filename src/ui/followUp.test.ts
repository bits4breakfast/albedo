import { describe, expect, it } from 'vitest';
import { nameTask } from '../git/slug';
import {
  buildFollowUp,
  canFollowUp,
  followUpPrompt,
  followUpTaken,
  followUpTitle,
  freeFollowUpTitle,
  nameFollowUp,
} from './followUp';

const keyed = {
  title: 'ACME-2398 fix the login loop',
  branch: 'ACME-2398-fix-the-login-loop',
  baseBranch: 'main',
  projectId: 3,
  worktreePath: '/Users/m/agents/app/ACME-2398',
};
const plain = {
  title: 'Fix the login loop',
  branch: 'fix-the-login-loop',
  baseBranch: 'develop',
  projectId: 3,
  worktreePath: '/Users/m/agents/app/fix-the-login-loop',
};
const PR = { number: 42, url: 'https://github.com/o/r/pull/42', state: 'merged' as const };

describe('followUpTitle', () => {
  it('leads with the issue key', () => {
    expect(followUpTitle(keyed)).toBe('ACME-2398 follow-up');
    expect(nameTask(followUpTitle(keyed))).toMatchObject({
      key: 'ACME-2398',
      branch: 'ACME-2398-follow-up',
    });
  });

  it('prefixes a plain title', () => {
    expect(followUpTitle(plain)).toBe('Follow-up: Fix the login loop');
    expect(nameTask(followUpTitle(plain)).branch).toBe('follow-up-fix-the-login-loop');
  });

  it('always names a branch distinct from the original', () => {
    for (const t of [keyed, plain]) {
      expect(nameTask(followUpTitle(t)).branch).not.toBe(t.branch);
    }
  });

  it('numbers a follow-up of a follow-up rather than reusing its branch', () => {
    const first = { title: 'ACME-2398 follow-up', branch: 'ACME-2398-follow-up' };
    expect(followUpTitle(first)).toBe('ACME-2398 follow-up 2');
    expect(nameTask(followUpTitle(first)).branch).toBe('ACME-2398-follow-up-2');

    const bare = { title: 'ACME-2398', branch: 'ACME-2398' };
    expect(nameTask(followUpTitle(bare)).branch).toBe('ACME-2398-follow-up');
  });
});

describe('followUpPrompt', () => {
  it('names the PR, its URL and branch, and how to read what shipped', () => {
    const p = followUpPrompt(keyed, PR);
    expect(p).toContain('PR #42 (https://github.com/o/r/pull/42)');
    expect(p).toContain('`ACME-2398-fix-the-login-loop`');
    expect(p).toContain('already merged into `main`');
    expect(p).toContain('`gh pr view 42`');
    expect(p).toContain('`gh pr diff 42`');
  });

  it('ends on an empty line for the user to describe the bug', () => {
    expect(followUpPrompt(keyed, PR).endsWith('What is wrong:\n\n')).toBe(true);
    expect(followUpPrompt(plain, null).endsWith('What is wrong:\n\n')).toBe(true);
  });

  it('falls back to the branch and git when no PR is known', () => {
    const p = followUpPrompt(plain, null);
    expect(p).not.toContain('gh pr');
    expect(p).toContain('`fix-the-login-loop`');
    expect(p).toContain('git log --oneline develop..fix-the-login-loop');
    expect(p).toContain('git diff develop...fix-the-login-loop');
  });

  it('does not claim a PR that is not merged', () => {
    expect(followUpPrompt(plain, { ...PR, state: 'closed' })).not.toContain('#42');
  });
});

describe('buildFollowUp', () => {
  it('carries the project, never the shipped branch as base', () => {
    const f = buildFollowUp(keyed, PR);
    expect(f).toMatchObject({ projectId: 3, title: 'ACME-2398 follow-up' });
    expect(f).not.toHaveProperty('baseBranch');
    expect(buildFollowUp(keyed, PR, 'ACME-2398 follow-up 3').title).toBe('ACME-2398 follow-up 3');
  });
});

describe('follow-up worktree folder', () => {
  const root = '/Users/m/agents/app';
  const pathFor = (dir: string) => `${root}/${dir}`;

  it('takes the branch as its folder, so it never lands on the bare-key one', () => {
    expect(nameFollowUp('ACME-2398 follow-up')).toMatchObject({
      branch: 'ACME-2398-follow-up',
      dirName: 'ACME-2398-follow-up',
    });
    // A normal keyed task still gets the bare key: unchanged.
    expect(nameTask('ACME-2398 follow-up').dirName).toBe('ACME-2398');
  });

  it('is distinct from the original while its worktree is still there', async () => {
    const taken = followUpTaken({
      branches: ['main', keyed.branch],
      paths: [keyed.worktreePath],
      pathFor,
      exists: async (p) => p === keyed.worktreePath,
    });
    const title = await freeFollowUpTitle(keyed, taken);
    expect(title).toBe('ACME-2398 follow-up');
    expect(pathFor(nameFollowUp(title).dirName)).not.toBe(keyed.worktreePath);
  });

  it('keeps repeated follow-ups distinct: branch, task path or folder on disk', async () => {
    // First follow-up exists as a task with a branch.
    let taken = followUpTaken({
      branches: ['ACME-2398-follow-up'],
      paths: [],
      pathFor,
      exists: async () => false,
    });
    expect(await freeFollowUpTitle(keyed, taken)).toBe('ACME-2398 follow-up 2');

    // Second one's branch is gone but a task still names its path.
    taken = followUpTaken({
      branches: ['ACME-2398-follow-up'],
      paths: [`${root}/ACME-2398-follow-up-2/`],
      pathFor,
      exists: async () => false,
    });
    expect(await freeFollowUpTitle(keyed, taken)).toBe('ACME-2398 follow-up 3');

    // A leftover directory nobody tracks.
    taken = followUpTaken({
      branches: [],
      paths: [],
      pathFor,
      exists: async (p) => p === `${root}/follow-up-fix-the-login-loop`,
    });
    expect(await freeFollowUpTitle(plain, taken)).toBe('Follow-up: Fix the login loop 2');
  });

  it('treats a failed disk probe as taken', async () => {
    const taken = followUpTaken({
      branches: [],
      paths: [],
      pathFor,
      exists: async (p) => {
        if (p.endsWith('ACME-2398-follow-up')) throw new Error('denied');
        return false;
      },
    });
    expect(await freeFollowUpTitle(keyed, taken)).toBe('ACME-2398 follow-up 2');
  });
});

describe('canFollowUp', () => {
  it('is offered for merged or archived tasks only', () => {
    expect(canFollowUp({ status: 'idle' }, { state: 'merged' })).toBe(true);
    expect(canFollowUp({ status: 'archived' }, null)).toBe(true);
    expect(canFollowUp({ status: 'idle' }, { state: 'open' })).toBe(false);
    expect(canFollowUp({ status: 'running' }, undefined)).toBe(false);
  });
});
