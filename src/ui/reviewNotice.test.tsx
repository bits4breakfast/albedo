/**
 * @vitest-environment jsdom
 *
 * A review landing (#180): a banner and a bounce when away, a row mark either
 * way, once per review -- behind the switch the checks use.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { __setAttentionBackend, lastBannerFor, NOTIFICATIONS_KEY } from './attention';
import { setCiNotifyEnabled } from './ciNotice';
import {
  clearReviewMark,
  observeReview,
  resetReviewNoticesForTests,
  reviewMarkFor,
  useReviewNotices,
} from './reviewNotice';
import { parsePrView, type PrStatus } from '../gh/prStatus';
import { refreshPrStatus, setPrFetcherForTests } from '../gh/prStore';
import { resetViewerLoginForTests } from '../gh/gh';
import type { Task } from '../types';

const rev = (login: string, state: string, submittedAt = 't1') => ({ author: { login }, state, submittedAt });
function pr(reviews: ReturnType<typeof rev>[], over: Record<string, unknown> = {}): PrStatus {
  return parsePrView(
    JSON.stringify({ number: 12, state: 'OPEN', headRefName: 'b', reviewDecision: '', latestReviews: reviews, ...over }),
  ) as PrStatus;
}
const none = () => pr([]);
const approved = () => pr([rev('alice', 'APPROVED')]);
const changes = () => pr([rev('carol', 'CHANGES_REQUESTED')]);

const T = { id: 7, title: 'Fix login' };

let bounces: boolean[];
let posted: { title: string; body: string; taskId: number }[];
function backend(focused: boolean) {
  bounces = [];
  posted = [];
  __setAttentionBackend((c) => bounces.push(c), focused, (n) => posted.push(n));
}

beforeEach(() => {
  // A fresh store per test: never the environment's localStorage.
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetReviewNoticesForTests();
  resetViewerLoginForTests();
  backend(false);
});
afterEach(() => {
  cleanup();
  __setAttentionBackend(null);
  resetViewerLoginForTests();
});

describe('observeReview', () => {
  it('away: an approval bounces once, posts who approved, and marks the row', () => {
    observeReview(T, none(), null);
    observeReview(T, approved(), null);
    expect(bounces).toEqual([false]);
    expect(posted).toEqual([{ title: 'Fix login', body: 'PR #12 approved by alice', taskId: 7 }]);
    expect(reviewMarkFor(7)).toEqual({ outcome: 'approved', prNumber: 12, reviewers: ['alice'] });
    expect(lastBannerFor(7)).toBe('review-approved');
  });

  it('away: changes requested too', () => {
    observeReview(T, none(), null);
    observeReview(T, changes(), null);
    expect(posted[0]?.body).toBe('PR #12: changes requested by carol');
    expect(lastBannerFor(7)).toBe('review-changes-requested');
    expect(reviewMarkFor(7)?.outcome).toBe('changes-requested');
  });

  it('once per review, not per poll', () => {
    observeReview(T, none(), null);
    for (let i = 0; i < 4; i++) observeReview(T, approved(), null);
    expect(posted.length).toBe(1);
    expect(bounces.length).toBe(1);
  });

  it('not on first load: a PR already approved when first seen says nothing', () => {
    observeReview(T, approved(), null);
    observeReview(T, approved(), null);
    expect(posted).toEqual([]);
    expect(bounces).toEqual([]);
    expect(reviewMarkFor(7)).toBeUndefined();
  });

  it('focused: no banner and no bounce, only the row mark', () => {
    backend(true);
    observeReview(T, none(), null);
    observeReview(T, approved(), null);
    expect(bounces).toEqual([]);
    expect(posted).toEqual([]);
    expect(reviewMarkFor(7)?.outcome).toBe('approved');
  });

  it('the open task gets no row mark', () => {
    backend(true);
    observeReview(T, none(), 7);
    observeReview(T, approved(), 7);
    expect(reviewMarkFor(7)).toBeUndefined();
  });

  it('the shared PR switch off: no banner, no bounce; the mark stays', () => {
    setCiNotifyEnabled(false);
    observeReview(T, none(), null);
    observeReview(T, approved(), null);
    expect(bounces).toEqual([]);
    expect(posted).toEqual([]);
    expect(reviewMarkFor(7)?.outcome).toBe('approved');
  });

  it('respects the app-wide banner switch', () => {
    window.localStorage.setItem(NOTIFICATIONS_KEY, 'off');
    observeReview(T, none(), null);
    observeReview(T, approved(), null);
    expect(bounces).toEqual([false]);
    expect(posted).toEqual([]);
  });

  it('a newer review replaces the mark; a merge clears it; opening the task clears it', () => {
    observeReview(T, none(), null);
    observeReview(T, approved(), null);
    observeReview(T, pr([rev('alice', 'APPROVED'), rev('carol', 'CHANGES_REQUESTED', 't2')]), null);
    expect(reviewMarkFor(7)?.outcome).toBe('changes-requested');
    observeReview(T, pr([rev('carol', 'CHANGES_REQUESTED', 't2')], { state: 'MERGED' }), null);
    expect(reviewMarkFor(7)).toBeUndefined();

    observeReview({ id: 8, title: 'x' }, none(), null);
    observeReview({ id: 8, title: 'x' }, approved(), null);
    clearReviewMark(8);
    expect(reviewMarkFor(8)).toBeUndefined();
  });

  it("the signed-in user's own review says nothing", () => {
    resetViewerLoginForTests('alice');
    observeReview(T, none(), null);
    observeReview(T, approved(), null);
    expect(posted).toEqual([]);
    expect(reviewMarkFor(7)).toBeUndefined();
  });
});

describe('useReviewNotices', () => {
  const task = (id: number, over: Partial<Task> = {}) =>
    ({ id, title: `T${id}`, status: 'idle', kind: 'work', branch: `b${id}`, baseBranch: 'main', worktreePath: '/w', repoPath: '/r', ...over }) as Task;

  it('watches the PR store across polls, skips archived tasks, and clears the mark when the task is opened', async () => {
    let answer = none();
    setPrFetcherForTests(async () => answer);
    const { rerender } = renderHook(
      ({ sel }) => useReviewNotices([task(1), task(2, { status: 'archived' })], sel),
      { initialProps: { sel: null as number | null } },
    );
    await act(async () => {
      await refreshPrStatus(task(1));
      await refreshPrStatus(task(2));
    });
    answer = approved();
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await refreshPrStatus(task(1), { force: true });
        await refreshPrStatus(task(2), { force: true });
      });
    }
    expect(reviewMarkFor(1)?.outcome).toBe('approved');
    expect(reviewMarkFor(2)).toBeUndefined();
    expect(posted.map((n) => n.taskId)).toEqual([1]);

    rerender({ sel: 1 });
    expect(reviewMarkFor(1)).toBeUndefined();
  });
});
