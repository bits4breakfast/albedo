/**
 * @vitest-environment jsdom
 *
 * "Follow-up…" is offered where a merge invites it and nowhere else, and it
 * only ever opens the dialog -- filled in, editable, not created.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/m' }));
vi.mock('./ProjectsDialog', () => ({ default: () => null }));
vi.mock('../capture/modelCatalog', () => ({
  loadModelChoices: async () => [],
  loadDefaultModel: async () => null,
}));
vi.mock('../db', () => ({
  createTask: vi.fn(async (t: Omit<Task, 'id' | 'status' | 'createdAt' | 'lastActivityAt' | 'sessionId'>) => ({
    ...t,
    id: 99,
    status: 'idle',
    sessionId: null,
    createdAt: 1,
    lastActivityAt: null,
  })),
}));
vi.mock('../db/projects', () => ({
  listProjects: vi.fn(async () => [
    { id: 1, name: 'other', repoPath: '/r/other', worktreeRoot: '/w/other', defaultBaseBranch: null, createdAt: 5 },
    { id: 3, name: 'app', repoPath: '/r/app', worktreeRoot: '/w/app', defaultBaseBranch: 'main', createdAt: 1 },
  ]),
}));
vi.mock('../git/worktree', async (orig) => ({
  ...(await orig<typeof import('../git/worktree')>()),
  createWorktree: vi.fn(async () => undefined),
  listBranches: vi.fn(async () => ({
    current: 'ACME-2398-fix',
    all: ['main', 'ACME-2398-fix'],
  })),
  undoCreateWorktree: vi.fn(async () => null),
}));

const { refreshPrStatus, setPrFetcherForTests } = await import('../gh/prStore');
const { parsePrView } = await import('../gh/prStatus');
const { PrBadge } = await import('./PrBadge');
const { default: TaskList } = await import('./TaskList');
const { NewTaskDialog } = await import('./NewTaskDialog');
const { buildFollowUp } = await import('./followUp');
const { useMergeNotices } = await import('./mergeNotice');
const attention = await import('./attention');
const wt = await import('../git/worktree');

const task = (over: Partial<Task> = {}): Task => ({
  id: 1,
  title: 'ACME-2398 fix the loop',
  projectId: 3,
  repoPath: '/r/app',
  baseBranch: 'main',
  branch: 'ACME-2398-fix',
  worktreePath: '/w/app/ACME-2398',
  sessionId: 's',
  ownsWorktree: true,
  createdBranch: true,
  status: 'idle',
  createdAt: 1,
  lastActivityAt: 1,
  ...over,
});

const pr = (state: 'OPEN' | 'MERGED', number = 42) =>
  parsePrView(
    JSON.stringify({ number, url: `https://github.com/o/r/pull/${number}`, state, headRefName: 'ACME-2398-fix' }),
  );

/** Per-task answers the fake `gh` gives. */
let answers = new Map<number, ReturnType<typeof pr>>();

beforeEach(() => {
  answers = new Map();
  setPrFetcherForTests(async (t) => answers.get(t.id) ?? null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function prime(id: number, state: 'OPEN' | 'MERGED') {
  answers.set(id, pr(state));
  await act(() => refreshPrStatus({ ...task({ id }) }, { force: true }));
}

describe('PrBadge Follow-up…', () => {
  it('is offered beside Archive… once the PR is merged', async () => {
    await prime(1, 'MERGED');
    const onFollowUp = vi.fn();
    render(<PrBadge task={task()} onEnd={() => {}} onFollowUp={onFollowUp} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-up…' }));
    expect(onFollowUp).toHaveBeenCalledWith(expect.objectContaining({ number: 42, state: 'merged' }));
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeTruthy();
  });

  it('is not offered while the PR is open', async () => {
    await prime(1, 'OPEN');
    render(<PrBadge task={task()} onEnd={() => {}} onFollowUp={() => {}} />);
    await screen.findByText('#42');
    expect(screen.queryByRole('button', { name: 'Follow-up…' })).toBeNull();
  });
});

describe('TaskList row menu Follow-up…', () => {
  const tasks = [
    task({ id: 1, title: 'merged one' }),
    task({ id: 2, title: 'open one' }),
    task({ id: 3, title: 'archived one', status: 'archived' }),
  ];

  async function menuFor(title: string) {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
    return screen.getByRole('menu');
  }
  const followUpItem = (menu: HTMLElement) =>
    [...menu.querySelectorAll('[role=menuitem]')].find((b) => b.textContent?.startsWith('Follow-up'));

  it('appears for a merged or archived task only', async () => {
    await prime(1, 'MERGED');
    await prime(2, 'OPEN');
    const onFollowUp = vi.fn();
    render(
      <TaskList
        tasks={tasks}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onFollowUp={onFollowUp}
      />,
    );

    expect(followUpItem(await menuFor('open one'))).toBeUndefined();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(followUpItem(await menuFor('merged one'))!);
    expect(onFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }));

    fireEvent.click(followUpItem(await menuFor('archived one'))!);
    expect(onFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ id: 3 }));
  });
});

