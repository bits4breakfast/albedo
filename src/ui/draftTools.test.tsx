// @vitest-environment jsdom
/**
 * What the GitHub tools (#427) show in the task: a draft the session removed,
 * in Files ▸ Comments and on its card in the diff, with Undo; and the card
 * asking to delete a posted comment. Real SQLite for the drafts; the gate's
 * GitHub side is played by its own functions (githubGate.test.ts tests them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { createTestDb } from '../db/testkit';
import type { Task } from '../types';

const harness = vi.hoisted(() => ({ db: null as unknown }));
const answered = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));
vi.mock('./transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('../gh/reviewThreads', async () => {
  const actual = await vi.importActual<typeof import('../gh/reviewThreads')>('../gh/reviewThreads');
  return { ...actual, useReviewThreads: () => [] };
});
vi.mock('./reviewDrafts', async () => {
  const actual = await vi.importActual<typeof import('./reviewDrafts')>('./reviewDrafts');
  return { ...actual, usePrRanges: () => null };
});
vi.mock('../capture/githubGate', async () => {
  const actual = await vi.importActual<typeof import('../capture/githubGate')>('../capture/githubGate');
  return {
    ...actual,
    answerDeletion: vi.fn(async (d: { requestId: string }, c: string) => {
      answered.push([d.requestId, c]);
      return c === 'keep' ? 'kept' : 'deleted';
    }),
  };
});

const { createTask, resetDb } = await import('../db/index');
const { addComment, listGithubDrafts, deleteComment } = await import('../db/comments');
const removals = await import('../capture/draftRemovals');
const { FileTextContext } = await import('./editor/openFile');
const { default: CommentsSection } = await import('./CommentsSection');
const { useDiffComments } = await import('./editor/diffComments');
const { DeletionCard } = await import('./transcript/DeletionCard');
const gate = await import('../capture/githubGate');

let task: Task;

beforeEach(async () => {
  resetDb();
  harness.db = createTestDb();
  removals.__resetDraftRemovals();
  task = await createTask({
    title: 'Review 34', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'review/34', worktreePath: '/wt/a',
    ownsWorktree: true, createdBranch: true, kind: 'work', reviewUrl: 'https://github.com/example/relay/pull/34',
  });
});
afterEach(() => {
  cleanup();
  answered.length = 0;
  gate.__resetGithubGate();
});

/** What the gate does on delete_github_draft: delete the row, keep it whole. */
async function sessionRemoves(over: Parameters<typeof addComment>[0] extends infer A ? Partial<A> : never = {}, reason: string | null = 'duplicate of the agent’s note') {
  const id = await addComment({
    taskId: task.id, path: 'src/export.ts', lineStart: 2, lineEnd: 2, anchorText: 'two', body: 'Name this rowsForRange', github: 'draft', ...over,
  });
  const row = (await listGithubDrafts(task.id)).find((d) => d.id === id)!;
  await deleteComment(task.id, id);
  act(() => removals.noteDraftRemoved({ row, reason, at: Date.now() }));
  return row;
}

function list() {
  return (
    <FileTextContext.Provider value={async () => 'one\ntwo\nthree\n'}>
      <CommentsSection task={task} onOpen={() => {}} />
    </FileTextContext.Provider>
  );
}

describe('a draft the session removed, in Files ▸ Comments', () => {
  it('shows what was removed and why, and Undo puts back the same draft', async () => {
    const row = await sessionRemoves();
    render(list());
    const line = (await screen.findByText(/Removed by the session/)).closest('.tf-comment')!;
    expect(line.textContent).toContain('export.ts');
    expect(line.textContent).toContain('“Name this rowsForRange”');
    expect(line.textContent).toContain('duplicate of the agent’s note');
    fireEvent.click(within(line as HTMLElement).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(screen.queryByText(/Removed by the session/)).toBeNull());
    expect(await listGithubDrafts(task.id)).toEqual([row]);
  });

  it('goes when you leave the task, not before, and when you submit', async () => {
    await sessionRemoves();
    removals.noteShownTask(task.id);
    render(list());
    await screen.findByText(/Removed by the session/);
    act(() => removals.noteShownTask(task.id + 1));
    await waitFor(() => expect(screen.queryByText(/Removed by the session/)).toBeNull());
    // One made while you were elsewhere waits until you have seen it.
    await sessionRemoves({ lineStart: 1, lineEnd: 1, anchorText: 'one' });
    await screen.findByText(/Removed by the session/);
    act(() => removals.clearDraftRemovals(task.id));
    await waitFor(() => expect(screen.queryByText(/Removed by the session/)).toBeNull());
  });
});

