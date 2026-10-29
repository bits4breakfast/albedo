/**
 * @vitest-environment jsdom
 *
 * "N in background" on the task row (#122): on an idle row whose live
 * session has work running, in the caption; not on the selected row, whose
 * Background band says it, and not on a row that is not idle.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message, Task } from '../types';
import { parseLine } from '../capture/adapter';
import { backgroundShell, wakeup } from '../capture/backgroundFixtures';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

const SPAWNED = Date.now() - 60_000;

vi.mock('./Terminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./Terminal')>()),
  // Every task here has a live pty.
  usePtyLiveSince: (id: number | null) => (id === null ? null : SPAWNED),
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  remoteControlUrlSince: async () => null,
  backgroundRowsSince: async (): Promise<Message[]> =>
    [...backgroundShell('t1', 'b1', SPAWNED + 1_000), ...wakeup('w1', SPAWNED + 2_000, 600)].flatMap((line, i) =>
      parseLine(JSON.stringify(line), i).map((m) => ({ ...m, id: i + 1, taskId: 1, agentId: null })),
    ),
}));

const { default: TaskList } = await import('./TaskList');

afterEach(cleanup);

const base = {
  projectId: 1, repoPath: '/r/app', createdBranch: false, kind: 'work', baseBranch: 'main',
  ownsWorktree: true, createdAt: 1, lastActivityAt: 1, seenAt: null,
} as const;
const idle: Task = { ...base, id: 1, status: 'idle', title: 'Fix login', sessionId: 's1', branch: 'fix-login', worktreePath: '/w/fix-login' };
const running: Task = { ...base, id: 2, status: 'running', title: 'Add search', sessionId: 's2', branch: 'add-search', worktreePath: '/w/add-search' };

describe('TaskList: background work', () => {
  it('says how much runs in the background on an idle row, in its caption', async () => {
    render(<TaskList tasks={[idle, running]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    const marks = await screen.findAllByText('2 in background');
    expect(marks).toHaveLength(1);
    const mark = marks[0]!;
    expect(mark.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe('1');
    expect(mark.closest('.task-meta-tail')).not.toBeNull();
    expect(mark.getAttribute('title')).toBe(
      'Running in the background:\nShell: Poll CI until green\nWake-up: Timer: wait 5 minutes before the next check',
    );
  });

  it('leaves it off the selected row, whose Background band lists it', async () => {
    // Selecting a row scrolls it into view, which jsdom does not implement.
    Element.prototype.scrollIntoView = () => {};
    render(<TaskList tasks={[idle, running]} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/in background/)).toBeNull();
  });
});