describe('NewTaskDialog prefilled as a follow-up', () => {
  const original = task();

  it('opens filled in, on the project and its default base, and creates nothing by itself', async () => {
    const onCreated = vi.fn();
    const prefill = buildFollowUp(original, { number: 42, url: 'https://github.com/o/r/pull/42', state: 'merged' });
    render(<NewTaskDialog open prefill={prefill} onClose={() => {}} onCreated={onCreated} />);

    expect(await screen.findByText('New follow-up task')).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('ACME-2398 follow-up');
    const prompt = screen.getByLabelText('Initial prompt') as HTMLTextAreaElement;
    expect(prompt.value).toContain('PR #42');
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('3'));
    // The project's default, not the repo's current (shipped) branch.
    await waitFor(() => expect((screen.getByLabelText('Base branch') as HTMLSelectElement).value).toBe('main'));
    expect(screen.getByText('ACME-2398-follow-up')).toBeTruthy();
    // Its own folder, not the shipped task's /w/app/ACME-2398.
    expect(screen.getByText('/w/app/ACME-2398-follow-up')).toBeTruthy();
    expect(wt.createWorktree).not.toHaveBeenCalled();

    // Everything is editable, and what the user wrote is what is sent.
    fireEvent.change(prompt, { target: { value: `${prompt.value}The redirect still loops on Safari.` } });
    const create = screen.getByRole('button', { name: 'Create worktree' });
    await waitFor(() => expect(create).not.toHaveProperty('disabled', true));
    fireEvent.click(create);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(wt.createWorktree).mock.calls[0]?.[0]).toMatchObject({
      baseBranch: 'main',
      branch: 'ACME-2398-follow-up',
      path: '/w/app/ACME-2398-follow-up',
    });
    expect(onCreated.mock.calls[0]?.[1]).toMatch(/PR #42[\s\S]*Safari\.$/);
  });

  it('swaps in the PR prompt when the lookup lands, unless the user has edited it', async () => {
    const pending = { ...buildFollowUp(original, null), pending: true };
    const merged = buildFollowUp(original, { number: 42, url: 'u', state: 'merged' });
    const { rerender } = render(
      <NewTaskDialog open prefill={pending} onClose={() => {}} onCreated={() => {}} />,
    );
    const prompt = (await screen.findByLabelText('Initial prompt')) as HTMLTextAreaElement;
    expect(screen.getByText('Looking up the pull request…')).toBeTruthy();
    rerender(<NewTaskDialog open prefill={merged} onClose={() => {}} onCreated={() => {}} />);
    expect(prompt.value).toContain('gh pr view 42');

    fireEvent.change(prompt, { target: { value: 'mine' } });
    rerender(<NewTaskDialog open prefill={{ ...merged, prompt: 'newer' }} onClose={() => {}} onCreated={() => {}} />);
    expect(prompt.value).toBe('mine');
  });

  it('shows no prompt field for a plain new task', async () => {
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} />);
    await screen.findByText('New task');
    expect(screen.queryByLabelText('Initial prompt')).toBeNull();
  });
});

describe('useMergeNotices', () => {
  beforeEach(() => attention.__setAttentionBackend(() => {}, false, vi.fn()));

  it('notifies for a live open -> merged, and only marks one merged at first sight', async () => {
    const post = vi.fn();
    attention.__setAttentionBackend(() => {}, false, post);
    const tasks = [task({ id: 1, title: 'live' }), task({ id: 2, title: 'old' })];
    await prime(1, 'OPEN');
    await prime(2, 'MERGED');
    renderHook(() => useMergeNotices(tasks));
    expect(attention.attentionMarks().get(2)).toBe('merged');
    expect(attention.attentionMarks().has(1)).toBe(false);
    expect(post).not.toHaveBeenCalled();

    await prime(1, 'MERGED');
    expect(attention.attentionMarks().get(1)).toBe('merged');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ title: 'live', body: 'PR #42 merged — archive or follow up.' });

    // Still merged on the next poll: no repeat.
    await prime(1, 'MERGED');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
