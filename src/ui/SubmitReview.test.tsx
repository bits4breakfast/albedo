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
  /** While set, gh waits for it. */
  hold: null as Promise<void> | null,
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
        if (state.hold) await state.hold;
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
const { setReviewFetcherForTests, refreshReviews } = await import('../gh/reviewStore');

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
  localCommits: 1,
};

afterEach(() => {
  cleanup();
  resetSubmitRequestForTests();
  state.input = null;
  state.results = [];
  state.calls = [];
  state.sent = [];
  state.drafts = 0;
  state.hold = null;
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

describe('across a task switch', () => {
  it('a send still going when you come back: Submit stays off, and the review is posted once', async () => {
    state.input = INPUT;
    let release = () => {};
    state.hold = new Promise<void>((r) => (release = r));
    const first = render(<ReviewBadge task={TASK} />);
    requestSubmitReview(1);
    const d = within(await screen.findByRole('dialog'));
    await d.findByText('1 comment');
    fireEvent.click(d.getByRole('button', { name: 'Submit Review' }));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    // Another task selected: the badge and its dialog go.
    first.unmount();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Back: the dialog does not open on its own.
    render(<ReviewBadge task={TASK} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Opened again while the first send runs: it says so, and cannot send.
    requestSubmitReview(1);
    const again = within(await screen.findByRole('dialog'));
    await again.findByText('1 comment');
    const button = again.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    release();
    await waitFor(() => expect(state.sent).toEqual([[1], [2]]));
    expect(state.calls.filter((c) => c.some((a) => a.endsWith('/reviews')))).toHaveLength(1);
  });
});

describe('keys and focus', () => {
  it('Escape closes the dialog and nothing behind it, and the keyboard goes back where it was', async () => {
    state.input = INPUT;
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    render(
      <>
        <button type="button">before</button>
        <ReviewBadge task={TASK} />
      </>,
    );
    const before = screen.getByRole('button', { name: 'before' });
    before.focus();
    requestSubmitReview(1);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(behind).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(before);
    window.removeEventListener('keydown', behind);
  });
});

describe('a pull request that moved on GitHub', () => {
  it('says how many new commits there are', async () => {
    setReviewFetcherForTests(async () => ({
      viewer: 'me',
      prs: [{ url: TASK.reviewUrl!, headOid: 'ffff', commitCount: 3 } as never],
    }));
    await refreshReviews('/repo', { force: true });
    state.input = INPUT;
    render(<ReviewBadge task={TASK} />);
    requestSubmitReview(1);
    expect(await screen.findByText('2 new commits on GitHub')).toBeTruthy();
  });
});
