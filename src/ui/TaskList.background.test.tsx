/**
 * @vitest-environment jsdom
 *
 * Background work on the task row (#122): on an Idle or Done row whose live
 * session has work running, in the caption -- when it next wakes itself
 * (#443), else "N in background"; not on the selected row, whose Background
 * band says it, and not on a Running row.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Message, Task } from '../types';
import { parseLine } from '../capture/adapter';
import { backgroundShell, cronTimer, wakeup } from '../capture/backgroundFixtures';
import { runTimeText } from './BackgroundWork';

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
  remoteControlLineSince: async () => null,
  backgroundRowsSince: async (sessionId: string): Promise<Message[]> =>
    (LINES[sessionId] ?? []).flatMap((line, i) => parseLine(JSON.stringify(line), i).map((m) => ({ ...m, id: i + 1, taskId: 1, agentId: null }))),
}));

/** A wake-up 10 minutes after it was set; a timer whose first run is an hour away. */
const WAKES_AT = SPAWNED + 2_000 + 600_000;
const CHECKS_AT = SPAWNED + 60 * 60_000;
const LINES: Record<string, Record<string, unknown>[]> = {
  s1: [...backgroundShell('t1', 'b1', SPAWNED + 1_000), ...wakeup('w1', SPAWNED + 2_000, 600)],
  s2: [...backgroundShell('t2', 'b2', SPAWNED + 1_000)],
  s3: [...cronTimer('c3', 'job3', SPAWNED + 1_000, { cron: '13,43 * * * *', nextFireAt: CHECKS_AT })],
  s4: [...backgroundShell('t4', 'b4', SPAWNED + 1_000)],
};

const { default: TaskList } = await import('./TaskList');

afterEach(cleanup);

const base = {
  projectId: 1, repoPath: '/r/app', createdBranch: false, kind: 'work', baseBranch: 'main',
  ownsWorktree: true, createdAt: 1, lastActivityAt: 1, seenAt: null, summary: null, reviewUrl: null, apiError: null, apiErrorText: null, spunFromTaskId: null,
} as const;
const idle: Task = { ...base, id: 1, status: 'idle', title: 'Fix login', sessionId: 's1', branch: 'fix-login', worktreePath: '/w/fix-login' };
const running: Task = { ...base, id: 2, status: 'running', title: 'Add search', sessionId: 's2', branch: 'add-search', worktreePath: '/w/add-search' };
const done: Task = { ...base, id: 3, status: 'done', title: 'Watch the deploy', sessionId: 's3', branch: 'deploy-watch', worktreePath: '/w/deploy-watch' };
const shells: Task = { ...base, id: 4, status: 'idle', title: 'Run the suite', sessionId: 's4', branch: 'suite', worktreePath: '/w/suite' };

describe('TaskList: background work', () => {
  it('says when an idle row next wakes itself, in its caption, the soonest of its work', async () => {
    render(<TaskList tasks={[idle, running]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    const marks = await screen.findAllByText(`wakes ${runTimeText(WAKES_AT, Date.now())}`);
    expect(marks).toHaveLength(1);
    const mark = marks[0]!;
    expect(mark.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe('1');
    expect(mark.closest('.task-meta-tail')).not.toBeNull();
    expect(mark.getAttribute('title')).toBe(
      `Running in the background:\nShell: Poll CI until green\nWake-up (${runTimeText(WAKES_AT, Date.now())}): Timer: wait 5 minutes before the next check`,
    );
    // Not on the Running row, whose shell is running too.
    expect(screen.queryByText('1 in background')).toBeNull();
  });

  it('says it on a Done row too: a task marked Done can keep checking (#443)', async () => {
    render(<TaskList tasks={[done, shells]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    const mark = await screen.findByText(`next check ${runTimeText(CHECKS_AT, Date.now())}`);
    expect(mark.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe('3');
    // Shells alone keep the count.
    const count = await screen.findByText('1 in background');
    expect(count.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe('4');
    expect(count.getAttribute('data-wake')).toBeNull();
  });

  it('leaves it off the selected row, whose Background band lists it', async () => {
    // Selecting a row scrolls it into view, which jsdom does not implement.
    Element.prototype.scrollIntoView = () => {};
    render(<TaskList tasks={[idle, running]} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/in background|wakes/)).toBeNull();
  });
});
