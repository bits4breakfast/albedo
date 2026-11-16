// @vitest-environment jsdom
/**
 * The Guide after Update Copy (#352): "Since your review" at the top, the
 * banner that says the guide is of the previous copy with Update Guide, and
 * the groups with new code marked "changed" -- "Reviewed before" where they
 * had been ticked. The diff is built the way git's is (fixtures.ts); git's
 * answers for the two heads are canned; the writer runs through its runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../types';
import { buildBranchDiff, fileBlockIndex, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';

let loaded: LoadedBranchDiff;
vi.mock('./branchDiff', () => ({ loadBranchDiff: async () => loaded }));
vi.mock('./commentMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./commentMarks')>()),
  useOpenComments: () => [],
}));
vi.mock('../ui/transcript/codeComments', () => ({ useWaitingCodeComments: () => [] }));
vi.mock('../ui/transcript/drafts', () => ({ useComments: () => [] }));
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));

const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide, setReviewed, reviewedKey } = await import('./store');
const { resetSinceReviewForTests } = await import('./copyUpdate');
const { setOneshotRunner } = await import('./writer');
const { setGitRunner } = await import('../git/worktree');
const { KEYS } = await import('../ui/persisted');

const PREV = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

const task = {
  id: 5, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'review/9', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null, reviewUrl: 'https://github.com/acme/relay/pull/9',
} as unknown as Task;

const makeDiff = (cAt = 5, bTag = 'beta'): BranchDiff =>
  buildBranchDiff([edited('src/a.ts', [3, 30], 'alpha'), edited('src/b.ts', [5], bTag), edited('src/c.ts', [cAt], 'gamma')], statReason);

let data: Map<string, string>;
let prevGit: ReturnType<typeof setGitRunner>;
let prevRunner: ReturnType<typeof setOneshotRunner>;

beforeEach(() => {
  data = new Map();
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
  resetSinceReviewForTests();
  // git, for the two heads only: the update was a fast-forward of one commit
  // that changed b.ts and c.ts.
  prevGit = setGitRunner(async (args) => {
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'log') return { code: 0, stdout: `\u001e${NEXT}\u001f${Math.floor(Date.now() / 1000) - 7200}\u001fAddress review: tidy beta and gamma\n`, stderr: '' };
    if (args.includes('--numstat')) return { code: 0, stdout: '1\t1\tsrc/b.ts\n2\t1\tsrc/c.ts\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'not in this test' };
  });
  prevRunner = setOneshotRunner(async () => ({
    code: 0,
    stdout: JSON.stringify({
      type: 'result',
      is_error: false,
      structured_output: { groups: [{ title: 'Rewritten', summary: 'All of it.', blocks: [...loaded.diff.order] }] },
    }),
    stderr: '',
    timedOut: false,
  }));
});

afterEach(() => {
  cleanup();
  setGitRunner(prevGit);
  setOneshotRunner(prevRunner);
});

/** A guide of the copy before the update, a.ts and c.ts ticked; then the copy moves. */
function reviewedThenUpdated(): void {
  const before = makeDiff();
  const [a1, a2, b1, c1] = before.order as [string, string, string, string];
  loaded = { diff: before, base: 'base1', fromMergeBase: true, uncommitted: new Set() };
  const writtenAt = Date.now() - 60_000;
  saveGuide(task.id, {
    diffHash: before.hash,
    writtenAt,
    base: 'main',
    groups: [
      { title: 'Alpha', summary: '', blocks: [a1, a2] },
      { title: 'Beta', summary: '', blocks: [b1] },
      { title: 'Gamma', summary: '', blocks: [c1] },
    ],
    files: fileBlockIndex(before),
    fallback: null,
  });
  setReviewed(task.id, [reviewedKey('src/a.ts', [a1, a2]), reviewedKey('src/c.ts', [c1])], true);
  data.set(KEYS.reviewUpdates, JSON.stringify({ [task.id]: { prev: PREV, next: NEXT, forced: false, at: writtenAt + 1000 } }));
  // The new copy: b.ts and c.ts have new code.
  loaded = { ...loaded, diff: makeDiff(20, 'beta2') };
}

const rail = () => within(screen.getByRole('navigation', { name: 'Groups' }));
const left = () => within(screen.getByRole('region', { name: 'Group' }));
const since = () => within(screen.getByRole('region', { name: 'Since your review' }));

