import { describe, expect, it } from 'vitest';
import { canSquashRebase, createPrPrompt, nextStep, pushPrompt, squashRebasePrompt } from './gitPrompts';

const task = { branch: 'albedo/fix-retry', baseBranch: 'main' };

describe('git prompts', () => {
  it('wraps each prompt as the action it is, for the transcript to name', () => {
    expect(pushPrompt(task)).toMatch(/^<albedo-action kind="push">\n[\s\S]*\n<\/albedo-action>$/);
    expect(createPrPrompt(task)).toContain('<albedo-action kind="create-pr">');
    expect(squashRebasePrompt(task, { includeUncommitted: false, push: false, commitCount: 1 })).toContain(
      '<albedo-action kind="squash-rebase">',
    );
  });

  it('names the branch to push and never forces blindly', () => {
    const p = pushPrompt(task);
    expect(p).toContain('`albedo/fix-retry`');
    expect(p).toContain('--force-with-lease');
    expect(p).not.toMatch(/--force(?!-with-lease)/);
  });

  it('rebases onto the base, and does not push unless asked', () => {
    const p = squashRebasePrompt(task, { includeUncommitted: false, push: false, commitCount: 3 });
    expect(p).toContain('`origin/main`');
    expect(p).toContain('I count 3 commits');
    expect(p).toContain('stash them');
    expect(p).toContain('Do not push.');
  });

  it('carries the choices the dialog offers', () => {
    const p = squashRebasePrompt(task, { includeUncommitted: true, push: true, commitCount: 1 });
    expect(p).toContain('I count 1 commit on');
    expect(p).toContain('Include the uncommitted changes');
    expect(p).toContain('--force-with-lease');
    expect(p).not.toContain('Do not push.');
  });

  it('offers squash & rebase only on a branch of its own', () => {
    expect(canSquashRebase(task)).toBe(true);
    expect(canSquashRebase({ branch: 'main', baseBranch: 'main' })).toBe(false);
    expect(canSquashRebase({ branch: '', baseBranch: 'main' })).toBe(false);
  });
});

describe('createPrPrompt', () => {
  it('targets the base and writes from the whole branch', () => {
    const p = createPrPrompt(task);
    expect(p).toContain('`albedo/fix-retry` into `main`');
    expect(p).toContain('gh pr create --base main');
    expect(p).toContain('every commit on the branch');
  });
});

describe('nextStep', () => {
  const base = { dirty: 0, unpushed: 0, commits: 3, hasPr: false, prable: true };
  it('pushes first, whatever else is true', () => {
    expect(nextStep({ ...base, dirty: 2 })).toBe('push');
    expect(nextStep({ ...base, unpushed: 1, hasPr: true })).toBe('push');
  });
  it('then offers a PR, then the PR itself', () => {
    expect(nextStep(base)).toBe('create-pr');
    expect(nextStep({ ...base, hasPr: true })).toBe('open-pr');
  });
  it('offers nothing on the base branch or an empty one', () => {
    expect(nextStep({ ...base, prable: false })).toBe('none');
    expect(nextStep({ ...base, commits: 0 })).toBe('none');
  });
});
