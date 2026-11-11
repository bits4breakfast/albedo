// @vitest-environment jsdom
/**
 * The band over a review task's tabs (#352): shown only while the PR's head
 * on GitHub (the Reviewing tab's last answer) is not the copy's HEAD (git),
 * as new commits or a force-push; never for new comments alone; busy while
 * an update runs; and a failure in git's words with Show in Files. The row
 * in the Reviewing tab says the same, with Update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';
import type { ReviewPr, ReviewRequests } from '../gh/reviewRequests';
import { refreshReviews, setReviewFetcherForTests } from '../gh/reviewStore';
import { setGitRunner, type GitResult } from '../git/worktree';
import { resetSinceReviewForTests } from '../guide/copyUpdate';
import ReviewUpdateBand from './ReviewUpdateBand';
import ReviewList from './ReviewList';
import { reviewGroups } from '../gh/reviewActivity';

const COPY = 'c'.repeat(40);
const URL = 'https://github.com/acme/relay/pull/9';
const NOW = Date.parse('2026-11-11T12:00:00Z');

const task = {
  id: 4, title: 'Retry delivery', projectId: 1, repoPath: '/r', baseBranch: 'main', branch: 'review/9', worktreePath: '/wt-review-9',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: NOW - 86_400_000,
  lastActivityAt: null, seenAt: null, reviewUrl: URL,
} as unknown as Task;

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
  return {
    url: URL, number: 9, title: 'Retry delivery', isDraft: false, author: 'octo', additions: 10, deletions: 2,
    headOid: COPY, baseBranch: 'main', commitCount: 1, lastCommitAt: NOW - 2 * 3_600_000, createdAt: NOW - 86_400_000,
    updatedAt: NOW, requestedAt: null, teams: [], talk: [], forcePushedAt: null, yourReview: null, approved: false,
    section: 'requested', ...over,
  };
}

let gitCalls: string[][];
let fetchResult: GitResult;
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
  resetSinceReviewForTests();
  gitCalls = [];
  fetchResult = { code: 0, stdout: '', stderr: '' };
  // The copy: HEAD is COPY, one commit ahead of main.
  prevGit = setGitRunner(async (args) => {
    gitCalls.push(args);
    const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${COPY}\n`);
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main')) return ok('m\n');
    if (args[0] === 'merge-base') return ok('base\n');
    if (args[0] === 'rev-list') return ok('1\n');
    if (args[0] === 'remote') return ok('origin\tgit@github.com:acme/relay.git (fetch)\n');
    if (args[0] === 'fetch') return fetchResult;
    return { code: 1, stdout: '', stderr: 'unexpected' };
  });
});

afterEach(() => {
  cleanup();
  setGitRunner(prevGit);
});

async function listed(p: ReviewPr): Promise<void> {
  const list: ReviewRequests = { viewer: 'me', prs: [p] };
  setReviewFetcherForTests(async () => list, () => NOW);
  await act(async () => {
    await refreshReviews('/r', { force: true });
  });
}

const band = (onShowFiles = vi.fn()) => render(<ReviewUpdateBand task={task} onShowFiles={onShowFiles} now={NOW} />);

describe('the Update Copy band', () => {
  it('is not there while GitHub’s head is the copy’s', async () => {
    await listed(pr());
    const { container } = band();
    await waitFor(() => expect(gitCalls.some((a) => a[0] === 'rev-parse')).toBe(true));
    expect(container.textContent).toBe('');
  });

  it('is not there for new comments alone', async () => {
    await listed(pr({ talk: [{ author: 'octo', at: NOW - 60_000 }], updatedAt: NOW }));
    const { container } = band();
    await waitFor(() => expect(gitCalls.some((a) => a[0] === 'rev-list')).toBe(true));
    expect(container.textContent).toBe('');
  });

  it('says how many new commits, since when and by whom, with Update Copy', async () => {
    await listed(pr({ headOid: 'd'.repeat(40), commitCount: 4 }));
    band();
    expect(await screen.findByText('3 new commits on GitHub')).toBeTruthy();
    expect(screen.getByText('since your copy · latest 2h ago by octo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update Copy' }).className).toContain('gd-btn-primary');
    expect(screen.getByRole('status').getAttribute('data-tone')).toBeNull();
  });

  it('says force-pushed, on the warn ground, when the push came after the copy', async () => {
    await listed(pr({ headOid: 'd'.repeat(40), commitCount: 1, forcePushedAt: NOW - 3_600_000 }));
    band();
    expect(await screen.findByText('Force-pushed on GitHub')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('warn');
    expect(screen.getByText(/local edits are kept, or the update stops with git’s message/)).toBeTruthy();
  });

  it('is busy while the update runs, and a failure says git’s words with Show in Files', async () => {
    await listed(pr({ headOid: 'd'.repeat(40), commitCount: 2 }));
    const onShowFiles = vi.fn();
    let release!: (r: GitResult) => void;
    const pending = new Promise<GitResult>((r) => (release = r));
    fetchResult = undefined as unknown as GitResult;
    const prev = setGitRunner(async (args, cwd) => (args[0] === 'fetch' ? pending : prev(args, cwd)));
    band(onShowFiles);
    fireEvent.click(await screen.findByRole('button', { name: 'Update Copy' }));
    const busy = await screen.findByRole('button', { name: 'Updating…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release({ code: 128, stdout: '', stderr: "fatal: couldn't find remote ref refs/pull/9/head" });
    });
    expect(await screen.findByText('Couldn’t update')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('git: “fatal: couldn\'t find remote ref refs/pull/9/head” Your copy is unchanged.');
    fireEvent.click(screen.getByRole('button', { name: 'Show in Files' }));
    expect(onShowFiles).toHaveBeenCalledOnce();
    setGitRunner(prev);
  });
});

describe('the Reviewing row (#352)', () => {
  it('says "N new commits · Update" once, and Update starts the update and selects the task', async () => {
    const p = pr({ headOid: 'd'.repeat(40), commitCount: 3 });
    await listed(p);
    const onSelect = vi.fn();
    render(
      <ReviewList
        project={{ id: 1, name: 'relay', repoPath: '/r' } as never}
        state={{ kind: 'ready', list: { viewer: 'me', prs: [p] } }}
        groups={reviewGroups([p], new Map(), 'me')}
        reviewTasks={[task]}
        selectedId={null}
        onSelect={onSelect}
        age={() => '2h'}
      />,
    );
    const update = await screen.findByRole('button', { name: '2 new commits · Update' });
    fireEvent.click(update);
    expect(onSelect).toHaveBeenCalledWith(task.id);
    await waitFor(() => expect(gitCalls.some((a) => a[0] === 'fetch')).toBe(true));
  });

  it('has no update line while the copy is current', async () => {
    const p = pr();
    await listed(p);
    render(
      <ReviewList
        project={{ id: 1, name: 'relay', repoPath: '/r' } as never}
        state={{ kind: 'ready', list: { viewer: 'me', prs: [p] } }}
        groups={reviewGroups([p], new Map(), 'me')}
        reviewTasks={[task]}
        selectedId={null}
        onSelect={() => {}}
        age={() => '2h'}
      />,
    );
    await waitFor(() => expect(gitCalls.some((a) => a[0] === 'rev-list')).toBe(true));
    expect(screen.queryByRole('button', { name: /Update$/ })).toBeNull();
  });
});