describe('the Guide after Update Copy (#352)', () => {
  it('says the guide is of the previous copy, offers Update Guide, and marks the groups with new code', async () => {
    reviewedThenUpdated();
    render(<GuidePane task={task} active />);
    await screen.findByText(/The Guide was written for your previous copy\. Groups marked/);
    expect(screen.getByRole('button', { name: 'Update Guide' }).className).toContain('gd-btn-primary');
    expect(screen.queryByRole('button', { name: 'Rewrite' })).toBeNull();
    await waitFor(() =>
      expect(rail().getAllByRole('button').map((m) => m.getAttribute('aria-label'))).toEqual([
        '01 Alpha, reviewed',
        '02 Beta, changed',
        '03 Gamma, changed',
      ]),
    );
    expect(rail().getAllByRole('button').map((m) => m.hasAttribute('data-changed'))).toEqual([false, true, true]);
    // Gamma had been ticked: Reviewed before, and how many of its files changed.
    fireEvent.click(rail().getByRole('button', { name: '03 Gamma, changed' }));
    expect(left().getByText('changed')).toBeTruthy();
    expect(left().getByText('Reviewed before · 1 file changed')).toBeTruthy();
    // Beta never was: changed, no "Reviewed before".
    fireEvent.click(rail().getByRole('button', { name: '02 Beta, changed' }));
    expect(left().getByText('changed')).toBeTruthy();
    expect(left().queryByText(/Reviewed before/)).toBeNull();
    // Alpha has no new code: no tag.
    fireEvent.click(rail().getByRole('button', { name: '01 Alpha, reviewed' }));
    expect(left().queryByText('changed')).toBeNull();
  });

  it('shows "Since your review": the heads, the commits and the files, and Hide puts it away', async () => {
    reviewedThenUpdated();
    render(<GuidePane task={task} active />);
    const box = await screen.findByRole('region', { name: 'Since your review' });
    await waitFor(() => expect(box.textContent).toContain('aaaaaaa → bbbbbbb · 1 commit · 2 files'));
    expect(since().getByText('Address review: tidy beta and gamma')).toBeTruthy();
    expect(since().getByText('2h')).toBeTruthy();
    const c = since().getByRole('button', { name: /src\/c\.ts/ });
    expect(c.textContent).toContain('+2');
    expect(c.textContent).toContain('−1');
    // No explanation written for these heads (none was asked for here): it says so, with Write.
    expect(since().getByText('What changed hasn’t been written.')).toBeTruthy();
    expect(since().getByRole('button', { name: 'Write' })).toBeTruthy();
    fireEvent.click(since().getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Since your review' })).toBeNull());
    expect(JSON.parse(data.get(KEYS.reviewUpdates)!)[task.id].hidden).toBe(true);
  });

  it('keeps "Since your review" after Update Guide; the banner goes', async () => {
    reviewedThenUpdated();
    render(<GuidePane task={task} active />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update Guide' }));
    await screen.findByRole('heading', { name: 'Rewritten' });
    expect(screen.queryByText(/written for your previous copy/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Since your review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rewrite' })).toBeTruthy();
  });

  it('shows the explanation once written, with where it came from and Rewrite', async () => {
    reviewedThenUpdated();
    const rec = JSON.parse(data.get(KEYS.reviewUpdates)!);
    rec[task.id].explanation = { text: 'Beta and gamma were tidied after the review.', cut: true, at: 1 };
    data.set(KEYS.reviewUpdates, JSON.stringify(rec));
    render(<GuidePane task={task} active />);
    await screen.findByText('Beta and gamma were tidied after the review.');
    expect(since().getByText(/Written from the changes since your copy, with the diff cut to fit/)).toBeTruthy();
    expect(since().getByRole('button', { name: 'Rewrite' })).toBeTruthy();
  });

  it('a task that is not a review has no box and no tags', async () => {
    reviewedThenUpdated();
    render(<GuidePane task={{ ...task, reviewUrl: null }} active />);
    await screen.findByRole('heading', { name: /Beta|Gamma|Alpha/ });
    expect(screen.queryByRole('region', { name: 'Since your review' })).toBeNull();
    expect(screen.queryByText(/written for your previous copy/)).toBeNull();
  });
});
