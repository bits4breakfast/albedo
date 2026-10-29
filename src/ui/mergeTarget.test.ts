import { describe, expect, it } from 'vitest';
import type { PrStatus } from '../gh/prStatus';
import { branchTooltip, mergeTarget } from './mergeTarget';

const work = { kind: 'work' as const, branch: 'fix-login', baseBranch: 'main' };
const pr = (baseRefName: string) => ({ number: 12, baseRefName }) as PrStatus;

describe('mergeTarget', () => {
  it('is the branch the task was cut from while there is no PR', () => {
    expect(mergeTarget(work, null)).toEqual({ base: 'main', from: 'cut' });
  });

  it("is the PR's base once there is one, which follows a restack", () => {
    // Cut from main, now stacked on another task's branch.
    expect(mergeTarget(work, pr('add-export'))).toEqual({ base: 'add-export', from: 'pr' });
  });

  it('falls back to the cut when gh did not name a base', () => {
    expect(mergeTarget(work, pr(''))).toEqual({ base: 'main', from: 'cut' });
  });

  it('is nothing for a chat, or a task with no branch or base', () => {
    expect(mergeTarget({ kind: 'chat', branch: '', baseBranch: '' }, null)).toBeNull();
    expect(mergeTarget({ ...work, baseBranch: '' }, null)).toBeNull();
  });
});

describe('branchTooltip', () => {
  it('says where the base came from', () => {
    expect(branchTooltip('fix-login', { base: 'main', from: 'cut' }, null)).toBe('Branch fix-login, cut from main');
    expect(branchTooltip('fix-login', { base: 'add-export', from: 'pr' }, 12)).toBe(
      'Branch fix-login, merging into add-export (PR #12)',
    );
    expect(branchTooltip('fix-login', null, null)).toBe('Branch fix-login');
  });
});
