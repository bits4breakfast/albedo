// @vitest-environment jsdom
/**
 * Comments on a review task (#287, steps 3 and 4), in the Diff mode and the
 * Guide (both draw useDiffComments): where a new comment goes, a draft's
 * chip, other reviewers' threads at their lines, and a reply. Any other task
 * draws exactly what it did before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReviewComment } from '../../db/comments';
import type { ReviewThread } from '../../gh/reviewThreads';

const state = vi.hoisted(() => ({
  rows: [] as ReviewComment[],
  drafts: [] as ReviewComment[],
  threads: [] as ReviewThread[],
  ranges: null as Map<string, Array<[number, number]>> | null,
}));
const addComment = vi.fn(async () => 1);
const setCommentGithub = vi.fn(async () => {});
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => state.rows),
    onCommentsChanged: vi.fn(() => () => {}),
    addComment,
    setCommentGithub,
    editComment: vi.fn(async () => {}),
    resolveComment: vi.fn(async () => {}),
    resolveComments: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
});
vi.mock('../reviewDrafts', async () => {
  const actual = await vi.importActual<typeof import('../reviewDrafts')>('../reviewDrafts');
  return { ...actual, usePrRanges: () => state.ranges, useGithubDrafts: () => state.drafts };
});
vi.mock('../../gh/reviewThreads', async () => {
  const actual = await vi.importActual<typeof import('../../gh/reviewThreads')>('../../gh/reviewThreads');
  return { ...actual, useReviewThreads: (url: string | null) => (url ? state.threads : []) };
});

const { useDiffComments } = await import('./diffComments');

afterEach(() => {
  cleanup();
  addComment.mockClear();
  setCommentGithub.mockClear();
  state.rows = [];
  state.drafts = [];
  state.threads = [];
  state.ranges = null;
});

const NOW = 'one\ntwo\nthree\nfour\n';
const REVIEW = { id: 1, reviewUrl: 'https://github.com/example/relay/pull/34', worktreePath: '/wt', baseBranch: 'main', kind: 'work' as const, branch: 'review/34' };

const row = (over: Partial<ReviewComment>): ReviewComment => ({
  id: 5, taskId: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'two', body: 'Rename.',
  createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null, ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'T1', path: 'src/a.ts', line: 3, startLine: null, originalLine: 3, side: 'RIGHT', isResolved: false, isOutdated: false,
  replyTo: 9001, anchor: 'three', comments: [{ author: 'alice', body: 'Why three?', createdAt: 0 }], ...over,
});

function openBox(review: typeof REVIEW | null) {
  const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, review));
  act(() => result.current.annotations!.pick(2, 2, true));
  render(<>{result.current.annotations!.after(2)}</>);
  return result;
}

describe('a new comment on a review task', () => {
  it('goes to GitHub unless you say so', async () => {
    openBox(REVIEW);
    const group = screen.getByRole('group', { name: 'Where this comment goes' });
    expect(within(group).getByRole('button', { name: 'Draft for GitHub' }).getAttribute('aria-pressed')).toBe('true');
    const box = screen.getByPlaceholderText(/sent with Submit Review/);
    fireEvent.change(box, { target: { value: 'Rename this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Draft' }));
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ lineStart: 2, body: 'Rename this.', github: 'draft' }));
  });

  it('Ask Claude makes it a comment for the session, as on any task', async () => {
    openBox(REVIEW);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Claude' }));
    fireEvent.change(screen.getByPlaceholderText(/for Claude/), { target: { value: 'What does this do?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ github: null }));
  });

  it('on any other task: no choice, and the comment is stored as before', async () => {
    openBox(null);
    expect(screen.queryByRole('group', { name: 'Where this comment goes' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/for Claude/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({ taskId: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'two', body: 'x' });
  });
});

describe('a draft for GitHub', () => {
  it('says when its lines are outside the PR’s diff', async () => {
    state.rows = [row({ github: 'draft' })];
    state.ranges = new Map([['src/a.ts', [[3, 4]]]]);
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    await waitFor(() => expect(result.current.annotations!.after(2)).not.toBeNull());
    render(<>{result.current.annotations!.after(2)}</>);
    expect(screen.getByText('↑ Draft · not in the diff: in the summary')).toBeTruthy();
  });
});

describe('a draft for GitHub, with the PR’s diff not known', () => {
  it('is taken as in the diff, as Submit Review takes it: GitHub decides', async () => {
    state.rows = [row({ github: 'draft' })];
    state.ranges = null;
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    await waitFor(() => expect(result.current.annotations!.after(2)).not.toBeNull());
    render(<>{result.current.annotations!.after(2)}</>);
    expect(screen.getByText('↑ Draft · goes with Submit Review')).toBeTruthy();
  });
});

describe('other reviewers’ threads', () => {
  it('show at the line holding their code, with their comments and your reply drafts', async () => {
    state.threads = [thread()];
    state.drafts = [row({ id: 7, github: 'draft', replyTo: 9001, anchorText: '', body: 'Because of the retries.' })];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    render(<>{result.current.annotations!.after(3)}</>);
    expect(screen.getByText('Why three?')).toBeTruthy();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('Because of the retries.')).toBeTruthy();
    expect(screen.getByText('↑ Draft · goes with Submit Review')).toBeTruthy();
  });

  it('one Open on GitHub, always shown, and no ⋯; the chip says the state only when it has one (#327)', () => {
    state.threads = [thread()];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    render(<>{result.current.annotations!.after(3)}</>);
    expect(screen.getAllByRole('button', { name: 'Open on GitHub' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.getByText('1 comment')).toBeTruthy();
    expect(screen.queryByText(/On GitHub ·/)).toBeNull();
  });

  it('a resolved one says so in its chip, and folds again from the head', () => {
    state.threads = [thread({ isResolved: true })];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    render(<>{result.current.annotations!.after(3)}</>);
    expect(screen.getByText('✓ Resolved · 1 comment')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fold' }));
    expect(screen.queryByText('Why three?')).toBeNull();
  });

  it('a reply is stored as a draft for that thread', async () => {
    state.threads = [thread()];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    render(<>{result.current.annotations!.after(3)}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Agreed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Reply' }));
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 9001, body: 'Agreed.', anchorText: '' }));
  });

  it('a resolved one is folded until Show', () => {
    state.threads = [thread({ isResolved: true })];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    render(<>{result.current.annotations!.after(3)}</>);
    expect(screen.queryByText('Why three?')).toBeNull();
    expect(screen.getByText(/alice: “Why three\?”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('Why three?')).toBeTruthy();
  });

  it('one not on this version’s lines is in the bar above the file, never pinned to a guess', () => {
    state.threads = [thread({ anchor: 'not here', line: 3 })];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, REVIEW));
    expect(result.current.annotations!.after(3)).toBeNull();
    render(<>{result.current.bar}</>);
    expect(screen.getByText(/1 thread on GitHub not on this version’s lines/)).toBeTruthy();
  });

  it('nothing of the kind on any other task', () => {
    state.threads = [thread()];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null));
    expect(result.current.annotations!.after(3)).toBeNull();
  });
});
