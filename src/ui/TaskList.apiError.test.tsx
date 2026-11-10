/**
 * @vitest-environment jsdom
 *
 * Stopped on an Error (#338): a task whose last turn stopped on an API error
 * has its own group right after Needs You, its row says which error under the
 * title (Claude Code's own text in the tooltip), and Try Again sends "try
 * again" to the session -- only while the session is live, and only when a
 * send would go now.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Task } from '../types';

const sent = vi.hoisted(() => [] as [number, string][]);
const waits = vi.hoisted(() => ({ value: false }));
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));
// Only task 11 has a live session.
vi.mock('./Terminal', () => ({
  hasLivePty: (id: number) => id === 11,
  ptyLiveSince: (id: number) => (id === 11 ? 1 : null),
  usePtyLiveSince: (id: number | null) => (id === 11 ? 1 : null),
  onPtyPresenceChange: () => () => {},
}));
vi.mock('./transcript/send', async (orig) => ({
  ...(await orig<typeof import('./transcript/send')>()),
  useSendsWait: () => waits.value,
  sendToSession: async (taskId: number, text: string) => {
    sent.push([taskId, text]);
    return 'sent';
  },
}));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  remoteControlLineSince: async () => null,
}));
Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');

afterEach(() => {
  cleanup();
  sent.length = 0;
  waits.value = false;
});

const STOPPED = 'API Error: The response stopped arriving. The response above may be incomplete.';

function task(id: number, title: string, over: Partial<Task> = {}): Task {
  return {
    id, title, projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: `b-${id}`,
    worktreePath: `/w/${id}`, sessionId: `s${id}`, ownsWorktree: true, createdBranch: true, kind: 'work',
    status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null, summary: null, reviewUrl: null, apiError: null, apiErrorText: null,
    ...over,
  };
}

function renderList(tasks: Task[], onSelect = vi.fn()) {
  const view = render(<TaskList tasks={tasks} selectedId={null} onSelect={onSelect} onNew={() => {}} />);
  const group = (key: string) => view.container.querySelector(`[aria-labelledby="task-group-${key}"]`) as HTMLElement | null;
  const rowOf = (id: number) => view.container.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
  return { ...view, group, rowOf, onSelect };
}

describe('Stopped on an Error (#338)', () => {
  const tasks = () => [
    task(10, 'Fix login retry', { status: 'blocked' }),
    task(11, 'Ticket triage', { apiError: 'stopped', apiErrorText: STOPPED }),
    task(12, 'Speed up the build'),
  ];

  it('is its own group, right after Needs You, with its header', () => {
    const { container, group } = renderList(tasks());
    const order = [...container.querySelectorAll('.group-label')].map((g) => g.textContent);
    expect(order).toEqual(['Needs You1', 'Stopped on an Error1', 'Idle1']);
    expect(within(group('errored')!).getByText('Ticket triage')).toBeTruthy();
    expect(container.querySelector('#task-group-errored')?.getAttribute('data-tone')).toBe('errored');
    expect(container.querySelector('#task-group-errored .group-pie')?.getAttribute('data-pie')).toBe('ring');
  });

  it('says which error under the title, with Claude Code’s own text as its tooltip', () => {
    const { rowOf } = renderList(tasks());
    const why = rowOf(11).querySelector('.task-why') as HTMLElement;
    expect(why.textContent).toBe('Response stopped arriving');
    expect(why.title).toBe(STOPPED);
    // Only on that row.
    expect(rowOf(12).querySelector('.task-why')).toBeNull();
  });

  it('names each kind briefly, and falls back to "API error"', () => {
    const labels: [Task['apiError'], string][] = [
      ['overloaded', 'Overloaded'],
      ['rate-limited', 'Rate limited'],
      ['signed-out', 'Not signed in'],
      ['other', 'API error'],
    ];
    for (const [kind, label] of labels) {
      const { rowOf } = renderList([task(11, 'Ticket triage', { apiError: kind, apiErrorText: 'API Error: …' })]);
      expect(rowOf(11).querySelector('.task-why')?.textContent).toBe(label);
      cleanup();
    }
  });

  it('Try Again sends "try again" to the session, and does not select the row', () => {
    const { rowOf, onSelect } = renderList(tasks());
    const button = within(rowOf(11)).getByRole('button', { name: 'Try Again' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(sent).toEqual([[11, 'try again']]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('has no Try Again without a live session', () => {
    const { rowOf } = renderList([task(12, 'Speed up the build', { apiError: 'overloaded', apiErrorText: 'API Error: Overloaded' })]);
    expect(rowOf(12).querySelector('.task-why')?.textContent).toBe('Overloaded');
    expect(within(rowOf(12)).queryByRole('button', { name: 'Try Again' })).toBeNull();
  });

  it('greys Try Again, with the reason, while a send would wait', () => {
    waits.value = true;
    const { rowOf } = renderList(tasks());
    const button = within(rowOf(11)).getByRole('button', { name: 'Try Again' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/waiting to send/);
    fireEvent.click(button);
    expect(sent).toEqual([]);
  });

  it('is not shown for a task running, waiting on you, or marked done, whatever is stored', () => {
    for (const status of ['running', 'blocked', 'done'] as const) {
      const { group, rowOf } = renderList([task(11, 'Ticket triage', { status, apiError: 'stopped', apiErrorText: STOPPED })]);
      expect(group('errored'), status).toBeNull();
      expect(rowOf(11).querySelector('.task-why'), status).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try Again' }), status).toBeNull();
      cleanup();
    }
  });
});
