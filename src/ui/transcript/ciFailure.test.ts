/**
 * @vitest-environment jsdom
 *
 * A PR's failing checks, queued for Claude like a waiting comment (#280):
 * queued on any failing reading of a head commit the owner has not handled,
 * never sent by itself, dropped by a push, a rerun, a pass or a merge, kept
 * across a restart, and written into the message in one exact shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

const { submitPty } = await import('../Terminal');
const { __setAttentionBackend } = await import('../attention');
const { observeCi, resetCiNoticesForTests, useCiNotices } = await import('../ciNotice');
const { parsePrView } = await import('../../gh/prStatus');
const { refreshPrStatus, setPrFetcherForTests } = await import('../../gh/prStore');
const { __resetOutbox, heldFor } = await import('./outbox');
const { __resetDrafts, getDraft } = await import('./drafts');
const { composeMessage } = await import('./codeComments');
const {
  __resetQueuedCi,
  ciFailureLabel,
  formatCiFailure,
  forgetQueuedCi,
  keepQueuedCiFor,
  queuedCiOf,
  removeQueuedCi,
  takeQueuedCi,
} = await import('./ciFailure');
type PrStatus = import('../../gh/prStatus').PrStatus;
type Task = import('../../types').Task;

const SHA_A = 'abc1234def5678900000000000000000000000aa';
const SHA_B = 'bcd2345ef67890100000000000000000000000bb';

type Run = { name: string; status?: string; conclusion?: string | null; url?: string };
function pr(sha: string, runs: Run[], state = 'OPEN'): PrStatus {
  return parsePrView(
    JSON.stringify({
      number: 6102,
      state,
      headRefName: 'b',
      headRefOid: sha,
      statusCheckRollup: runs.map((r) => ({
        __typename: 'CheckRun',
        name: r.name,
        status: r.status ?? (r.conclusion ? 'COMPLETED' : 'IN_PROGRESS'),
        conclusion: r.conclusion ?? null,
        detailsUrl: r.url ?? `https://ci.example.com/${r.name}`,
      })),
    }),
  ) as PrStatus;
}
const running = (sha = SHA_A) => pr(sha, [{ name: 'build' }, { name: 'test (2)' }, { name: 'lint' }]);
const failed = (sha = SHA_A) =>
  pr(sha, [
    { name: 'build', conclusion: 'FAILURE' },
    { name: 'test (2)', conclusion: 'TIMED_OUT' },
    { name: 'lint', conclusion: 'SUCCESS' },
  ]);
const passed = (sha = SHA_A) =>
  pr(sha, [
    { name: 'build', conclusion: 'SUCCESS' },
    { name: 'test (2)', conclusion: 'SUCCESS' },
    { name: 'lint', conclusion: 'SUCCESS' },
  ]);

const T = { id: 7, title: 'ABC-1234 Fix login' };

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  __resetQueuedCi();
  __resetOutbox();
  __resetDrafts();
  resetCiNoticesForTests();
  __setAttentionBackend(() => {}, true, () => {});
  vi.mocked(submitPty).mockClear();
});
afterEach(() => {
  cleanup();
  __setAttentionBackend(null);
});

describe('a failing transition only queues', () => {
  it('pending -> failing queues one item with every failing check, and sends nothing', () => {
    observeCi(T, running(), null);
    expect(queuedCiOf(7)).toBeNull();
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)).toEqual({
      prNumber: 6102,
      sha: SHA_A,
      checks: [
        { name: 'build', conclusion: 'failed', url: 'https://ci.example.com/build' },
        { name: 'test (2)', conclusion: 'timed out', url: 'https://ci.example.com/test (2)' },
      ],
      queuedAt: expect.any(Number),
    });
    // Queued is all it is: nothing typed, nothing held, nothing in the draft.
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(7)).toEqual([]);
    expect(getDraft(7)).toBeNull();
  });

  it('once per head commit: the same failure seen again is not queued twice', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    const first = queuedCiOf(7);
    observeCi(T, failed(), null);
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)).toBe(first);
  });

  it('a failure already final when first seen queues too (it failed while the app was closed), silently', () => {
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)?.sha).toBe(SHA_A);
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(7)).toEqual([]);
  });

  it('a rerun that fails again on the same commit queues again', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    observeCi(T, running(), null); // rerun: dropped
    expect(queuedCiOf(7)).toBeNull();
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)?.sha).toBe(SHA_A);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('a pass queues nothing', () => {
    observeCi(T, running(), null);
    observeCi(T, passed(), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('not for a chat, nor an archived task (the watch skips them)', async () => {
    let answer = running();
    setPrFetcherForTests(async () => answer);
    const task = (id: number, over: Partial<Task> = {}) =>
      ({ id, title: `T${id}`, status: 'idle', kind: 'work', branch: `b${id}`, baseBranch: 'main', worktreePath: '/w', repoPath: '/r', ...over }) as Task;
    const tasks = [task(1), task(2, { kind: 'chat' }), task(3, { status: 'archived' })];
    renderHook(() => useCiNotices(tasks, null));
    await act(async () => {
      for (const t of tasks) await refreshPrStatus(t);
    });
    answer = failed();
    await act(async () => {
      for (const t of tasks) await refreshPrStatus(t, { force: true });
    });
    expect(queuedCiOf(1)?.checks).toHaveLength(2);
    expect(queuedCiOf(2)).toBeNull();
    expect(queuedCiOf(3)).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('no PR (or gh could not say) keeps what is queued', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    observeCi(T, null, null);
    expect(queuedCiOf(7)?.sha).toBe(SHA_A);
  });
});

describe('dropped by itself', () => {
  const queue = () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)).not.toBeNull();
  };

  it('when the head moves (a push)', () => {
    queue();
    observeCi(T, running(SHA_B), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('and a newer failure on the new commit replaces it', () => {
    queue();
    observeCi(T, running(SHA_B), null);
    observeCi(T, failed(SHA_B), null);
    expect(queuedCiOf(7)?.sha).toBe(SHA_B);
  });

  it('when its checks run again on the same commit', () => {
    queue();
    observeCi(T, running(), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('when they pass on the same commit', () => {
    queue();
    observeCi(T, passed(), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('when the PR is merged, or closed', () => {
    queue();
    observeCi(T, pr(SHA_A, [{ name: 'build', conclusion: 'FAILURE' }], 'MERGED'), null);
    expect(queuedCiOf(7)).toBeNull();
    resetCiNoticesForTests();
    queue();
    observeCi(T, pr(SHA_A, [{ name: 'build', conclusion: 'FAILURE' }], 'CLOSED'), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('a job rerun to green while another still fails leaves the list, the item stays', () => {
    queue();
    observeCi(
      T,
      pr(SHA_A, [
        { name: 'build', conclusion: 'FAILURE' },
        { name: 'test (2)', conclusion: 'SUCCESS' },
        { name: 'lint', conclusion: 'SUCCESS' },
      ]),
      null,
    );
    expect(queuedCiOf(7)?.checks.map((c) => c.name)).toEqual(['build']);
  });
});

describe('a commit the owner handled never queues again', () => {
  const queue = () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)?.sha).toBe(SHA_A);
  };
  const rerunFails = () => {
    observeCi(T, failed(), null);
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
  };

  it('removed (✕ / Remove): not on the next reading, nor after a rerun', () => {
    queue();
    removeQueuedCi(7, SHA_A);
    rerunFails();
    expect(queuedCiOf(7)).toBeNull();
  });

  it('sent or held (a message carried it): likewise', () => {
    queue();
    takeQueuedCi(7, SHA_A);
    rerunFails();
    expect(queuedCiOf(7)).toBeNull();
  });

  it('Ask Claude to Fix, even before anything was queued: likewise', () => {
    observeCi(T, running(), null);
    removeQueuedCi(7, SHA_A); // the dialog took it while checks still ran
    rerunFails();
    expect(queuedCiOf(7)).toBeNull();
  });

  it('a new commit’s failure queues again, and the old commit is forgotten', () => {
    queue();
    removeQueuedCi(7, SHA_A);
    observeCi(T, failed(SHA_B), null);
    expect(queuedCiOf(7)?.sha).toBe(SHA_B);
  });

  it('“handled” is kept across a restart', () => {
    queue();
    removeQueuedCi(7, SHA_A);
    __resetQueuedCi();
    resetCiNoticesForTests();
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('a merge or close forgets it all; archiving the task too', () => {
    queue();
    removeQueuedCi(7, SHA_A);
    observeCi(T, pr(SHA_A, [{ name: 'build', conclusion: 'FAILURE' }], 'CLOSED'), null);
    expect(window.localStorage.getItem('albedo.composerCiFailures')).toBeNull();
    observeCi(T, failed(SHA_B), null);
    forgetQueuedCi(7);
    expect(queuedCiOf(7)).toBeNull();
    expect(window.localStorage.getItem('albedo.composerCiFailures')).toBeNull();
  });
});

describe('removed by hand, taken by a message', () => {
  it('Remove (✕) drops it; a named commit drops only that commit’s', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    removeQueuedCi(7, SHA_B);
    expect(queuedCiOf(7)).not.toBeNull();
    removeQueuedCi(7, SHA_A);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('a message carrying an older commit’s failure leaves a newer one waiting', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    observeCi(T, running(SHA_B), null);
    observeCi(T, failed(SHA_B), null);
    takeQueuedCi(7, SHA_A);
    expect(queuedCiOf(7)?.sha).toBe(SHA_B);
    takeQueuedCi(7, SHA_B);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('goes with an archived or deleted task', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    keepQueuedCiFor([7]);
    expect(queuedCiOf(7)).not.toBeNull();
    keepQueuedCiFor([1, 2]);
    expect(queuedCiOf(7)).toBeNull();
  });
});

describe('kept across a restart', () => {
  it('is read back from storage, keyed by task and commit', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    const before = queuedCiOf(7);
    __resetQueuedCi();
    resetCiNoticesForTests(); // a new run: the PR watch remembers nothing
    expect(queuedCiOf(7)).toEqual(before);
    // The first answer of the new run: still failing on that commit, it stays.
    observeCi(T, failed(), null);
    expect(queuedCiOf(7)).toEqual(before);
    // It passed while the app was closed: it goes.
    observeCi(T, passed(), null);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('a malformed entry in storage is dropped, not fatal', () => {
    window.localStorage.setItem(
      'albedo.composerCiFailures',
      JSON.stringify({ 7: { item: { prNumber: 'x' } }, 8: { item: { prNumber: 1, sha: 'a', queuedAt: 1, checks: [] } } }),
    );
    __resetQueuedCi();
    expect(queuedCiOf(7)).toBeNull();
    expect(queuedCiOf(8)?.prNumber).toBe(1);
  });
});

describe('the words', () => {
  const failure = {
    prNumber: 6102,
    sha: SHA_A,
    queuedAt: 0,
    checks: [
      { name: 'build', conclusion: 'failed', url: 'https://ci.example.com/1' },
      { name: 'test (2)', conclusion: 'timed out', url: 'https://ci.example.com/2' },
      { name: 'deploy', conclusion: 'cancelled', url: null },
    ],
  };

  it('the message block, exactly', () => {
    expect(formatCiFailure(failure)).toBe(
      [
        'CI failed on PR #6102 (abc1234):',
        '- build: failed — https://ci.example.com/1',
        '- test (2): timed out — https://ci.example.com/2',
        '- deploy: cancelled',
      ].join('\n'),
    );
  });

  it('without a commit gh named, no parenthesis', () => {
    expect(formatCiFailure({ ...failure, sha: '#6102', checks: failure.checks.slice(0, 1) })).toBe(
      'CI failed on PR #6102:\n- build: failed — https://ci.example.com/1',
    );
  });

  it('the label', () => {
    expect(ciFailureLabel(failure)).toBe('✗ CI failed · 3 checks');
    expect(ciFailureLabel({ ...failure, checks: failure.checks.slice(0, 1) })).toBe('✗ CI failed · 1 check');
  });

  it('goes first in the message: CI, code comments, passages, then the box', () => {
    const code = [
      { id: 1, taskId: 7, path: 'src/a.ts', lineStart: 3, lineEnd: 3, anchorText: 'x', body: 'Name it.', createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null },
    ];
    const body = composeMessage(code, 'Comments:', [], 'Please fix.', failure);
    const ci = body.indexOf('CI failed on PR #6102');
    const comment = body.indexOf('Name it.');
    const box = body.indexOf('Please fix.');
    expect(ci).toBe(0);
    expect(comment).toBeGreaterThan(ci);
    expect(box).toBeGreaterThan(comment);
    expect(composeMessage([], 'Comments:', [], '', failure)).toBe(formatCiFailure(failure));
    expect(composeMessage([], 'Comments:', [], 'Hi', null)).toBe('Hi');
  });
});
