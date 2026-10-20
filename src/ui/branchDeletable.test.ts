import { describe, expect, it } from 'vitest';
import { branchDeletable } from './ArchiveTaskDialog';

const done = { done: true, createdBranch: false, ahead: 0, files: [] as string[] };

describe('branchDeletable', () => {
  it('offers deleting a branch the task cut, whatever is on it', () => {
    expect(branchDeletable({ ...done, createdBranch: true, ahead: 3, files: ['M a.ts'] })).toBe(true);
  });

  it('offers deleting any branch whose deletion loses nothing', () => {
    expect(branchDeletable(done)).toBe(true);
  });

  it('holds back a branch it did not cut once anything is at stake, or unknown', () => {
    expect(branchDeletable({ ...done, ahead: 1 })).toBe(false);
    expect(branchDeletable({ ...done, files: ['?? new.txt'] })).toBe(false);
    expect(branchDeletable({ ...done, ahead: null })).toBe(false);
    expect(branchDeletable({ ...done, files: null })).toBe(false);
    expect(branchDeletable({ ...done, done: false })).toBe(false);
  });
});
