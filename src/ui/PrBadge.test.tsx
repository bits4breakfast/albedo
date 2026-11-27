/**
 * @vitest-environment jsdom
 *
 * Where the PR badge goes, a Create PR button stands in while there is none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';

const state = { answered: true, pr: null as unknown, viewer: null as string | null };
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => (state.answered ? state.pr : undefined),
  usePrStatus: () => state.pr,
  usePrStatusVersion: () => 0,
  useViewerLogin: () => state.viewer,
}));
vi.mock('../git/worktree', () => ({ commitsOnBranch: vi.fn(async () => 3) }));
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('./ChecksDialog', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Checks">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

const wt = await import('../git/worktree');
const { openExternal } = await import('../lib/openUrl');
const { PrBadge, opensChecks } = await import('./PrBadge');
const { onGuideRequest } = await import('../guide/openGuide');
const { notePrRequested } = await import('../gh/draftReady');
const { setReviewGateForTests, resetGateForTests } = await import('../guide/gate');
const ci = await import('./ciNotice');
const { __setAttentionBackend } = await import('./attention');

/** A fresh in-memory store per test (REGRESSIONS: never the runtime's localStorage). */
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
  // Your own review is done (#464), unless a test says otherwise.
  setReviewGateForTests(() => ({ kind: 'ready', total: 1 }));
});

afterEach(() => {
  cleanup();
  resetGateForTests();
  ci.resetCiNoticesForTests();
  __setAttentionBackend(null);
  state.answered = true;
  state.pr = null;
  state.viewer = null;
  vi.clearAllMocks();
});

const task = {
  id: 1, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true,
} as unknown as Task;

