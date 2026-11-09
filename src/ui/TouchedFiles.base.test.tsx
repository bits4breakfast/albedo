// @vitest-environment jsdom
/**
 * What the Files pane measures a task against (#237): the branch the header
 * shows it merging into, and when git cannot find that branch it says so,
 * never "No changes yet". The owner's case: a task cut from `feature-a`, its
 * PR retargeted to `main` after `feature-a` merged and was deleted locally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';

vi.mock('./persisted', async (importActual) => ({
  ...(await importActual<typeof import('./persisted')>()),
  readPersisted: <T, F>(_k: string, _c: unknown, fallback: F) => fallback as unknown as T,
  writePersisted: () => {},
}));
const prs = vi.hoisted(() => ({ answer: undefined as PrStatus | null | undefined }));
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => prs.answer,
  usePrStatus: () => prs.answer ?? null,
}));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => null }));
vi.mock('../db/touched', async (importActual) => ({
  ...(await importActual<typeof import('../db/touched')>()),
  touchedFilesDetailed: async () => ({ files: [], gitError: null }),
}));
const asked = vi.hoisted(() => ({ bases: [] as string[], resolves: true }));
vi.mock('../git/worktree', async (importActual) => ({
  ...(await importActual<typeof import('../git/worktree')>()),
  lineChanges: async (_w: string, base: string) => {
    asked.bases.push(base);
    return new Map();
  },
  changeKinds: async () => new Map(),
  unmergedCommits: async () => null,
  branchCommits: async () => [],
  committedFileTimes: async () => new Map(),
  taskBase: async (_w: string, base: string) => (asked.resolves && base !== '' ? 'abc1234' : null),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: async () => Promise.reject(new Error('no fs')) }));
vi.mock('../capture', () => ({ onCaptureUpdate: () => () => {} }));
vi.mock('./CommentsSection', () => ({ default: () => null }));
const gitBar = vi.hoisted(() => ({ bases: [] as string[] }));
vi.mock('./GitBar', () => ({
  default: (p: { task: { baseBranch: string } }) => {
    gitBar.bases.push(p.task.baseBranch);
    return null;
  },
}));

const { default: TouchedFiles, baseNote } = await import('./TouchedFiles');

const task: Task = {
  id: 7, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'feature-a', branch: 'feature-b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
  reviewUrl: null,
};
const retargeted = { number: 12, baseRefName: 'main', state: 'open' } as PrStatus;

beforeEach(() => {
  asked.bases = [];
  asked.resolves = true;
  prs.answer = retargeted;
});
afterEach(cleanup);

describe('the Files pane’s base (#237)', () => {
  it('is the PR’s base, not the branch the task was cut from', async () => {
    render(<TouchedFiles task={task} />);
    await waitFor(() => expect(asked.bases).toContain('main'));
    expect(asked.bases).not.toContain('feature-a');
  });

  it('hands the git actions the same base: Squash & Rebase and Create PR act on main', async () => {
    gitBar.bases = [];
    render(<TouchedFiles task={task} />);
    await waitFor(() => expect(gitBar.bases.length).toBeGreaterThan(0));
    expect(gitBar.bases.at(-1)).toBe('main');
  });

  it('says it cannot find the base, instead of "No changes yet"', async () => {
    asked.resolves = false;
    render(<TouchedFiles task={task} />);
    expect(await screen.findByText(/Can’t find the base branch/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('main');
    expect(screen.getByRole('status').textContent).toContain('the task was cut from feature-a');
    expect(screen.queryByText('No changes yet.')).toBeNull();
  });

  it('waits for gh before saying so: the PR may still move the base', async () => {
    asked.resolves = false;
    prs.answer = undefined;
    render(<TouchedFiles task={task} />);
    await waitFor(() => expect(asked.bases).toContain('feature-a'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Can’t find the base branch/)).toBeNull();
  });

  it('the main checkout (no branch, no base) is unchanged: "No changes yet", never a missing base', async () => {
    asked.resolves = false;
    prs.answer = null;
    render(<TouchedFiles task={{ ...task, id: -1, branch: '', baseBranch: '', ownsWorktree: false }} />);
    expect(await screen.findByText('No changes yet.')).toBeTruthy();
    expect(asked.bases).toEqual(['']);
    expect(screen.queryByText(/Can’t find the base branch/)).toBeNull();
  });
});

describe('baseNote', () => {
  it('names why that branch was looked for', () => {
    expect(baseNote('feature-a', 'main', 'main')).toBe('The pull request merges into it; the task was cut from feature-a.');
    expect(baseNote('main', 'main', 'main')).toBe('The pull request merges into it.');
    expect(baseNote('feature-a', null, 'feature-a')).toBe('The task was cut from it, and git has no local or origin copy of it.');
  });
});
