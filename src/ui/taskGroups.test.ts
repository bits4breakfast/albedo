import { describe, expect, it } from 'vitest';

import type { Task } from '../types';
import type { PrState, PrStatus } from '../gh/prStatus';
import {
  canMarkDone,
  canMarkNotDone,
  checksFailing,
  compareInGroup,
  GROUP_HUE,
  GROUP_ORDER,
  GROUP_PIE,
  GROUP_TITLE,
  groupOf,
  hasWorkToReview,
  seenUpdate,
  stoppedOnError,
  unseenFinish,
  wantsWorkProbe,
  type GroupFacts,
  type GroupKey,
} from './taskGroups';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/wt/b',
    sessionId: 's', ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle',
    createdAt: 0, lastActivityAt: 100, seenAt: 1_000, summary: null, reviewUrl: null, apiError: null, apiErrorText: null, ...over,
  };
}

function pr(state: PrState, mergedAt: string | null = null, over: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 7, url: 'u', title: 'p', state, headRefName: 'b', baseRefName: 'main', headSha: '', mergedAt, review: null,
    checks: { kind: 'none' }, lines: [], ...over,
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

describe('My Review (#219, #278)', () => {
  const reviewing = (over: Partial<GroupFacts> = {}) => facts({ reviewing: true, ...over });

  it('a task you have started reviewing, at rest, with no PR up for review', () => {
    expect(groupOf(task(), reviewing())).toBe('mine');
    expect(groupOf(task(), reviewing({ pr: pr('draft') }))).toBe('mine');
    expect(groupOf(task(), reviewing({ pr: pr('closed') }))).toBe('mine');
    expect(groupOf(task(), facts())).toBe('quiet');
    expect(GROUP_TITLE.mine).toBe('My Review');
  });

  it('gives way to what matters more: blocked, running, done, merged, and a new finish with work', () => {
    expect(groupOf(task({ status: 'blocked' }), reviewing())).toBe('blocked');
    expect(groupOf(task({ status: 'running' }), reviewing())).toBe('active');
    expect(groupOf(task({ status: 'done' }), reviewing())).toBe('done');
    expect(groupOf(task(), reviewing({ pr: pr('merged') }))).toBe('done');
    expect(groupOf(task({ seenAt: 1_000 }), reviewing({ finishedAt: 2_000, work: true }))).toBe('review');
    // Once that finish has been seen, back to My Review.
    expect(groupOf(task({ seenAt: 3_000 }), reviewing({ finishedAt: 2_000, work: true }))).toBe('mine');
  });

  it('gives way to the PR once it is up for review, whatever the guide marks say', () => {
    expect(groupOf(task(), reviewing({ pr: pr('open') }))).toBe('awaiting');
    expect(groupOf(task(), reviewing({ pr: pr('open', null, { review: 'approved' }) }))).toBe('approved');
  });

  it('never a chat', () => {
    expect(groupOf(task({ kind: 'chat' }), reviewing())).toBe('quiet');
  });
});

describe('the team\'s review (#278)', () => {
  const open = (over: Partial<PrStatus> = {}) => facts({ pr: pr('open', null, over) });
  const threads = (total: number, unresolved: number) => ({ reviewThreads: { total, unresolved } });

  it('an open PR with no review threads is Awaiting Review', () => {
    expect(groupOf(task(), open())).toBe('awaiting');
    expect(groupOf(task(), open({ review: 'review-required' }))).toBe('awaiting');
    expect(groupOf(task(), open(threads(0, 0)))).toBe('awaiting');
  });

  it('threads not known read as none', () => {
    expect(groupOf(task(), open({ reviewThreads: null }))).toBe('awaiting');
  });

  it('with review threads, resolved or not, it is In Review', () => {
    expect(groupOf(task(), open(threads(3, 3)))).toBe('team');
    expect(groupOf(task(), open(threads(2, 0)))).toBe('team');
  });

  it('a change request is In Review, threads or not', () => {
    expect(groupOf(task(), open({ review: 'changes-requested' }))).toBe('team');
    expect(groupOf(task(), open({ review: 'changes-requested', ...threads(1, 1) }))).toBe('team');
  });

  it('approved is Approved, unresolved threads or not; a change request outranks an approval upstream', () => {
    expect(groupOf(task(), open({ review: 'approved' }))).toBe('approved');
    expect(groupOf(task(), open({ review: 'approved', ...threads(4, 2) }))).toBe('approved');
    // reviewOf (prStatus.ts) already decided: changes requested AND approved reads 'changes-requested'.
    expect(groupOf(task(), open({ review: 'changes-requested', reviews: [] }))).toBe('team');
  });

  it('a draft PR is not up for review: My Review with guide marks, else Idle', () => {
    expect(groupOf(task(), facts({ pr: pr('draft', null, { review: 'approved', ...threads(2, 2) }) }))).toBe('quiet');
    expect(groupOf(task(), facts({ reviewing: true, pr: pr('draft') }))).toBe('mine');
  });

  it('a new finish still goes to Ready to Review first', () => {
    expect(groupOf(task(), facts({ finishedAt: 2_000, pr: pr('open', null, threads(1, 1)) }))).toBe('review');
  });

  it('running, blocked and done outrank the review', () => {
    expect(groupOf(task({ status: 'running' }), open({ review: 'approved' }))).toBe('active');
    expect(groupOf(task({ status: 'blocked' }), open(threads(1, 1)))).toBe('blocked');
    expect(groupOf(task({ status: 'done' }), open({ review: 'approved' }))).toBe('done');
  });

  it('never for a chat', () => {
    expect(groupOf(task({ kind: 'chat' }), open({ review: 'approved' }))).toBe('quiet');
    expect(groupOf(task({ kind: 'chat' }), open(threads(1, 1)))).toBe('quiet');
  });
});

describe('failing checks (#278)', () => {
  const failing = { kind: 'failing', failing: 1, total: 3 } as const;

  it('an open or draft PR whose checks failed is Needs You', () => {
    expect(groupOf(task(), facts({ pr: pr('open', null, { checks: failing }) }))).toBe('blocked');
    expect(groupOf(task(), facts({ pr: pr('draft', null, { checks: failing }) }))).toBe('blocked');
    // Over Ready to Review and over an approval.
    expect(groupOf(task(), facts({ finishedAt: 2_000, work: true, pr: pr('open', null, { checks: failing }) }))).toBe('blocked');
    expect(groupOf(task(), facts({ pr: pr('open', null, { checks: failing, review: 'approved' }) }))).toBe('blocked');
  });

  it('is Running while the session runs: Claude may be fixing it', () => {
    expect(groupOf(task({ status: 'running' }), facts({ pr: pr('open', null, { checks: failing }) }))).toBe('active');
  });

  it('not while the checks run, nor once they pass', () => {
    const pending = { kind: 'pending', pending: 1, total: 3 } as const;
    expect(groupOf(task(), facts({ pr: pr('open', null, { checks: pending }) }))).toBe('awaiting');
    expect(groupOf(task(), facts({ pr: pr('open', null, { checks: { kind: 'passing', total: 3 } }) }))).toBe('awaiting');
  });

  it('a merged PR with old failing checks is Done; a closed one is not Needs You', () => {
    expect(groupOf(task(), facts({ pr: pr('merged', '2026-11-01T00:00:00Z', { checks: failing }) }))).toBe('done');
    expect(groupOf(task(), facts({ pr: pr('closed', null, { checks: failing }) }))).toBe('quiet');
    expect(checksFailing(pr('closed', null, { checks: failing }))).toBe(false);
  });

  it('never for a chat', () => {
    expect(groupOf(task({ kind: 'chat' }), facts({ pr: pr('open', null, { checks: failing }) }))).toBe('quiet');
  });
});

describe('the groups (#278)', () => {
  it('in the order decided', () => {
    expect(GROUP_ORDER.map((k) => GROUP_TITLE[k])).toEqual([
      'Needs You', 'Stopped on an Error', 'Running', 'Ready to Review', 'My Review', 'In Review', 'Awaiting Review', 'Approved', 'Idle', 'Done',
      'Archived',
    ]);
  });

  it('each stage has its colour; the review pairs share one', () => {
    expect(GROUP_HUE.review).toBe(GROUP_HUE.mine);
    expect(GROUP_HUE.team).toBe(GROUP_HUE.awaiting);
    const live = GROUP_ORDER.filter((k) => k !== 'archived');
    expect(new Set(live.map((k) => GROUP_HUE[k])).size).toBe(8);
  });

  it('each header icon fills as the work moves along', () => {
    expect(GROUP_PIE).toMatchObject({
      blocked: 'full', errored: 'ring', active: 0.25, review: 0.5, mine: 0.5, awaiting: 0.625, team: 0.75, approved: 0.875, quiet: 0,
      done: 'check',
    });
  });
});

describe('Stopped on an Error (#338)', () => {
  const stopped = { apiError: 'stopped' as const, apiErrorText: 'API Error: The response stopped arriving.' };

  it('holds an idle task whose last turn stopped on an API error', () => {
    expect(groupOf(task(stopped), facts())).toBe('errored');
    expect(stoppedOnError(task(stopped))).toBe(true);
  });

  it('comes right after Needs You: a prompt waiting outranks it', () => {
    expect(GROUP_ORDER.indexOf('errored')).toBe(GROUP_ORDER.indexOf('blocked') + 1);
    expect(groupOf(task({ ...stopped, status: 'blocked' }), facts())).toBe('blocked');
  });

  it('is not a running task, a done one or an archived one, whatever is stored', () => {
    expect(groupOf(task({ ...stopped, status: 'running' }), facts())).toBe('active');
    expect(groupOf(task({ ...stopped, status: 'done' }), facts())).toBe('done');
    expect(groupOf(task({ ...stopped, status: 'archived' }), facts())).toBe('archived');
    expect(stoppedOnError(task({ ...stopped, status: 'running' }))).toBe(false);
  });

  it('outranks what the finish or the PR would say: the turn did not finish', () => {
    expect(groupOf(task({ ...stopped, seenAt: 0 }), facts({ finishedAt: 500, work: true }))).toBe('errored');
    expect(groupOf(task(stopped), facts({ pr: pr('open', null, { review: 'approved' }) }))).toBe('errored');
    expect(groupOf(task({ ...stopped, kind: 'chat' }), facts())).toBe('errored');
  });

  it('without an error the task is where it always was', () => {
    expect(groupOf(task(), facts())).toBe('quiet');
  });
});
