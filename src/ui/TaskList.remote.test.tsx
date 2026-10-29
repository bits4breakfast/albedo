/**
 * @vitest-environment jsdom
 *
 * The task row's "Remote" mark (#114): on the row whose live pty has Remote
 * Control on, in the caption, and a click on it opens the session rather than
 * selecting the task.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

const URL = 'https://claude.ai/code/session_example';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));
vi.mock('./Terminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./Terminal')>()),
  // Task 1 has a live pty; task 2 has none.
  usePtyLiveSince: (id: number | null) => (id === 1 ? 5_000 : null),
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  remoteControlUrlSince: async () => URL,
}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock('../lib/openUrl', () => ({ openExternal: async (url: string) => void opened.push(url) }));

const { default: TaskList } = await import('./TaskList');

afterEach(cleanup);

const base = {
  projectId: 1, repoPath: '/r/app', createdBranch: false, kind: 'work', baseBranch: 'main',
  ownsWorktree: true, status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null,
} as const;
const remote: Task = { ...base, id: 1, title: 'Fix login', sessionId: 's1', branch: 'fix-login', worktreePath: '/w/fix-login' };
const local: Task = { ...base, id: 2, title: 'Add search', sessionId: 's2', branch: 'add-search', worktreePath: '/w/add-search' };

describe('TaskList: Remote Control', () => {
  it('marks only the row that is reachable, in its caption', async () => {
    const onSelect = vi.fn();
    render(<TaskList tasks={[remote, local]} selectedId={null} onSelect={onSelect} onNew={() => {}} />);
    const marks = await screen.findAllByRole('button', { name: 'Available through Remote Control. Open on claude.ai' });
    expect(marks).toHaveLength(1);
    const mark = marks[0]!;
    expect(mark.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe('1');
    expect(mark.closest('.task-meta-tail')).not.toBeNull();

    fireEvent.click(mark);
    expect(opened).toEqual([URL]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
