// @vitest-environment jsdom
/**
 * Submit Review (#287, step 3): the action beside the PR badge, its count,
 * and the dialog -- one review from the click, every draft kept on a
 * failure, and only what is left sent again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../types';
import type { GhResult } from '../gh/gh';
import type { SubmitInput } from './reviewDrafts';

const state = vi.hoisted(() => ({
  input: null as SubmitInput | null,
  results: [] as GhResult[],
  calls: [] as string[][],
  sent: [] as number[][],
  drafts: 0,
}));

vi.mock('./reviewDrafts', async () => {
  const actual = await vi.importActual<typeof import('./reviewDrafts')>('./reviewDrafts');
  return {
    ...actual,
    useGithubDrafts: () => Array.from({ length: state.drafts }, (_, i) => ({ id: i })),
    prepareSubmit: vi.fn(async () => state.input),
    submitIo: () => ({
      gh: async (args: string[]) => {
        state.calls.push(args);
        return state.results.shift() ?? { code: 0, stdout: '', stderr: '' };
      },
      writeInput: async () => '/home/me/.albedo/reviews/review-1.json',
      clearInput: async () => {},
      markSent: async (ids: readonly number[]) => void state.sent.push([...ids]),
    }),
  };
});
vi.mock('../gh/reviewThreads', async () => {
  const actual = await vi.importActual<typeof import('../gh/reviewThreads')>('../gh/reviewThreads');
  return { ...actual, refreshThreads: vi.fn(async () => {}) };
});

const { ReviewBadge, requestSubmitReview, resetSubmitRequestForTests } = await import('./SubmitReview');

const TASK = {
  id: 1,
  title: 'Print-friendly recipe page',
  reviewUrl: 'https://github.com/example/recipe-app/pull/34',
  worktreePath: '/wt',
  repoPath: '/repo',
  baseBranch: 'main',
} as unknown as Task;

const INPUT: SubmitInput = {
  drafts: [
    { id: 1, path: 'src/a.ts', lineStart: 3, lineEnd: 3, body: 'Rename.', replyTo: null },
    { id: 2, path: 'src/a.ts', lineStart: 3, lineEnd: 3, body: 'Agreed.', replyTo: 9001 },
  ],
  lost: 0,
  ranges: new Map([['src/a.ts', [[1, 10]]]]),
  commitId: 'abc1234def',
};

afterEach(() => {
  cleanup();
  resetSubmitRequestForTests();
  state.input = null;
  state.results = [];
  state.calls = [];
  state.sent = [];
  state.drafts = 0;
});

describe('the action', () => {
  it('sits beside the PR badge with the drafts counted, and opens the dialog', async () => {
    state.drafts = 2;
    state.input = INPUT;
    render(<ReviewBadge task={TASK} />);
    expect(screen.getByRole('button', { name: '#34 on GitHub' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit Review · 2' }));
    expect(await screen.findByRole('dialog', { name: 'Submit Review' })).toBeTruthy();
    expect(await screen.findByText('1 comment')).toBeTruthy();
    expect(screen.getByText('1, right after the review')).toBeTruthy();
  });

  it('with no drafts, still there: an Approve needs none', () => {
    render(<ReviewBadge task={TASK} />);
    expect(screen.getByRole('button', { name: 'Submit Review' })).toBeTruthy();
  });
});

describe('the dialog', () => {
  async function open() {
    state.input = INPUT;
    render(<ReviewBadge task={TASK} />);
    requestSubmitReview(1);
    await screen.findByText('1 comment');
    return within(screen.getByRole('dialog'));
  }

  it('sends one review with the verdict and summary, then the reply, and closes', async () => {
    const d = await open();
    fireEvent.change(d.getByLabelText(/Summary/), { target: { value: 'Close.' } });
    fireEvent.click(d.getByRole('radio', { name: 'Request Changes' }));
    fireEvent.click(d.getByRole('button', { name: 'Submit Review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.calls[0]).toContain('repos/example/recipe-app/pulls/34/reviews');
    expect(state.calls[1]).toContain('repos/example/recipe-app/pulls/34/comments/9001/replies');
    expect(state.sent).toEqual([[1], [2]]);
  });

  it('Request Changes needs a summary before it can go', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('radio', { name: 'Request Changes' }));
    expect(d.getByText('Request Changes needs a summary.')).toBeTruthy();
    expect((d.getByRole('button', { name: 'Submit Review' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refused review: gh’s words, what to do, nothing marked sent, and it can go again', async () => {
    state.results = [{ code: 1, stdout: '', stderr: 'gh: Unprocessable Entity (HTTP 422)\nLine could not be resolved' }];
    const d = await open();
    fireEvent.click(d.getByRole('button', { name: 'Submit Review' }));
    expect(await screen.findByText('GitHub did not take the review')).toBeTruthy();
    expect(screen.getByText(/Line could not be resolved/)).toBeTruthy();
    expect(screen.getByText(/Nothing was sent, and your drafts are kept/)).toBeTruthy();
    expect(state.sent).toEqual([]);
    expect(await screen.findByRole('button', { name: 'Submit Again' })).toBeTruthy();
  });

  it('a reply that failed after the review went: only the reply goes on the next click', async () => {
    state.results = [{ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'HTTP 502' }];
    const d = await open();
    fireEvent.click(d.getByRole('button', { name: 'Submit Review' }));
    expect(await screen.findByText('The review was posted.')).toBeTruthy();
    expect(screen.getByText('1 reply did not go out')).toBeTruthy();
    expect(state.sent).toEqual([[1]]);
    // What is left now: the reply alone.
    state.input = { ...INPUT, drafts: [INPUT.drafts[1]!] };
    const again = await screen.findByRole('button', { name: 'Send 1 Reply' });
    await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(again);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.calls.filter((c) => c.some((a) => a.endsWith('/reviews')))).toHaveLength(1);
    expect(state.sent).toEqual([[1], [2]]);
  });
});
