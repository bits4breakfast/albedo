import { beforeEach, describe, expect, it } from 'vitest';

import { getReviewWork, probeReviewWork, setWorkProbeForTests, workFrom } from './reviewWork';

const t = { id: 1, repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/wt/b' };

describe('workFrom', () => {
  it('is work when there are commits or uncommitted changes, either one enough', () => {
    expect(workFrom(2, false)).toBe(true);
    expect(workFrom(0, true)).toBe(true);
    expect(workFrom(null, true)).toBe(true);
    expect(workFrom(3, null)).toBe(true);
  });

  it('is no work when git says so, and null only when it answered neither', () => {
    expect(workFrom(0, false)).toBe(false);
    expect(workFrom(null, false)).toBe(false);
    expect(workFrom(null, null)).toBeNull();
  });
});

describe('probeReviewWork', () => {
  let calls: number[];
  beforeEach(() => {
    calls = [];
    setWorkProbeForTests(async (task) => {
      calls.push(task.id);
      return true;
    });
  });

  it('asks git once per finish, however often it is asked', async () => {
    await Promise.all([probeReviewWork(t, 100), probeReviewWork(t, 100)]);
    await probeReviewWork(t, 100);
    expect(calls).toEqual([1]);
    expect(getReviewWork(1, 100)).toBe(true);
  });

  it('has no answer for a later finish until it is asked again', async () => {
    await probeReviewWork(t, 100);
    expect(getReviewWork(1, 200)).toBeUndefined();
    await probeReviewWork(t, 200);
    expect(calls).toEqual([1, 1]);
    expect(getReviewWork(1, 200)).toBe(true);
  });

  it('reads a failed probe as "cannot say", never as work', async () => {
    setWorkProbeForTests(async () => {
      throw new Error('worktree gone');
    });
    await probeReviewWork(t, 100);
    expect(getReviewWork(1, 100)).toBeNull();
  });

  it('runs one probe at a time', async () => {
    let running = 0;
    let most = 0;
    setWorkProbeForTests(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
      return false;
    });
    await Promise.all([1, 2, 3].map((id) => probeReviewWork({ ...t, id }, 100)));
    expect(most).toBe(1);
    expect(getReviewWork(3, 100)).toBe(false);
  });
});
