import { describe, expect, it } from 'vitest';

import type { Task } from '../types';
import type { PrState, PrStatus } from '../gh/prStatus';
import {
  canMarkDone,
  canMarkNotDone,
  compareInGroup,
  groupOf,
  hasWorkToReview,
  seenUpdate,
  unseenFinish,
  wantsWorkProbe,
  type GroupFacts,
  type GroupKey,
} from './taskGroups';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/wt/b',
    sessionId: 's', ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle',
    createdAt: 0, lastActivityAt: 100, seenAt: 1_000, ...over,
  };
}

function pr(state: PrState, mergedAt: string | null = null): PrStatus {
  return {
    number: 7, url: 'u', title: 'p', state, headRefName: 'b', mergedAt, review: null,
    checks: { kind: 'none' }, lines: [],
  };
}

function facts(over: Partial<GroupFacts> = {}): GroupFacts {
  return { finishedAt: null, pr: null, work: undefined, ...over };
}

describe('unseenFinish', () => {
  it('is a finish after the task was last open', () => {
    expect(unseenFinish(2_000, 1_000)).toBe(true);
    expect(unseenFinish(1_000, 1_000)).toBe(false);
    expect(unseenFinish(500, 1_000)).toBe(false);
  });

  it('counts any finish on a task never opened, and nothing without a finish', () => {
    expect(unseenFinish(1, null)).toBe(true);
    expect(unseenFinish(null, null)).toBe(false);
  });
});

describe('hasWorkToReview', () => {
  it('is an open or draft PR, or work the probe found', () => {
    expect(hasWorkToReview(task(), { pr: pr('open'), work: undefined })).toBe(true);
    expect(hasWorkToReview(task(), { pr: pr('draft'), work: false })).toBe(true);
    expect(hasWorkToReview(task(), { pr: null, work: true })).toBe(true);
  });

  it('is not a closed PR, or work not known yet or that git could not say', () => {
    expect(hasWorkToReview(task(), { pr: pr('closed'), work: false })).toBe(false);
    expect(hasWorkToReview(task(), { pr: undefined, work: undefined })).toBe(false);
    expect(hasWorkToReview(task(), { pr: null, work: null })).toBe(false);
  });

  it('is never a chat', () => {
    expect(hasWorkToReview(task({ kind: 'chat' }), { pr: null, work: true })).toBe(false);
  });
});

describe('groupOf', () => {
  const unseen = { finishedAt: 2_000 };

  it('puts a prompt waiting on you first, then running work', () => {
    expect(groupOf(task({ status: 'blocked' }), facts({ ...unseen, work: true, pr: pr('merged') }))).toBe('blocked');
    expect(groupOf(task({ status: 'running' }), facts({ ...unseen, work: true }))).toBe('active');
  });

  it('is Ready to Review with an unseen finish and work on it', () => {
    expect(groupOf(task(), facts({ ...unseen, work: true }))).toBe('review');
    expect(groupOf(task(), facts({ ...unseen, pr: pr('open') }))).toBe('review');
  });

  it('is Idle once seen, or when the finish left nothing to review', () => {
    expect(groupOf(task({ seenAt: 3_000 }), facts({ ...unseen, work: true }))).toBe('quiet');
    expect(groupOf(task(), facts({ ...unseen, work: false }))).toBe('quiet');
    expect(groupOf(task({ kind: 'chat' }), facts({ ...unseen, work: true }))).toBe('quiet');
  });

  it('is Idle while the work is not known yet: unknown never claims attention', () => {
    expect(groupOf(task(), facts({ ...unseen, work: undefined }))).toBe('quiet');
  });

  it('is Done when marked done, or when the PR merged, over Ready to Review', () => {
    expect(groupOf(task({ status: 'done' }), facts())).toBe('done');
    expect(groupOf(task(), facts({ pr: pr('merged') }))).toBe('done');
    expect(groupOf(task(), facts({ ...unseen, work: true, pr: pr('merged') }))).toBe('done');
  });

  it('keeps archived tasks archived, merged or not', () => {
    expect(groupOf(task({ status: 'archived' }), facts({ pr: pr('merged') }))).toBe('archived');
  });
});

