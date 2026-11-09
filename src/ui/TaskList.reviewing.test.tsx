/**
 * @vitest-environment jsdom
 *
 * The task list's Building | Reviewing tabs (#287): the header row, the
 * Reviewing list from the review store, and a row opening its PR on GitHub
 * and clearing its dot. Driven through the rendered controls, not the
 * handlers (REGRESSIONS: "The affordance was never drawn").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Project, Task } from '../types';
import type { ReviewPr, ReviewRequests } from '../gh/reviewRequests';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));
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
    updatedAt: NOW - 30 * H, requestedAt: NOW - 20 * H, teams: [], talk: [], forcePushedAt: null, section: 'requested',
    ...over,
  };
}

let data: Map<string, string>;
let answer: ReviewRequests | null;
const fetches: string[] = [];

beforeEach(() => {
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