describe('To Send', () => {
  it('never counts or shows a GitHub Draft or a removal line', async () => {
    await addComment({ taskId: task.id, path: 'src/a.ts', lineStart: 1, lineEnd: 1, anchorText: 'one', body: 'Kept draft', github: 'draft' });
    await sessionRemoves();
    render(list());
    await screen.findByText(/Removed by the session/);
    const group = screen.getByRole('group', { name: 'GitHub Draft, 1' });
    expect(within(group).getByText(/Removed by the session/)).toBeTruthy();
    expect(within(group).getByText('Kept draft')).toBeTruthy();
    expect(screen.queryByRole('group', { name: /^To Send/ })).toBeNull();
  });
});

describe('a draft the session removed, in the diff', () => {
  it('an edit box open on a draft holds it against the session', async () => {
    const id = await addComment({ taskId: task.id, path: 'src/export.ts', lineStart: 2, lineEnd: 2, anchorText: 'two', body: 'Mine', github: 'draft' });
    const review = { id: task.id, reviewUrl: task.reviewUrl, worktreePath: '/wt/a', baseBranch: 'main', kind: 'work' as const, branch: 'review/34' };
    const { result, unmount } = renderHook(() => useDiffComments(task.id, 'src/export.ts', 'one\ntwo\nthree\n', false, true, review));
    await waitFor(() => expect(result.current.annotations!.after(2)).not.toBeNull());
    render(<>{result.current.annotations!.after(2)}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(removals.isDraftBeingEdited(id)).toBe(true));
    unmount();
    expect(removals.isDraftBeingEdited(id)).toBe(false);
  });

  it('shows a card at its line, with Undo', async () => {
    const row = await sessionRemoves();
    const review = { id: task.id, reviewUrl: task.reviewUrl, worktreePath: '/wt/a', baseBranch: 'main', kind: 'work' as const, branch: 'review/34' };
    const { result } = renderHook(() => useDiffComments(task.id, 'src/export.ts', 'one\ntwo\nthree\n', false, true, review));
    await waitFor(() => expect(result.current.annotations!.after(2)).not.toBeNull());
    render(<>{result.current.annotations!.after(2)}</>);
    const card = screen.getByText('Removed by the session').closest('.ed-cmt')!;
    expect(card.getAttribute('data-state')).toBe('removed');
    expect(card.textContent).toContain('“Name this rowsForRange” · duplicate of the agent’s note');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await listGithubDrafts(task.id)).toEqual([row]));
    expect(removals.draftRemovalsOf(task.id)).toEqual([]);
  });

  it('shows nothing on a task that is not a review', async () => {
    await sessionRemoves();
    const { result } = renderHook(() => useDiffComments(task.id, 'src/export.ts', 'one\ntwo\nthree\n', false, true, null));
    expect(result.current.annotations!.after(2)).toBeNull();
  });
});

describe('the card asking to delete a posted comment', () => {
  it('shows the comment, the session’s reason, and answers Keep It or Delete on GitHub once', async () => {
    const d: import('../capture/githubGate').PendingDeletion = {
      requestId: 'x-1', taskId: task.id, pr: { host: 'github.com', owner: 'example', repo: 'relay', number: 34 },
      comment: {
        id: 11, author: 'sam', path: 'src/report/daily.ts', line: 42, originalLine: 42, side: 'RIGHT', body: 'use the account timezone',
        createdAt: Date.now() - 2 * 3_600_000, url: null, inReplyTo: null, prApiUrl: null,
      },
      reason: 'Already fixed in the latest commit.', at: Date.now(), cwd: '/wt/a',
    };
    gate.__seedDeletionForTests(d);
    render(<DeletionCard taskId={task.id} />);
    const card = screen.getByRole('group', { name: 'Waiting on You: delete a comment on GitHub' });
    expect(card.textContent).toContain('PR #34 · src/report/daily.ts:42 · posted 2 h ago');
    expect(card.textContent).toContain('use the account timezone');
    expect(card.textContent).toContain('The session says: Already fixed in the latest commit. Deleting on GitHub can’t be undone.');
    const del = within(card).getByRole('button', { name: 'Delete on GitHub' });
    fireEvent.click(del);
    fireEvent.click(del);
    fireEvent.click(within(card).getByRole('button', { name: 'Keep It' }));
    expect(answered).toEqual([['x-1', 'delete']]);
  });

  it('draws nothing while nothing waits', () => {
    const { container } = render(<DeletionCard taskId={task.id} />);
    expect(container.textContent).toBe('');
  });
});
