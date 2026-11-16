// @vitest-environment jsdom
/**
 * Comments on removed lines (#402) in the Files pane's list: named as
 * removed lines, never resolved for being missing from the file, resolved
 * once sent when they are back (read against the task's base), and saying
 * so. Real SQLite; the files and the base are maps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTestDb } from '../db/testkit';
import type { Task } from '../types';

const harness = vi.hoisted(() => ({ db: null as unknown }));
const bases = vi.hoisted(() => new Map<string, string>());
const baseReads = vi.hoisted(() => [] as string[]);
// The measured base, as useMeasuredBase gives it: '' and settled until asked for.
const measured = vi.hoisted(() => ({ settled: true, asked: [] as boolean[] }));
vi.mock('./transcript/composerBridge', () => ({ sendWaitingComments: () => true }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));
vi.mock('./editor/removedBase', () => ({
  baseTextOf: async (_worktree: string, base: string, path: string) => {
    baseReads.push(`${base}:${path}`);
    return bases.get(path) ?? null;
  },
  useRemovedBase: (_task: unknown, needed: boolean) => {
    measured.asked.push(needed);
    return { base: needed ? 'main' : '', settled: needed && measured.settled };
  },
  useBaseText: () => undefined,
}));

const { createTask, resetDb } = await import('../db/index');
const { addComment, markCommentsSent } = await import('../db/comments');
const { FileTextContext } = await import('./editor/openFile');
const { default: CommentsSection } = await import('./CommentsSection');

let files: Map<string, string>;
let task: Task;

beforeEach(async () => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  (await import('./transcript/ciFailure')).__resetQueuedCi();
  resetDb();
  harness.db = createTestDb();
  // The change removed "two" from the base.
  bases.clear();
  bases.set('src/a.ts', 'one\ntwo\nthree\n');
  baseReads.length = 0;
  measured.settled = true;
  measured.asked.length = 0;
  files = new Map([['src/a.ts', 'one\nthree\n']]);
  task = await createTask({
    title: 't', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/wt/a',
    ownsWorktree: true, createdBranch: true, kind: 'work',
  });
});
afterEach(cleanup);

const addRemoved = (body: string) =>
  addComment({ taskId: task.id, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'two', body, side: 'old' });

function list(reloadKey = 0) {
  return (
    <FileTextContext.Provider value={async (p) => files.get(p) ?? null}>
      <CommentsSection task={task} onOpen={() => {}} reloadKey={reloadKey} />
    </FileTextContext.Provider>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('comments on removed lines in the list', () => {
  it('are named as removed lines, by the base', async () => {
    await addRemoved('Why drop two?');
    render(list());
    const waiting = await screen.findByRole('group', { name: 'Waiting, 1' });
    expect(waiting.querySelector('.tf-comment-where')!.textContent).toBe('a.ts removed 2');
    expect(waiting.querySelector('.tf-comment-open')!.getAttribute('title')).toBe('src/a.ts: removed line 2\n\nWhy drop two?');
  });

  it('a sent one stays open while its lines are missing from the file', async () => {
    const id = await addRemoved('Why drop two?');
    await markCommentsSent(task.id, [id]);
    render(list());
    await screen.findByRole('group', { name: 'Sent, 1' });
    await waitFor(() => expect(baseReads).toEqual(['main:src/a.ts']));
    await settle();
    expect(screen.queryByRole('group', { name: /Resolved/ })).toBeNull();
  });

  it('a sent one resolves itself when its lines are back, and says so', async () => {
    const id = await addRemoved('Why drop two?');
    await markCommentsSent(task.id, [id]);
    const view = render(list());
    await screen.findByRole('group', { name: 'Sent, 1' });
    files.set('src/a.ts', 'one\ntwo\nthree\n');
    view.rerender(list(1));
    const resolved = await screen.findByRole('group', { name: 'Resolved, 1' });
    fireEvent.click(within(resolved).getByRole('button', { name: /Resolved · 1/ }));
    await waitFor(() => expect(within(resolved).getByText(/its lines are back in the file/)).toBeTruthy());
    expect(within(resolved).getByRole('button', { name: 'Reopen the comment on src/a.ts: removed line 2' })).toBeTruthy();
  });

  it('a task with no comment on removed lines never reads a base', async () => {
    const id = await addComment({ taskId: task.id, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'three', body: 'New side.' });
    await markCommentsSent(task.id, [id]);
    render(list());
    await screen.findByRole('group', { name: 'Sent, 1' });
    await settle();
    expect(baseReads).toEqual([]);
    expect(measured.asked.every((n) => !n)).toBe(true);
  });

  it('not from a base read before the PR status settled', async () => {
    measured.settled = false;
    const id = await addRemoved('Why drop two?');
    await markCommentsSent(task.id, [id]);
    files.set('src/a.ts', 'one\ntwo\nthree\n');
    render(list());
    await screen.findByRole('group', { name: 'Sent, 1' });
    await waitFor(() => expect(baseReads).toEqual(['main:src/a.ts']));
    await settle();
    expect(screen.queryByRole('group', { name: /Resolved/ })).toBeNull();
  });

  it('a resolved one is read at the base only while the Resolved group is open', async () => {
    const id = await addRemoved('Why drop two?');
    await markCommentsSent(task.id, [id]);
    const { resolveComment } = await import('../db/comments');
    await resolveComment(task.id, id);
    render(list());
    const resolved = await screen.findByRole('group', { name: 'Resolved, 1' });
    await settle();
    expect(baseReads).toEqual([]);
    fireEvent.click(within(resolved).getByRole('button', { name: /Resolved · 1/ }));
    await waitFor(() => expect(baseReads).toEqual(['main:src/a.ts']));
    expect(within(resolved).getByText(/resolved by you/)).toBeTruthy();
  });
});