describe('PrBadge without a PR', () => {
  it('offers Create PR once gh says there is none and the branch has commits', async () => {
    const onCreatePr = vi.fn();
    render(<PrBadge task={task} onCreatePr={onCreatePr} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
  });

  it('offers nothing before gh has answered, for a branch git does not know, or with no commits', async () => {
    state.answered = false;
    const { rerender } = render(<PrBadge task={task} onCreatePr={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();

    state.answered = true;
    vi.mocked(wt.commitsOnBranch).mockResolvedValueOnce(null);
    rerender(<PrBadge task={{ ...task, branch: 'gone' }} onCreatePr={() => {}} />);
    await waitFor(() => expect(wt.commitsOnBranch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();

    vi.mocked(wt.commitsOnBranch).mockResolvedValueOnce(0);
    rerender(<PrBadge task={{ ...task, branch: 'empty' }} onCreatePr={() => {}} />);
    await waitFor(() => expect(wt.commitsOnBranch).toHaveBeenCalledWith('/r', 'main', 'empty'));
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  });
});

describe('PrBadge: review before Create PR (#464)', () => {
  it('stands Review Changes in Create PR’s place, with how far along, and opens the Guide', async () => {
    setReviewGateForTests(() => ({ kind: 'reviewing', reviewed: 4, total: 6 }));
    const asked: number[] = [];
    const off = onGuideRequest((id) => asked.push(id));
    const onCreatePr = vi.fn();
    render(<PrBadge task={task} onCreatePr={onCreatePr} />);
    const review = await screen.findByRole('button', { name: 'Review Changes, 4 of 6' });
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    fireEvent.click(review);
    expect(asked).toEqual([task.id]);
    expect(onCreatePr).not.toHaveBeenCalled();
    off();
  });

  it('says out of date, or no guide', async () => {
    setReviewGateForTests(() => ({ kind: 'stale', commitsSince: 1 }));
    render(<PrBadge task={task} onCreatePr={() => {}} />);
    expect((await screen.findByRole('button', { name: 'Review Changes, out of date' })).title).toMatch(/1 commit since/);
    cleanup();
    setReviewGateForTests(() => ({ kind: 'no-guide' }));
    render(<PrBadge task={task} onCreatePr={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Review Changes, no guide' })).toBeTruthy();
  });

  it('a draft Create PR opened says when it opens for review, and nothing once done or failing', () => {
    const draft = (checks: PrStatus['checks']): PrStatus => ({
      number: 8, url: 'https://github.com/o/r/pull/8', title: 'x', state: 'draft', headRefName: 'feat', baseRefName: 'main',
      headSha: 'abc', mergedAt: null, review: null, checks, lines: [], author: 'me', crossRepository: false,
    });
    notePrRequested(task.id, false);
    state.pr = draft({ kind: 'pending', pending: 2, total: 3 });
    const { rerender } = render(<PrBadge task={task} />);
    expect(screen.getByText('Opens for review when checks pass')).toBeTruthy();
    // The guide went out of date since: it waits on the review again.
    setReviewGateForTests(() => ({ kind: 'stale', commitsSince: 1 }));
    rerender(<PrBadge task={{ ...task }} />);
    expect(screen.getByText('Opens for review once the guide is reviewed again')).toBeTruthy();
    state.pr = draft({ kind: 'failing', failing: 1, total: 3 });
    rerender(<PrBadge task={{ ...task }} />);
    expect(screen.queryByText(/Opens for review/)).toBeNull();
    // A draft Albedo did not ask for says nothing.
    window.localStorage.removeItem('albedo.pr.draftReady');
    state.pr = draft({ kind: 'pending', pending: 2, total: 3 });
    rerender(<PrBadge task={{ ...task }} />);
    expect(screen.queryByText(/Opens for review/)).toBeNull();
  });
});

describe('PrBadge with a PR', () => {
  const pr = (over: Partial<PrStatus>): PrStatus => ({
    number: 6,
    url: 'https://github.com/o/r/pull/6',
    title: 't',
    state: 'open',
    headRefName: 'feat',
    baseRefName: 'main',
    headSha: '',
    mergedAt: null,
    review: null,
    checks: { kind: 'failing', failing: 1, total: 1 },
    lines: [{ name: 'CI / linux', bucket: 'fail', url: 'https://github.com/o/r/actions/runs/1/job/2' }],
    ...over,
  });

  it('opens the Checks dialog from an open PR with checks, and gives focus back on close', () => {
    state.pr = pr({});
    render(<PrBadge task={task} />);
    const badge = screen.getByRole('button', { name: /Pull request 6, 1 Failing\. Show the checks/ });
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(badge);
    expect(screen.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it('opens GitHub, as before, once merged or with no checks', () => {
    expect(opensChecks(pr({ state: 'merged' }))).toBe(false);
    expect(opensChecks(pr({ state: 'closed' }))).toBe(false);
    expect(opensChecks(pr({ lines: [], checks: { kind: 'none' } }))).toBe(false);
    expect(opensChecks(pr({ state: 'draft' }))).toBe(true);
    state.pr = pr({ lines: [], checks: { kind: 'none' } });
    render(<PrBadge task={task} />);
    fireEvent.click(screen.getByRole('button', { name: /Open on GitHub/ }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/6');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PrBadge and finished checks (#159)', () => {
  const pr = (failing: boolean, sha = 'a'): PrStatus => ({
    number: 6, url: 'https://github.com/o/r/pull/6', title: 't', state: 'open', headRefName: 'feat', baseRefName: 'main',
    headSha: sha, mergedAt: null, review: null,
    checks: failing ? { kind: 'failing', failing: 1, total: 1 } : { kind: 'pending', pending: 1, total: 1 },
    lines: [{ name: 'CI / linux', bucket: failing ? 'fail' : 'pending', url: null }],
  });

  it('opens the Checks dialog when a "checks failed" banner was clicked for this task', () => {
    state.pr = pr(true);
    ci.requestChecks(1);
    render(<PrBadge task={task} />);
    expect(screen.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
  });

  it('leaves another task\'s request alone', () => {
    state.pr = pr(true);
    ci.requestChecks(2);
    render(<PrBadge task={task} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cues the badge when checks finish on the open task, then lets it go', () => {
    vi.useFakeTimers();
    __setAttentionBackend(() => {}, true, () => {});
    state.pr = pr(true);
    render(<PrBadge task={task} />);
    const badge = screen.getByRole('button', { name: /Pull request 6/ });
    expect(badge.getAttribute('data-cue')).toBeNull();
    act(() => {
      ci.observeCi(task, pr(false), 1);
      ci.observeCi(task, pr(true), 1);
    });
    expect(badge.getAttribute('data-cue')).toBe('fail');
    expect(screen.getByRole('status').textContent).toBe('Checks failed on pull request 6');
    act(() => {
      vi.advanceTimersByTime(ci.CI_CUE_MS);
    });
    expect(badge.getAttribute('data-cue')).toBeNull();
    vi.useRealTimers();
  });
});

describe('PrBadge: the review chip (#180)', () => {
  const pr = (over: Partial<PrStatus>): PrStatus => ({
    number: 6,
    url: 'https://github.com/o/r/pull/6',
    title: 't',
    state: 'open',
    headRefName: 'feat',
    baseRefName: 'main',
    headSha: '',
    mergedAt: null,
    review: null,
    reviews: [],
    reviewRequests: [],
    author: 'octo',
    checks: { kind: 'passing', total: 1 },
    lines: [{ name: 'CI / linux', bucket: 'pass', url: null }],
    ...over,
  });
  const chip = () => screen.queryByRole('button', { name: /^Review:/ });

  it('says Approved in the pass tone, names the reviewer, and opens the PR on GitHub', () => {
    state.pr = pr({ review: 'approved', reviews: [{ author: 'alice', state: 'approved', submittedAt: 't1' }] });
    render(<PrBadge task={task} />);
    const c = chip()!;
    expect(c.textContent).toBe('✓Approved');
    expect(c.getAttribute('data-tone')).toBe('pass');
    expect(c.getAttribute('title')).toContain('Approved by alice');
    fireEvent.click(c);
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/6');
    // A second fact beside the badge, not folded into it.
    expect(screen.getByRole('button', { name: /Pull request 6/ })).not.toBe(c);
  });

  it('says Changes Requested in the warn tone', () => {
    state.pr = pr({
      review: 'changes-requested',
      reviews: [{ author: 'carol', state: 'changes-requested', submittedAt: 't1' }],
    });
    render(<PrBadge task={task} />);
    expect(chip()!.textContent).toBe('✎Changes Requested');
    expect(chip()!.getAttribute('data-tone')).toBe('warn');
    expect(chip()!.getAttribute('title')).toContain('Changes requested by carol');
  });

  it('says Awaiting Review quietly, and names who is asked', () => {
    state.pr = pr({ review: 'review-required', reviewRequests: ['dave'] });
    render(<PrBadge task={task} />);
    expect(chip()!.textContent).toBe('◷Awaiting Review');
    expect(chip()!.getAttribute('data-tone')).toBe('quiet');
    expect(chip()!.getAttribute('title')).toContain('Review requested from dave');
  });

  it('shows nothing for a draft, merged or closed PR', () => {
    for (const st of ['draft', 'merged', 'closed'] as const) {
      state.pr = pr({ state: st, review: 'approved' });
      render(<PrBadge task={task} />);
      expect(chip()).toBeNull();
      cleanup();
    }
  });

  it("hides Awaiting Review on the owner's own PR with no reviewer asked, but not when the login is unknown", () => {
    state.pr = pr({ review: 'review-required', author: 'Octo' });
    state.viewer = 'octo';
    render(<PrBadge task={task} />);
    expect(chip()).toBeNull();
    cleanup();

    state.viewer = null;
    render(<PrBadge task={task} />);
    expect(chip()!.textContent).toBe('◷Awaiting Review');
  });
});
