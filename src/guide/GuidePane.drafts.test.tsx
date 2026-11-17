// @vitest-environment jsdom
/**
 * The guide's comment bubbles on a review task (#440): one plain bubble per
 * file counts every open comment -- To Send and GitHub Drafts together --
 * and says what it is made of. Sent, resolved and posted comments never
 * count, a draft the session removed is gone, and Send N still counts To
 * Send alone. Real SQLite for the comments, read through the same hooks the
 * app uses (`useToSend`, `useGithubDrafts`); the diff is built the way git's
 * is (fixtures.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTestDb } from '../db/testkit';
import type { Task } from '../types';
import { buildBranchDiff, fileBlockIndex, type BranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));
let loaded: LoadedBranchDiff;
vi.mock('./branchDiff', () => ({ loadBranchDiff: async () => loaded }));
vi.mock('../ui/transcript/drafts', () => ({ useComments: () => [] }));
vi.mock('../ui/transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('./repoFiles', () => ({ repoFiles: async () => new Set<string>() }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));

const { createTask, resetDb } = await import('../db/index');
const { addComment, deleteUnsentDraft, markCommentsSent, markDraftsPosted, resolveComment } = await import('../db/comments');
const removals = await import('../capture/draftRemovals');
const { default: GuidePane, resetGuideViewsForTests } = await import('./GuidePane');
const { resetGuideStoreForTests, saveGuide } = await import('./store');
const { setGitRunner } = await import('../git/worktree');

let diff: BranchDiff;
let prevGit: ReturnType<typeof setGitRunner>;

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
  resetDb();
  harness.db = createTestDb();
  removals.__resetDraftRemovals();
  resetGuideStoreForTests();
  resetGuideViewsForTests();
  // No git in these tests: what the guide asks of it beyond the diff is not theirs.
  prevGit = setGitRunner(async () => ({ code: 1, stdout: '', stderr: 'not in this test' }));
  diff = buildBranchDiff([edited('src/a.ts', [3], 'alpha'), edited('src/b.ts', [5], 'beta'), edited('src/c.ts', [5], 'gamma')], statReason);
  loaded = { diff, base: 'base1', fromMergeBase: true, uncommitted: new Set() };
});

afterEach(() => {
  cleanup();
  setGitRunner(prevGit);
});

async function makeTask(reviewUrl: string | null): Promise<Task> {
  const task = await createTask({
    title: 'Review 34', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'review/34', worktreePath: '/wt/a',
    ownsWorktree: true, createdBranch: true, kind: 'work', reviewUrl,
  });
  const [a1, b1, c1] = diff.order as [string, string, string];
  // a.ts and b.ts in one group, c.ts in the next.
  saveGuide(task.id, {
    diffHash: diff.hash,
    writtenAt: Date.now(),
    base: 'main',
    groups: [
      { title: 'Foundations', summary: '', blocks: [a1, b1] },
      { title: 'Wiring', summary: '', blocks: [c1] },
    ],
    files: fileBlockIndex(diff),
    fallback: null,
  });
  return task;
}

const on = (taskId: number, path: string, line: number, github: 'draft' | null, anchorText = `line ${line}`) =>
  addComment({ taskId, path, lineStart: line, lineEnd: line, anchorText, body: 'note', github });

const left = () => within(screen.getByRole('region', { name: 'Group' }));
const rail = () => within(screen.getByRole('navigation', { name: 'Groups' }));
const rowBubble = (name: RegExp) => within(left().getByRole('button', { name })).queryByRole('img', { name: /comment/ });

describe('guide bubbles count every open comment (#440)', () => {
  it('a review task with only GitHub Drafts shows bubbles, on the file, the rail and the Map', async () => {
    const task = await makeTask('https://github.com/example/relay/pull/34');
    await on(task.id, 'src/a.ts', 3, 'draft', 'line 3 alpha');
    await on(task.id, 'src/a.ts', 4, 'draft');
    await on(task.id, 'src/c.ts', 5, 'draft', 'line 5 gamma');
    render(<GuidePane task={task} active />);
    await screen.findByRole('heading', { name: 'Foundations' });

    await waitFor(() => expect(rowBubble(/a\.ts/)?.getAttribute('aria-label')).toBe('2 comments: 2 GitHub Drafts'));
    expect(rowBubble(/a\.ts/)!.getAttribute('title')).toBe('2 comments: 2 GitHub Drafts');
    expect(rowBubble(/a\.ts/)!.textContent).toBe('2');
    expect(rowBubble(/b\.ts/)).toBeNull();
    const [one, two] = rail().getAllByRole('button');
    expect(one!.getAttribute('aria-label')).toBe('01 Foundations, 2 comments: 2 GitHub Drafts');
    expect(one!.getAttribute('title')).toBe('01 Foundations · 2 comments: 2 GitHub Drafts');
    expect(one!.hasAttribute('data-comments')).toBe(true);
    expect(two!.getAttribute('aria-label')).toBe('02 Wiring, 1 comment: 1 GitHub Draft');
    // No To Send: no Send N.
    expect(screen.queryByRole('button', { name: /^Send \d/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const map = within(await screen.findByRole('region', { name: 'Map' }));
    const box = await map.findByRole('button', { name: /^src\/a\.ts;/ });
    expect(box.getAttribute('aria-label')).toMatch(/; 2 comments: 2 GitHub Drafts$/);
    expect(within(box).getByRole('img', { name: '2 comments: 2 GitHub Drafts' }).textContent).toBe('2');
    expect(within(map.getByRole('button', { name: /^src\/b\.ts;/ })).queryByRole('img')).toBeNull();
  });

  it('a mixed file sums both, and says what the sum is made of; Send N counts To Send alone', async () => {
    const task = await makeTask('https://github.com/example/relay/pull/34');
    await on(task.id, 'src/b.ts', 5, null, 'line 5 beta');
    await on(task.id, 'src/b.ts', 5, 'draft', 'line 5 beta');
    await on(task.id, 'src/b.ts', 6, 'draft');
    render(<GuidePane task={task} active />);
    await screen.findByRole('heading', { name: 'Foundations' });

    await waitFor(() => expect(rowBubble(/b\.ts/)?.getAttribute('aria-label')).toBe('3 comments: 1 To Send, 2 GitHub Drafts'));
    expect(rowBubble(/b\.ts/)!.textContent).toBe('3');
    expect(rail().getAllByRole('button')[0]!.getAttribute('aria-label')).toBe('01 Foundations, 3 comments: 1 To Send, 2 GitHub Drafts');
    // The To Send count elsewhere is To Send's: Send 1, not Send 3.
    expect(screen.getByRole('button', { name: 'Send 1' })).toBeTruthy();
    // The opened file's diff header says the same as its row.
    fireEvent.click(left().getByRole('button', { name: /b\.ts/ }));
    const diffRegion = within(screen.getByRole('region', { name: 'Diff' }));
    expect(await diffRegion.findByRole('img', { name: '3 comments: 1 To Send, 2 GitHub Drafts' })).toBeTruthy();
  });

  it('sent, resolved and posted comments are never counted', async () => {
    const task = await makeTask('https://github.com/example/relay/pull/34');
    const sent = await on(task.id, 'src/a.ts', 3, null, 'line 3 alpha');
    await markCommentsSent(task.id, [sent]);
    const resolved = await on(task.id, 'src/a.ts', 4, null);
    await resolveComment(task.id, resolved);
    const posted = await on(task.id, 'src/a.ts', 3, 'draft', 'line 3 alpha');
    await markDraftsPosted(task.id, [posted]);
    const closed = await on(task.id, 'src/a.ts', 4, 'draft');
    await resolveComment(task.id, closed);
    // One open draft elsewhere, so the counts are known to have loaded.
    await on(task.id, 'src/c.ts', 5, 'draft', 'line 5 gamma');
    render(<GuidePane task={task} active />);
    await screen.findByRole('heading', { name: 'Foundations' });

    await waitFor(() => expect(rail().getAllByRole('button')[1]!.getAttribute('aria-label')).toBe('02 Wiring, 1 comment: 1 GitHub Draft'));
    expect(rowBubble(/a\.ts/)).toBeNull();
    expect(rail().getAllByRole('button')[0]!.getAttribute('aria-label')).toBe('01 Foundations');
    expect(rail().getAllByRole('button')[0]!.hasAttribute('data-comments')).toBe(false);
  });

  it('a draft the session removed is gone from the count, and back with Undo', async () => {
    const task = await makeTask('https://github.com/example/relay/pull/34');
    await on(task.id, 'src/a.ts', 3, 'draft', 'line 3 alpha');
    const doomed = await on(task.id, 'src/a.ts', 4, 'draft');
    render(<GuidePane task={task} active />);
    await screen.findByRole('heading', { name: 'Foundations' });
    await waitFor(() => expect(rowBubble(/a\.ts/)?.getAttribute('aria-label')).toBe('2 comments: 2 GitHub Drafts'));

    // As githubGate removes one: the row is deleted, the removal noted.
    const { listGithubDrafts } = await import('../db/comments');
    const row = (await listGithubDrafts(task.id)).find((c) => c.id === doomed)!;
    await act(async () => {
      await deleteUnsentDraft(task.id, doomed);
      removals.noteDraftRemoved({ row, reason: 'duplicate', at: Date.now() });
    });
    await waitFor(() => expect(rowBubble(/a\.ts/)?.getAttribute('aria-label')).toBe('1 comment: 1 GitHub Draft'));

    await act(async () => {
      await removals.undoDraftRemoval(task.id, doomed);
    });
    await waitFor(() => expect(rowBubble(/a\.ts/)?.getAttribute('aria-label')).toBe('2 comments: 2 GitHub Drafts'));
  });

  it('on a task that is not a review, only To Send counts, as before', async () => {
    const task = await makeTask(null);
    await on(task.id, 'src/a.ts', 3, null, 'line 3 alpha');
    await on(task.id, 'src/a.ts', 4, null);
    render(<GuidePane task={task} active />);
    await screen.findByRole('heading', { name: 'Foundations' });
    await waitFor(() => expect(rowBubble(/a\.ts/)?.getAttribute('aria-label')).toBe('2 comments: 2 To Send'));
    expect(screen.getByRole('button', { name: 'Send 2' })).toBeTruthy();
  });
});
