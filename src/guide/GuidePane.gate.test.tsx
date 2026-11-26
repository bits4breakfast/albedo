// @vitest-environment jsdom
/**
 * The Guide's banner before a PR (#464): groups still to review, with Next
 * Unreviewed; a guide the branch moved on from, with the one Rewrite and the
 * commits since; every group Reviewed, with Create PR -- on your own branch
 * with no PR only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import { buildBranchDiff, fileBlockIndex, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';
import type { Guide } from './validate';

let loaded: LoadedBranchDiff;
vi.mock('./branchDiff', () => ({ loadBranchDiff: async () => loaded }));
vi.mock('../ui/transcript/codeComments', () => ({ useWaitingCodeComments: () => [] }));
vi.mock('../ui/transcript/drafts', () => ({ useComments: () => [] }));
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => null }));
const asked = vi.hoisted(() => [] as Array<{ id: number; base: string; escape: boolean }>);
vi.mock('../ui/createPr', () => ({
  askCreatePr: (t: { id: number }, base: string, o: { escape: boolean }) => void asked.push({ id: t.id, base, escape: o.escape }),
}));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { resetGateForTests, setGateReaderForTests } = await import('./gate');
const { getPrStatus, refreshPrStatus, setPrFetcherForTests } = await import('../gh/prStore');

const task = {
  id: 9, title: 't', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null, reviewUrl: null,
} as unknown as Task;

const diffOf = (cAt = 5): BranchDiff =>
  buildBranchDiff([edited('src/a.ts', [3]), edited('src/b.ts', [5]), edited('src/c.ts', [cAt])], statReason);

function guideFor(diff: BranchDiff): Guide {
  const [a, b, c] = diff.order as [string, string, string];
  return {
    diffHash: diff.hash,
    writtenAt: Date.now(),
    base: 'main',
    groups: [
      { title: 'Alpha and beta', summary: '', blocks: [a, b] },
      { title: 'Gamma', summary: '', blocks: [c] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
    head: 'f'.repeat(40),
  };
}

let prAnswer: PrStatus | null = null;
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
  resetGuideStoreForTests();
  resetGuideViewsForTests();
  resetGateForTests();
  asked.length = 0;
  prAnswer = null;
  setPrFetcherForTests(async () => prAnswer);
});
afterEach(() => {
  cleanup();
  resetGateForTests();
});

const pane = (t: Task = task) => render(<GuidePane task={t} active />);
const banner = () => screen.findByRole('region', { name: 'Review before a PR' });

describe('the Guide’s banner before a PR (#464)', () => {
  it('groups to review: says how many are left, and Next Unreviewed goes to one', async () => {
    const diff = diffOf();
    loaded = { diff, base: 'b', fromMergeBase: true, uncommitted: new Set() };
    saveGuide(task.id, guideFor(diff));
    pane();
    const b = await banner();
    expect(within(b).getByText('Review your changes before opening a PR')).toBeTruthy();
    expect(within(b).getByText(/Mark the 2 remaining groups Reviewed and Create PR comes back\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Alpha and beta' })).toBeTruthy();
    fireEvent.click(within(b).getByRole('button', { name: 'Next Unreviewed ›' }));
    expect(screen.getByRole('heading', { name: 'Gamma' })).toBeTruthy();
  });

  it('every group Reviewed: ready for a PR, and Create PR asks Claude for it', async () => {
    const diff = diffOf();
    loaded = { diff, base: 'b', fromMergeBase: true, uncommitted: new Set() };
    saveGuide(task.id, guideFor(diff));
    pane();
    await banner();
    fireEvent.click(screen.getByRole('region', { name: 'Group' }).querySelector('input[type=checkbox]')!);
    fireEvent.click(screen.getByRole('region', { name: 'Group' }).querySelector('input[type=checkbox]')!);
    const b = await banner();
    await waitFor(() => expect(within(b).getByText('Reviewed: ready for a PR')).toBeTruthy());
    fireEvent.click(within(b).getByRole('button', { name: 'Create PR' }));
    await waitFor(() => expect(asked).toEqual([{ id: task.id, base: 'main', escape: false }]));
  });

  it('out of date: the commits since, in the warning tone, with the one Rewrite', async () => {
    const diff = diffOf();
    saveGuide(task.id, guideFor(diff));
    const moved = diffOf(20);
    loaded = { diff: moved, base: 'b', fromMergeBase: true, uncommitted: new Set() };
    setGateReaderForTests(async () => loaded, async () => 2);
    pane();
    const b = await banner();
    expect(b.getAttribute('data-tone')).toBe('warn');
    await waitFor(() => expect(within(b).getByText('2 commits since this guide was written')).toBeTruthy());
    expect(within(b).getByText(/Rewrite it to open a PR\. Groups whose code didn’t change stay Reviewed\./)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Rewrite/ })).toHaveLength(1);
  });

  it('none once there is a PR, nor on a chat or a review task', async () => {
    const diff = diffOf();
    loaded = { diff, base: 'b', fromMergeBase: true, uncommitted: new Set() };
    saveGuide(task.id, guideFor(diff));
    prAnswer = {
      number: 5, url: 'u', title: 'p', state: 'draft', headRefName: 'feat', baseRefName: 'main', headSha: '', mergedAt: null,
      review: null, checks: { kind: 'pending', pending: 1, total: 1 }, lines: [],
    };
    // gh has answered: a draft.
    await refreshPrStatus(task, { force: true });
    expect(getPrStatus(task.id)?.state).toBe('draft');
    pane();
    await screen.findByRole('heading', { name: 'Alpha and beta' });
    expect(screen.queryByRole('region', { name: 'Review before a PR' })).toBeNull();
    cleanup();

    prAnswer = null;
    const review = { ...task, id: 10, reviewUrl: 'https://github.com/o/r/pull/3' } as Task;
    saveGuide(review.id, guideFor(diff));
    pane(review);
    await screen.findByRole('heading', { name: 'Alpha and beta' });
    expect(screen.queryByRole('region', { name: 'Review before a PR' })).toBeNull();
  });
});
