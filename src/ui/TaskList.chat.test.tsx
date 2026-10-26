/**
 * @vitest-environment jsdom
 *
 * A chat in the task list (#49): a glyph where a branch would be, and no PR
 * polling or branch sync -- syncing would record the main checkout's branch
 * as the chat's own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../types';

const polled: Task[][] = [];
const synced: Task[][] = [];
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: (tasks: Task[]) => void polled.push(tasks),
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: (tasks: Task[]) => void synced.push(tasks) }));

const { default: TaskList } = await import('./TaskList');

afterEach(() => {
  cleanup();
  polled.length = 0;
  synced.length = 0;
});

const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false,
  status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null,
} as const;
const work: Task = { ...base, id: 1, title: 'Fix login', baseBranch: 'main', branch: 'fix-login', worktreePath: '/w/fix-login', ownsWorktree: true, kind: 'work' };
const chat: Task = { ...base, id: 2, title: 'How does capture work?', baseBranch: '', branch: '', worktreePath: '/r/app', ownsWorktree: false, kind: 'chat' };

describe('TaskList with a chat', () => {
  it('marks the chat with a labelled glyph, and only the chat', () => {
    render(<TaskList tasks={[work, chat]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    const marks = screen.getAllByRole('img', { name: 'Chat, no branch' });
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute('title')).toMatch(/no branch/);
    expect(marks[0]?.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe('2');
  });

  it('polls PRs and syncs branches for work tasks only', () => {
    render(<TaskList tasks={[work, chat]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    expect(polled.at(-1)?.map((t) => t.id)).toEqual([1]);
    expect(synced.at(-1)?.map((t) => t.id)).toEqual([1]);
  });
});
