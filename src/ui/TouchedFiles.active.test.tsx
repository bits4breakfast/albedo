// @vitest-environment jsdom
/**
 * The Files pane asks git again only while something reads it (#363). A
 * hidden tab used to reload on every capture update and every window focus,
 * beside the pinned column doing the same for the same task. While inactive
 * a reload is remembered, and runs once when the pane is read again; while
 * active -- the default, and the pinned column -- every signal reloads as
 * before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('./persisted', async (importActual) => ({
  ...(await importActual<typeof import('./persisted')>()),
  readPersisted: <T, F>(_k: string, _c: unknown, fallback: F) => fallback as unknown as T,
  writePersisted: () => {},
}));
vi.mock('../gh/prStore', () => ({ getPrStatus: () => null, usePrStatus: () => null }));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => null }));
const loads = vi.hoisted(() => ({ changeSet: 0, touched: 0 }));
vi.mock('../db/touched', async (importActual) => ({
  ...(await importActual<typeof import('../db/touched')>()),
  touchedFilesDetailed: async () => {
    loads.touched++;
    return { files: [], gitError: null };
  },
}));
vi.mock('../git/worktree', async (importActual) => ({
  ...(await importActual<typeof import('../git/worktree')>()),
  loadChangeSet: async () => {
    loads.changeSet++;
    return { merge: 'abc1234', lines: new Map(), kinds: new Map(), commits: [], committedAt: new Map() };
  },
  unmergedCommits: async () => null,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: async () => Promise.reject(new Error('no fs')) }));
const capture = vi.hoisted(() => ({ listeners: [] as ((u: { sessionId: string; cwd: string | null }) => void)[] }));
vi.mock('../capture', () => ({
  onCaptureUpdate: (cb: (u: { sessionId: string; cwd: string | null }) => void) => {
    capture.listeners.push(cb);
    return () => {
      capture.listeners = capture.listeners.filter((l) => l !== cb);
    };
  },
}));
vi.mock('./CommentsSection', () => ({ default: () => null }));
vi.mock('./GitBar', () => ({ default: () => null }));

const { default: TouchedFiles } = await import('./TouchedFiles');
const { markHandEdited } = await import('../lib/handEdited');

const task: Task = {
  id: 7, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'feature-b',
  worktreePath: '/wt', sessionId: 's1', ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
  reviewUrl: null,
  apiError: null,
  apiErrorText: null,
  spunFromTaskId: null,
};

beforeEach(() => {
  loads.changeSet = 0;
  loads.touched = 0;
  capture.listeners = [];
});
afterEach(cleanup);

const focus = () => act(() => void window.dispatchEvent(new Event('focus')));
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

describe('the Files pane reloads only while it is read (#363)', () => {
  it('active (the default): a focus reloads, as before', async () => {
    render(<TouchedFiles task={task} />);
    await waitFor(() => expect(loads.changeSet).toBe(1));
    await focus();
    await waitFor(() => expect(loads.changeSet).toBe(2));
    expect(loads.touched).toBe(2);
  });

  it('active: a capture update for its session reloads, as before', async () => {
    render(<TouchedFiles task={task} />);
    await waitFor(() => expect(loads.changeSet).toBe(1));
    act(() => capture.listeners.forEach((l) => l({ sessionId: 's1', cwd: null })));
    await waitFor(() => expect(loads.changeSet).toBe(2), { timeout: 2000 });
  });

  it('inactive: still loads once on mount, so its rows are there when shown', async () => {
    render(<TouchedFiles task={task} active={false} />);
    await waitFor(() => expect(loads.changeSet).toBe(1));
    expect(loads.touched).toBe(1);
  });

  it('inactive: focus, capture and a save ask git nothing, and one reload runs when it is read', async () => {
    const view = render(<TouchedFiles task={task} active={false} />);
    await waitFor(() => expect(loads.changeSet).toBe(1));
    await focus();
    await focus();
    act(() => capture.listeners.forEach((l) => l({ sessionId: 's1', cwd: null })));
    act(() => markHandEdited(task.id, 'src/a.ts'));
    await act(() => new Promise((r) => setTimeout(r, 400))); // past the capture debounce
    expect(loads.changeSet).toBe(1);
    expect(loads.touched).toBe(1);

    view.rerender(<TouchedFiles task={task} active />);
    await waitFor(() => expect(loads.changeSet).toBe(2));
    await settle();
    expect(loads.changeSet).toBe(2);
    expect(loads.touched).toBe(2);
  });

  it('shown again with nothing new: no reload', async () => {
    const view = render(<TouchedFiles task={task} active={false} />);
    await waitFor(() => expect(loads.changeSet).toBe(1));
    view.rerender(<TouchedFiles task={task} active />);
    await settle();
    expect(loads.changeSet).toBe(1);
  });
});
