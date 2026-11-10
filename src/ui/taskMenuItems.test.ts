/**
 * @vitest-environment jsdom
 *
 * The task's actions (#331): the one list both ⋯ menus draw -- its order,
 * its groups, and which items are hidden or greyed for which task.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import { taskMenuItems, type TaskActions, type TaskMenuFacts } from './taskMenuItems';
import type { OverflowItem } from './OverflowMenu';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 7, title: 'Fix login retry', projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: 'fix-login',
    worktreePath: '/w/fix-login', sessionId: 's7', ownsWorktree: true, createdBranch: true, kind: 'work',
    status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null, summary: null, reviewUrl: null, apiError: null, apiErrorText: null,
    ...over,
  };
}

const facts = (over: Partial<TaskMenuFacts> = {}): TaskMenuFacts => ({
  compactBlocker: null,
  live: true,
  remoteUrl: null,
  pendingReminders: 0,
  pr: null,
  shown: true,
  sendsWait: false,
  ...over,
});

const pr = (state: PrStatus['state']): PrStatus =>
  ({ number: 1, url: 'u', title: 'p', state, headRefName: 'b', baseRefName: 'main', headSha: '', mergedAt: null, review: null, checks: { kind: 'none' }, lines: [] }) as PrStatus;

function allActions(): Required<TaskActions> {
  return {
    remind: vi.fn(),
    guide: vi.fn(),
    move: vi.fn(),
    setDone: vi.fn(),
    followUp: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
  };
}

const ids = (items: OverflowItem[]) => items.map((i) => i.id);
/** The ids, with `/` where a new group starts. */
const shape = (items: OverflowItem[]) => items.map((i) => (i.group ? `/ ${i.id}` : i.id)).join(' ');
const byId = (items: OverflowItem[], id: string) => items.find((i) => i.id === id);

describe('taskMenuItems', () => {
  it('lists every action in the agreed order and groups', () => {
    const items = taskMenuItems(task(), facts(), allActions(), () => {});
    expect(shape(items)).toBe(
      'rename remind guide / compact remote-control copy-session / copy-path move / mark-done archive delete',
    );
    expect(byId(items, 'rename')?.aside).toBe('⇧F6');
    expect(byId(items, 'guide')?.aside).toBe('⇧⌘G');
    expect(byId(items, 'remote-control')?.aside).toBe('⇧⌘R');
    expect(byId(items, 'delete')?.tone).toBe('danger');
    expect(byId(items, 'move')?.label).toBe('Move to Main Checkout…');
  });

  it('keeps the old second lines as tooltips', () => {
    const items = taskMenuItems(task({ status: 'archived' }), facts(), allActions(), () => {});
    expect(byId(items, 'rename')?.title).toMatch(/branch and the folder stay/);
    expect(byId(items, 'follow-up')?.title).toMatch(/^New task from the base/);
    expect(byId(items, 'archive')?.title).toMatch(/^Out of the active list/);
    expect(byId(items, 'delete')?.title).toMatch(/^Worktree optional, conversation kept/);
    const done = taskMenuItems(task(), facts(), allActions());
    expect(byId(done, 'mark-done')?.title).toBe('Worktree and session kept');
  });

  it('offers no Review Guide and no Move for a chat', () => {
    const items = taskMenuItems(task({ kind: 'chat', worktreePath: '/r/app', branch: '' }), facts(), allActions(), () => {});
    expect(ids(items)).not.toContain('guide');
    expect(ids(items)).not.toContain('move');
    expect(shape(items)).toBe('rename remind / compact remote-control copy-session / copy-path / mark-done archive delete');
  });

  it('says Move to a Worktree… for a task in the main checkout', () => {
    const items = taskMenuItems(task({ worktreePath: '/r/app/' }), facts(), allActions());
    expect(byId(items, 'move')?.label).toBe('Move to a Worktree…');
  });

  it('greys Copy Session ID with no session, and Compact Now with its reason', () => {
    const items = taskMenuItems(task({ sessionId: null }), facts({ compactBlocker: 'No session is running for this task.' }), allActions());
    expect(byId(items, 'copy-session')).toMatchObject({ disabled: true, title: 'No session yet' });
    expect(byId(items, 'compact')).toMatchObject({ disabled: true, title: 'No session is running for this task.' });
  });

  it('offers Make Available Remotely only on a live session with Remote Control off', () => {
    expect(ids(taskMenuItems(task(), facts({ live: false }), allActions()))).not.toContain('remote-control');
    expect(ids(taskMenuItems(task(), facts({ remoteUrl: 'https://claude.ai/code/x' }), allActions()))).not.toContain('remote-control');
  });

  it('greys Make Available Remotely on a task waiting on you that is not on screen: it has no message box to leave it in', () => {
    const waiting = task({ status: 'blocked' });
    expect(byId(taskMenuItems(waiting, facts({ shown: false }), allActions()), 'remote-control')?.disabled).toBe(true);
    expect(byId(taskMenuItems(waiting, facts({ shown: true }), allActions()), 'remote-control')?.disabled).toBeUndefined();
    // Held in the outbox, it goes once the session is free, shown or not.
    expect(byId(taskMenuItems(waiting, facts({ shown: false, sendsWait: true }), allActions()), 'remote-control')?.disabled).toBeUndefined();
  });

  it('offers Follow-Up… only on a merged PR or an archived task, and Mark as Done / Not Done where they hold', () => {
    expect(ids(taskMenuItems(task(), facts({ pr: pr('open') }), allActions()))).not.toContain('follow-up');
    const merged = taskMenuItems(task(), facts({ pr: pr('merged') }), allActions());
    expect(ids(merged)).toContain('follow-up');
    expect(ids(merged)).not.toContain('mark-done');
    expect(ids(taskMenuItems(task({ status: 'archived' }), facts(), allActions()))).toContain('follow-up');
    const done = taskMenuItems(task({ status: 'done' }), facts(), allActions());
    expect(ids(done)).toContain('mark-not-done');
    expect(ids(done)).not.toContain('mark-done');
    expect(ids(taskMenuItems(task({ status: 'running' }), facts(), allActions()))).not.toContain('mark-done');
  });

  it('leaves out an action nobody handles, and starts the next group on the first item present', () => {
    const items = taskMenuItems(task(), facts({ live: false }), { archive: vi.fn() });
    expect(shape(items)).toBe('compact copy-session / copy-path / archive');
  });

  it('acts on the task it was given', () => {
    const actions = allActions();
    const t = task({ id: 42 });
    const items = taskMenuItems(t, facts(), actions);
    for (const id of ['remind', 'guide', 'move', 'follow-up', 'archive', 'delete']) byId(items, id)?.onSelect();
    byId(items, 'mark-done')!.onSelect();
    expect(actions.remind).toHaveBeenCalledWith(t);
    expect(actions.guide).toHaveBeenCalledWith(t);
    expect(actions.move).toHaveBeenCalledWith(t);
    expect(actions.archive).toHaveBeenCalledWith(t);
    expect(actions.delete).toHaveBeenCalledWith(t);
    expect(actions.setDone).toHaveBeenCalledWith(t, true);
  });
});
