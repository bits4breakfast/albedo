import { describe, expect, it } from 'vitest';
import { nameTask } from '../git/slug';
import { buildFollowUp, canFollowUp, followUpPrompt, followUpTitle } from './followUp';

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
  it('carries the project and the original worktree, never the shipped branch as base', () => {
    const f = buildFollowUp(keyed, PR);
    expect(f).toMatchObject({
      projectId: 3,
      title: 'ACME-2398 follow-up',
      originalWorktreePath: '/Users/m/agents/app/ACME-2398',
    });
    expect(f).not.toHaveProperty('baseBranch');
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
