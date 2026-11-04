// @vitest-environment jsdom
/**
 * The Files pane's Comments list (#222): grouped by state so ✓ only means
 * Resolve, a sent comment resolving itself once its lines change, the reason
 * a resolved one gives, and Reopen. Real SQLite; the files are a map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTestDb } from '../db/testkit';
import type { Task } from '../types';

const harness = vi.hoisted(() => ({ db: null as unknown }));
const sendAsked = vi.hoisted(() => [] as number[]);
vi.mock('./transcript/composerBridge', () => ({ sendWaitingComments: (id: number) => (sendAsked.push(id), true) }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));

const { createTask, resetDb } = await import('../db/index');
const { addComment, listComments, markCommentsSent } = await import('../db/comments');
const { FileTextContext } = await import('./editor/openFile');
const { default: CommentsSection } = await import('./CommentsSection');

let files: Map<string, string>;
let task: Task;

beforeEach(async () => {
  resetDb();
  harness.db = createTestDb();
  files = new Map([['src/a.ts', 'one\ntwo\nthree\n']]);
  task = await createTask({
    title: 't', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/wt/a',
    ownsWorktree: true, createdBranch: true, kind: 'work',
  });
});
afterEach(cleanup);

const add = (anchorText: string, body: string, lineStart = 2) =>
  addComment({ taskId: task.id, path: 'src/a.ts', lineStart, lineEnd: lineStart, anchorText, body });

function list(reloadKey = 0) {
  return (
    <FileTextContext.Provider value={async (p) => files.get(p) ?? null}>
      <CommentsSection task={task} onOpen={() => {}} reloadKey={reloadKey} />
    </FileTextContext.Provider>
  );
}

describe('the Comments list', () => {
  it('groups Waiting and ↗ Sent; only a sent one has the ✓, which is Resolve', async () => {
    await add('one', 'first, unsent', 1);
    const sent = await add('two', 'second, sent');
    await markCommentsSent(task.id, [sent]);
    render(list());
    const waiting = await screen.findByRole('group', { name: 'Waiting, 1' });
    expect(within(waiting).getByText('first, unsent')).toBeTruthy();
    expect(within(waiting).queryByRole('button', { name: /Resolve/ })).toBeNull();
    const sentGroup = screen.getByRole('group', { name: 'Sent, 1' });
    expect(within(sentGroup).getByRole('button', { name: 'Resolve the comment on src/a.ts:2' }).textContent).toBe('✓');
  });

  it('Waiting has Send (#258): it sends the waiting comments, as ⇧⌘S does; Sent has none', async () => {
    sendAsked.length = 0;
    await add('one', 'first, unsent', 1);
    const sent = await add('two', 'second, sent');
    await markCommentsSent(task.id, [sent]);
    render(list());
    const waiting = await screen.findByRole('group', { name: 'Waiting, 1' });
    const send = within(waiting).getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+S');
    fireEvent.click(send);
    expect(sendAsked).toEqual([task.id]);
    expect(within(screen.getByRole('group', { name: 'Sent, 1' })).queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('the place keeps its line: the name and :line are separate, so only the name ellipsizes (#258)', async () => {
    await add('two', 'a body', 2);
    render(list());
    const waiting = await screen.findByRole('group', { name: 'Waiting, 1' });
    const where = waiting.querySelector('.tf-comment-where')!;
    expect(where.querySelector('.tf-name')?.textContent).toBe('a.ts');
    expect(where.querySelector('.tf-comment-line')?.textContent).toBe(':2');
    expect(where.textContent).toBe('a.ts:2');
  });

  it('a sent comment resolves itself once its lines change, says why, and reopens as waiting', async () => {
    const id = await add('two', 'rename this');
    await markCommentsSent(task.id, [id]);
    const view = render(list());
    await screen.findByRole('group', { name: 'Sent, 1' });
    // Claude changes the line; the Files pane reloads on the next capture update.
    files.set('src/a.ts', 'one\nTWO\nthree\n');
    view.rerender(list(1));
    const resolved = await screen.findByRole('group', { name: 'Resolved, 1' });
    expect(screen.queryByRole('group', { name: 'Sent, 1' })).toBeNull();
    fireEvent.click(within(resolved).getByRole('button', { name: /Resolved · 1/ }));
    await waitFor(() => expect(within(resolved).getByText(/its lines changed after it was sent/)).toBeTruthy());
    fireEvent.click(within(resolved).getByRole('button', { name: 'Reopen the comment on src/a.ts:2' }));
    expect(await screen.findByRole('group', { name: 'Waiting, 1' })).toBeTruthy();
    expect((await listComments(task.id))[0]).toMatchObject({ id, sentAt: null, resolvedAt: null });
  });

  it('an unsent comment whose lines changed stays open', async () => {
    await add('two', 'not sent yet');
    files.set('src/a.ts', 'one\nTWO\n');
    render(list());
    await screen.findByRole('group', { name: 'Waiting, 1' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('group', { name: /Resolved/ })).toBeNull();
  });
});
