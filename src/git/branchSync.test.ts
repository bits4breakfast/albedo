import { describe, expect, it } from 'vitest';
import { branchPatch } from './branchSync';

const task = { id: 1, branch: 'main', worktreePath: '/repo', status: 'idle' as const, createdBranch: null };

describe('branchPatch', () => {
  it('records a branch switched under the task', () => {
    expect(branchPatch(task, 'build-script')).toEqual({ branch: 'build-script', createdBranch: null });
  });

  it('changes nothing when git agrees, or has no branch to report', () => {
    expect(branchPatch(task, 'main')).toBeNull();
    expect(branchPatch(task, null)).toBeNull();
    expect(branchPatch(task, '  ')).toBeNull();
  });

  it('stops offering to delete a branch Albedo did not create', () => {
    expect(branchPatch({ ...task, branch: 'albedo/x', createdBranch: true }, 'other')).toEqual({
      branch: 'other',
      createdBranch: false,
    });
  });
});