describe('compareInGroup', () => {
  const sort = (group: GroupKey, rows: [Task, GroupFacts][]) =>
    [...rows].sort(([a, fa], [b, fb]) => compareInGroup(group, a, fa, b, fb)).map(([t]) => t.id);

  it('puts the oldest finish first in Ready to Review', () => {
    expect(
      sort('review', [
        [task({ id: 1, lastActivityAt: 9_000 }), facts({ finishedAt: 3_000 })],
        [task({ id: 2, lastActivityAt: 1 }), facts({ finishedAt: 1_000 })],
        [task({ id: 3 }), facts({ finishedAt: 2_000 })],
      ]),
    ).toEqual([2, 3, 1]);
  });

  it('puts the newest first in Done, by the merge when there is one', () => {
    expect(
      sort('done', [
        [task({ id: 1, lastActivityAt: Date.parse('2026-10-01T00:00:00Z') }), facts()],
        [task({ id: 2, lastActivityAt: 1 }), facts({ pr: pr('merged', '2026-10-20T00:00:00Z') })],
        [task({ id: 3, lastActivityAt: Date.parse('2026-10-10T00:00:00Z') }), facts()],
      ]),
    ).toEqual([2, 3, 1]);
  });

  it('keeps the other groups most recent activity first, as before', () => {
    expect(
      sort('quiet', [
        [task({ id: 1, lastActivityAt: 10 }), facts()],
        [task({ id: 2, lastActivityAt: null, createdAt: 30 }), facts()],
        [task({ id: 3, lastActivityAt: 20 }), facts()],
      ]),
    ).toEqual([2, 3, 1]);
  });
});

describe('seenUpdate', () => {
  it('writes now when the latest finish is not covered', () => {
    expect(seenUpdate(1_000, 2_000, 5_000)).toBe(5_000);
    expect(seenUpdate(null, 2_000, 5_000)).toBe(5_000);
  });

  it('writes nothing when it is, or when no turn has ended', () => {
    expect(seenUpdate(3_000, 2_000, 5_000)).toBeNull();
    expect(seenUpdate(null, null, 5_000)).toBeNull();
  });

  it('never writes a time before the finish, so a clock behind cannot leave it unseen', () => {
    expect(seenUpdate(1_000, 9_000, 5_000)).toBe(9_000);
  });
});

describe('wantsWorkProbe', () => {
  it('asks git about an unseen finish on an idle work task', () => {
    expect(wantsWorkProbe(task(), facts({ finishedAt: 2_000 }))).toBe(true);
    expect(wantsWorkProbe(task(), facts({ finishedAt: 2_000, pr: undefined }))).toBe(true);
  });

  it('does not ask when the PR already answers, the finish is seen, or it is a chat', () => {
    expect(wantsWorkProbe(task(), facts({ finishedAt: 2_000, pr: pr('open') }))).toBe(false);
    expect(wantsWorkProbe(task(), facts({ finishedAt: 2_000, pr: pr('merged') }))).toBe(false);
    expect(wantsWorkProbe(task({ seenAt: 3_000 }), facts({ finishedAt: 2_000 }))).toBe(false);
    expect(wantsWorkProbe(task({ kind: 'chat' }), facts({ finishedAt: 2_000 }))).toBe(false);
  });

  it('does not ask while the task works or once it is done', () => {
    expect(wantsWorkProbe(task({ status: 'running' }), facts({ finishedAt: 2_000 }))).toBe(false);
    expect(wantsWorkProbe(task({ status: 'done' }), facts({ finishedAt: 2_000 }))).toBe(false);
  });
});

describe('Mark as Done / Mark as Not Done', () => {
  it('offers Done on a task at rest, and Not Done on one marked done', () => {
    expect(canMarkDone(task(), null)).toBe(true);
    expect(canMarkNotDone(task(), null)).toBe(false);
    expect(canMarkDone(task({ status: 'done' }), null)).toBe(false);
    expect(canMarkNotDone(task({ status: 'done' }), null)).toBe(true);
  });

  it('offers neither while the task works: the next derivation would undo it', () => {
    for (const status of ['running', 'blocked', 'archived'] as const) {
      expect(canMarkDone(task({ status }), null)).toBe(false);
      expect(canMarkNotDone(task({ status }), null)).toBe(false);
    }
  });

  it('offers neither once the PR merged: that Done is not a choice to undo', () => {
    expect(canMarkDone(task(), pr('merged'))).toBe(false);
    expect(canMarkNotDone(task({ status: 'done' }), pr('merged'))).toBe(false);
    expect(canMarkNotDone(task({ status: 'done' }), pr('open'))).toBe(true);
  });
});
