/**
 * @vitest-environment jsdom
 *
 * The task list's Building | Reviewing tabs (#287): the header row, the
 * Reviewing list from the review store, and a row opening its PR on GitHub
 * and clearing its dot. Driven through the rendered controls, not the
 * handlers (REGRESSIONS: "The affordance was never drawn").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '../types';
import type { ReviewPr, ReviewRequests } from '../gh/reviewRequests';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));
// Review Started reads the review task's comments (#315): real SQLite, as comments.test.ts.
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));
const opened = vi.hoisted(() => ({ calls: [] as string[], fail: null as string | null }));
vi.mock('./openReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openReview')>()),
  openReviewTask: async (_project: unknown, pr: { url: string; title: string }) => {
    opened.calls.push(pr.url);
    if (opened.fail) throw new Error(opened.fail);
    return { ...reviewTask, id: 99, title: pr.title, reviewUrl: pr.url };
  },
}));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const { openExternal } = await import('../lib/openUrl');
const store = await import('../gh/reviewStore');
const { KEYS } = await import('./persisted');
const { createTestDb } = await import('../db/testkit');
const { resetDb } = await import('../db');
const { addComment } = await import('../db/comments');
const guideStore = await import('../guide/store');

const H = 3_600_000;
const NOW = Date.parse('2026-11-09T12:00:00Z');

const project: Project = { id: 1, name: 'relay', repoPath: '/r/relay' } as Project;
const reviewTask = {
  id: 7, title: 'Bump parser', projectId: 1, repoPath: '/r/relay', sessionId: null, createdBranch: true, baseBranch: 'main',
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1, summary: null, branch: 'review/405',
  worktreePath: '/w/review-405', reviewUrl: 'u/405',
} as Task;
const task = {
  id: 1, title: 'Fix login', projectId: 1, repoPath: '/r/relay', sessionId: null, createdBranch: false, baseBranch: 'main',
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1, summary: null, branch: 'b1',
  worktreePath: '/w/1',
} as Task;

function pr(over: Partial<ReviewPr>): ReviewPr {
  return {
    url: 'https://github.com/acme/relay/pull/1', number: 1, title: 'One', isDraft: false, author: 'alice',
    additions: 84, deletions: 12, headOid: 'h1', baseBranch: 'main', commitCount: 2, lastCommitAt: NOW - 30 * H, createdAt: NOW - 30 * H,
    updatedAt: NOW - 30 * H, requestedAt: NOW - 20 * H, teams: [], talk: [], forcePushedAt: null, yourReview: null, section: 'requested',
    ...over,
  };
}

let data: Map<string, string>;
let answer: ReviewRequests | null;
const fetches: string[] = [];

beforeEach(() => {
  resetDb();
  harness.db = createTestDb();
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  fetches.length = 0;
  answer = {
    viewer: 'me',
    prs: [
      pr({ url: 'u/412', number: 412, title: 'Retry webhook delivery', headOid: 'h2', commitCount: 4, lastCommitAt: NOW - 2 * H }),
      pr({ url: 'u/405', number: 405, title: 'Bump parser', author: 'carol', teams: ['platform'] }),
    ],
  };
  // You opened #412 before its last two commits.
  data.set(KEYS.reviewSeen, JSON.stringify({ 'u/412': { at: NOW - 5 * H, head: 'h1', commits: 2 } }));
  store.setReviewFetcherForTests(
    async (repoPath) => {
      fetches.push(repoPath);
      return answer;
    },
    () => NOW,
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(openExternal).mockClear();
  onSelect.mockClear();
  onReviewOpened.mockClear();
  opened.calls.length = 0;
  opened.fail = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const onSelect = vi.fn();
const onReviewOpened = vi.fn();
const list = (selectedId: number | null, onNew = vi.fn(), tasks: Task[] = [task, reviewTask]) => (
  <TaskList
    tasks={tasks}
    selectedId={selectedId}
    onSelect={onSelect}
    onNew={onNew}
    projects={[project]}
    activeProject={project}
    onReviewOpened={onReviewOpened}
  />
);

async function renderList(onNew = vi.fn(), selectedId: number | null = null) {
  const r = render(list(selectedId, onNew));
  await act(async () => {
    await Promise.resolve();
  });
  return Object.assign(onNew, { rerender: r.rerender });
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('Building | Reviewing', () => {
  it('Building is the default: the task rows, and New Task as a + that opens the dialog', async () => {
    const onNew = await renderList();
    expect(tab(/Building/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Fix login')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    expect(onNew).toHaveBeenCalled();
  });

  it('Reviewing counts what waits on you, asked once for the project, while Building shows', async () => {
    await renderList();
    expect(fetches).toEqual(['/r/relay']);
    expect(within(tab(/Reviewing/)).getByText('2')).toBeTruthy();
    expect(within(tab(/Building/)).getByText('1')).toBeTruthy();
  });

  it('Reviewing lists new activity first, says what is new, and has no New Task', async () => {
    await renderList();
    fireEvent.click(tab(/Reviewing/));
    expect(tab(/Reviewing/).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('button', { name: 'New Task' })).toBeNull();
    // Its place holds Refresh, so the tabs keep their width; it asks again at once.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Review Requests' }));
      await Promise.resolve();
    });
    expect(fetches).toEqual(['/r/relay', '/r/relay']);
    expect(screen.queryByText('Fix login')).toBeNull();

    const groups = screen.getAllByRole('group');
    expect(within(groups[0]!).getByText('New Activity')).toBeTruthy();
    expect(within(groups[0]!).getByText(/Retry webhook delivery/)).toBeTruthy();
    expect(within(groups[0]!).getByText('2 new commits')).toBeTruthy();
    expect(within(groups[1]!).getByText('Requested')).toBeTruthy();
    expect(within(groups[1]!).getByText('team platform')).toBeTruthy();
    // The choice is remembered.
    expect(data.get(KEYS.taskListTab)).toBe('reviewing');
  });

  it('a row checks its PR out as a review task, in Albedo, never on GitHub; the news is seen', async () => {
    await renderList();
    fireEvent.click(tab(/Reviewing/));
    const row = screen.getByText(/Retry webhook delivery/).closest('button')!;
    expect(row.getAttribute('data-unseen')).toBe('true');
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    expect(opened.calls).toEqual(['u/412']);
    expect(onReviewOpened).toHaveBeenCalledWith(expect.objectContaining({ id: 99, reviewUrl: 'u/412' }));
    expect(openExternal).not.toHaveBeenCalled();
    // Seen now: no longer New Activity.
    expect(screen.queryByText('New Activity')).toBeNull();
    expect(JSON.parse(data.get(KEYS.reviewSeen)!)['u/412']).toEqual({ at: NOW, head: 'h2', commits: 4 });
  });

  it('a PR already open as a review task is selected, not checked out again', async () => {
    await renderList();
    fireEvent.click(tab(/Reviewing/));
    fireEvent.click(screen.getByText(/Bump parser/).closest('button')!);
    expect(onSelect).toHaveBeenCalledWith(7);
    expect(opened.calls).toEqual([]);
  });

  it('a checkout that fails says why under the row', async () => {
    opened.fail = 'No remote of this repository is github.com/acme/relay';
    await renderList();
    fireEvent.click(tab(/Reviewing/));
    await act(async () => {
      fireEvent.click(screen.getByText(/Retry webhook delivery/).closest('button')!);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('Could not check out #412: No remote');
  });

  it('review tasks are not in Building, and selecting one shows Reviewing', async () => {
    const r = await renderList();
    expect(screen.queryByText('Bump parser')).toBeNull();
    expect(within(tab(/Building/)).getByText('1')).toBeTruthy();
    r.rerender(list(7));
    expect(tab(/Reviewing/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Bump parser/).closest('button')!.getAttribute('data-selected')).toBe('true');
  });

  it('a review task whose PR left the list stays, last, to read and archive', async () => {
    answer = { viewer: 'me', prs: [] };
    await renderList();
    fireEvent.click(tab(/Reviewing/));
    expect(screen.getByText('Closed or No Longer Asked')).toBeTruthy();
    fireEvent.click(screen.getByText(/Bump parser/).closest('button')!);
    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it('says so when GitHub cannot be asked, instead of an empty list', async () => {
    answer = null;
    await renderList();
    fireEvent.click(tab(/Reviewing/));
    expect(screen.getByText(/Can't ask GitHub about relay/)).toBeTruthy();
    expect(within(tab(/Reviewing/)).queryByText(/\d/)).toBeNull();
  });

  it('a remembered Reviewing tab survives a restart; a task chosen from elsewhere brings Building back', async () => {
    data.set(KEYS.taskListTab, 'reviewing');
    const r = await renderList(vi.fn(), 1);
    expect(tab(/Reviewing/).getAttribute('aria-selected')).toBe('true');
    r.rerender(list(null));
    expect(tab(/Reviewing/).getAttribute('aria-selected')).toBe('true');
    r.rerender(list(1));
    expect(tab(/Building/).getAttribute('aria-selected')).toBe('true');
  });

  it('an empty list says nothing is asked of you', async () => {
    answer = { viewer: 'me', prs: [] };
    const r = await renderList();
    r.rerender(list(null, vi.fn(), [task]));
    fireEvent.click(tab(/Reviewing/));
    expect(screen.getByText('No reviews asked of you in relay.')).toBeTruthy();
  });
});

describe('Review Started and Approved (#315)', () => {
  const guide = {
    diffHash: 'h', writtenAt: 1, base: 'main', fallback: null,
    groups: [{ title: 'Parser', summary: '', blocks: ['a1'] }, { title: 'Tests', summary: '', blocks: ['b1'] }],
    files: { 'src/parse.ts': ['a1'], 'src/parse.test.ts': ['b1'] },
  };
  const groupOf = (title: string) => screen.getByText(title, { selector: '.group-label span' }).closest('[role="group"]') as HTMLElement;
  const groupTitles = () => screen.getAllByRole('group').map((g) => g.querySelector('.group-label span')?.textContent);

  async function showReviewing() {
    await renderList();
    fireEvent.click(tab(/Reviewing/));
  }

  it('ticking Reviewed in the Guide moves the PR to Review Started at once, saying how far along', async () => {
    guideStore.saveGuide(7, guide);
    await showReviewing();
    expect(within(groupOf('Requested')).getByText(/Bump parser/)).toBeTruthy();
    act(() => guideStore.setReviewed(7, [guideStore.reviewedKey('src/parse.ts', ['a1'])], true));
    expect(within(await screen.findByRole('group', { name: /Review Started/ })).getByText(/Bump parser/)).toBeTruthy();
    expect(groupTitles()).toEqual(['New Activity', 'Review Started']);
    expect(within(groupOf('Review Started')).getByText('1/2 groups')).toBeTruthy();
    // Still waiting on you: the count is unchanged.
    expect(within(tab(/Reviewing/)).getByText('2')).toBeTruthy();
  });

  it('a new comment moves it at once; a review submitted after it sends the PR where GitHub says', async () => {
    await showReviewing();
    expect(screen.queryByText('Review Started')).toBeNull();
    await act(async () => {
      await addComment({ taskId: 7, path: 'src/parse.ts', lineStart: 1, lineEnd: 1, anchorText: 'x', body: 'Why?', github: 'draft' });
    });
    const started = await screen.findByRole('group', { name: /Review Started/ });
    expect(within(started).getByText(/Bump parser/)).toBeTruthy();
    expect(within(started).getByText('1 draft')).toBeTruthy();

    // Submitted a minute later, as a comment: Waiting on Author, not counted.
    const at = NOW + 60_000;
    answer = {
      viewer: 'me',
      prs: [
        answer!.prs[0]!,
        { ...answer!.prs[1]!, section: 'reviewed', yourReview: { at, state: 'COMMENTED' }, talk: [{ author: 'me', at }] },
      ],
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Review Requests' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(groupTitles()).toEqual(['New Activity', 'Reviewed · Waiting on Author']));
    expect(within(tab(/Reviewing/)).getByText('1')).toBeTruthy();
  });

  it('a PR your latest review approved is listed last, as Approved, and not counted', async () => {
    const at = NOW - 3 * H;
    answer = {
      viewer: 'me',
      prs: [
        pr({ url: 'u/420', number: 420, title: 'Cache the index' }),
        pr({ url: 'u/418', number: 418, title: 'Rename the queue', section: 'reviewed', yourReview: { at, state: 'APPROVED' }, talk: [{ author: 'me', at }] }),
        pr({ url: 'u/417', number: 417, title: 'Split the worker', section: 'reviewed', yourReview: { at, state: 'CHANGES_REQUESTED' }, talk: [{ author: 'me', at }] }),
      ],
    };
    await showReviewing();
    // The review task's own PR is not in this answer: it stays, last.
    expect(groupTitles()).toEqual(['Requested', 'Reviewed · Waiting on Author', 'Approved', 'Closed or No Longer Asked']);
    expect(within(groupOf('Approved')).getByText(/Rename the queue/)).toBeTruthy();
    expect(within(tab(/Reviewing/)).getByText('1')).toBeTruthy();
  });
});
