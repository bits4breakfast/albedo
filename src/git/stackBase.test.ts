import { describe, expect, it } from 'vitest';
import { branchNameOf, nearestParent, olderCopyParent, sourceBranchName } from './stackBase';

const REMOTES = new Set(['origin']);

describe('branchNameOf', () => {
  it('reads local and remote refs as one branch name', () => {
    expect(branchNameOf('refs/heads/add-export')).toBe('add-export');
    expect(branchNameOf('refs/remotes/origin/add-export')).toBe('add-export');
    expect(branchNameOf('refs/heads/backup/pre-rebase')).toBe('backup/pre-rebase');
    expect(branchNameOf('refs/remotes/origin/HEAD')).toBeNull();
  });
});

describe('nearestParent', () => {
  it('is the tip closest to HEAD', () => {
    expect(
      nearestParent(
        [
          { ref: 'refs/remotes/origin/add-export', distance: 2 },
          { ref: 'refs/heads/older-parent', distance: 5 },
        ],
        'fix-login',
      ),
    ).toBe('add-export');
  });

  it("never names the task's own branch, or a sibling at the same commit", () => {
    expect(nearestParent([{ ref: 'refs/remotes/origin/fix-login', distance: 1 }], 'fix-login')).toBeNull();
    expect(nearestParent([{ ref: 'refs/heads/fix-login-copy', distance: 0 }], 'fix-login')).toBeNull();
  });
});

describe('sourceBranchName', () => {
  it('strips a remote, and only a remote', () => {
    expect(sourceBranchName('origin/add-export', REMOTES)).toBe('add-export');
    expect(sourceBranchName('backup/pre-rebase', REMOTES)).toBe('backup/pre-rebase');
    expect(sourceBranchName('origin/HEAD', REMOTES)).toBeNull();
  });
});

describe('olderCopyParent', () => {
  // Newest first, as `git log` prints them: the task's own commit on top of a
  // copy of its parent's, which was amended and pushed since.
  const own = ['Fix login: retry the token refresh once', 'Add export: write the CSV in batches'];

  it('finds the parent by its rewritten commit', () => {
    const lines = ['add-export\tAdd export: write the CSV in batches', 'origin/add-export\tAdd export: write the CSV in batches'];
    expect(olderCopyParent(own, lines, 'fix-login', REMOTES)).toBe('add-export');
  });

  it('is not fooled by a copy of the task itself, or by its own pushed branch', () => {
    const lines = [
      // A backup of this branch holds its newest commit too.
      'backup/fix-login\tFix login: retry the token refresh once',
      'backup/fix-login\tAdd export: write the CSV in batches',
      'origin/fix-login\tAdd export: write the CSV in batches',
    ];
    expect(olderCopyParent(own, lines, 'fix-login', REMOTES)).toBeNull();
  });

  it('ignores short subjects, which turn up anywhere', () => {
    expect(olderCopyParent(['wip', 'fix tests'], ['other\twip', 'other\tfix tests'], 'fix-login', REMOTES)).toBeNull();
  });
});
