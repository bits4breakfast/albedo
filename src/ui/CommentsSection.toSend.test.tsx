// @vitest-environment jsdom
/**
 * Files ▸ Comments after #404 and #409: To Send is the list above the
 * message box, item for item -- the CI failure, the code comments, the
 * transcript quotes -- with the same count, Edit and Remove on each (the CI
 * failure Remove), frozen while a send carries them; Jump on a quote goes to
 * the transcript. GitHub drafts are their own group, never in To Send, and
 * what was posted folds into Posted, no longer under Resolved. Real SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTestDb } from '../db/testkit';
import type { Task } from '../types';
import type { TranscriptComment } from './transcript/transcriptQuotes';

const harness = vi.hoisted(() => ({ db: null as unknown }));
const jumps = vi.hoisted(() => [] as Array<[number, unknown]>);
const jumpTaken = vi.hoisted(() => ({ value: true }));
vi.mock('./transcript/composerBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transcript/composerBridge')>()),
  sendWaitingComments: () => true,
  jumpToPassage: (id: number, target: unknown) => (jumps.push([id, target]), jumpTaken.value),
}));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));

const { createTask, resetDb } = await import('../db/index');
const { addComment, listComments, markDraftsPosted } = await import('../db/comments');
const { FileTextContext } = await import('./editor/openFile');
const { default: CommentsSection } = await import('./CommentsSection');
const drafts = await import('./transcript/drafts');
const ci = await import('./transcript/ciFailure');
const { setToSendFrozen, __resetToSendFrozen, toSendOf } = await import('./transcript/toSend');
const outbox = await import('./transcript/outbox');
const { WaitingComments } = await import('./transcript/WaitingComments');

let task: Task;

const quote = (id: string, over: Partial<TranscriptComment> = {}): TranscriptComment => ({
  id, messageId: 4, quote: 'It already runs.', code: false, comment: 'How do you know?', at: 100, offset: 0, addedAt: 1, ...over,
});

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
  ci.__resetQueuedCi();
  drafts.__resetDrafts();
  outbox.__resetOutbox();
  __resetToSendFrozen();
  jumps.length = 0;
  jumpTaken.value = true;
  resetDb();
  harness.db = createTestDb();
  task = await createTask({
    title: 't', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'b', worktreePath: '/wt/a',
    ownsWorktree: true, createdBranch: true, kind: 'work',
  });
});
afterEach(cleanup);

const add = (path: string, line: number, body: string, github: 'draft' | null = null) =>
  addComment({ taskId: task.id, path, lineStart: line, lineEnd: line, anchorText: `line ${line}`, body, github });

function queueCi() {
  ci.observeCiQueue(task.id, {
    number: 412, url: '', title: '', state: 'open', headRefName: 'b', baseRefName: 'main', headSha: 'abc1234def', mergedAt: null,
    review: null, checks: { kind: 'failing', failing: 1, total: 1 }, lines: [{ name: 'build', bucket: 'fail', url: null }],
  } as unknown as import('../gh/prStatus').PrStatus);
}

function pane(t: Task = task) {
  return render(
    <FileTextContext.Provider value={async () => null}>
      <CommentsSection task={t} onOpen={() => {}} />
    </FileTextContext.Provider>,
  );
}

describe('To Send in Files ▸ Comments (#404)', () => {
  it('lists what the message box lists, in its order and with its count: CI, code by file and line, quotes', async () => {
    queueCi();
    await add('src/report/export.ts', 12, 'Name this rowsForRange');
    await add('src/report/daily.ts', 42, 'use the local timezone');
    drafts.addComment(task.id, quote('late', { at: 300, comment: 'one query for the whole range' }));
    drafts.addComment(task.id, quote('early', { at: 100, comment: 'Why count here?' }));
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 5' });
    await waitFor(() => expect(group.querySelectorAll('.tf-comment')).toHaveLength(5));
    const rows = [...group.querySelectorAll('.tf-comment')].map((r) => r.querySelector('.tf-comment-body')?.textContent);
    expect(rows).toEqual(['build', 'use the local timezone', 'Name this rowsForRange', 'Why count here?', 'one query for the whole range']);
    expect(within(group).getByRole('button', { name: 'Send 5' })).toBeTruthy();
    // The message box's list says the same number.
    const code = await listComments(task.id);
    render(<WaitingComments taskId={task.id} frozen={false} list={toSendOf(ci.queuedCiOf(task.id), code, drafts.commentsOf(task.id))} />);
    const both = screen.getAllByRole('group', { name: 'To Send, 5' });
    expect(both.map((g) => g.className)).toEqual(['tf-comments-group', 'tx-waiting']);
  });

  it('a code comment: Edit saves new words in place, Remove deletes it', async () => {
    await add('src/a.ts', 3, 'Name it.');
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 1' });
    fireEvent.click(await within(group).findByRole('button', { name: 'Edit the comment on src/a.ts:3' }));
    const field = within(group).getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(field.value).toBe('Name it.');
    fireEvent.change(field, { target: { value: 'Name it rowsForRange.' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await waitFor(async () => expect((await listComments(task.id))[0]?.body).toBe('Name it rowsForRange.'));
    await waitFor(() => expect(within(group).getByText('Name it rowsForRange.')).toBeTruthy());
    fireEvent.click(within(group).getByRole('button', { name: 'Remove the comment on src/a.ts:3' }));
    await waitFor(async () => expect(await listComments(task.id)).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('group', { name: /To Send/ })).toBeNull());
  });

  it('a quote: Jump shows the transcript at the passage; Edit and Remove change the list', async () => {
    drafts.addComment(task.id, quote('q1'));
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 1' });
    fireEvent.click(within(group).getByRole('button', { name: /Transcript quote/ }));
    expect(jumps).toEqual([[task.id, { messageId: 4, quote: 'It already runs.', offset: 0 }]]);
    fireEvent.click(within(group).getByRole('button', { name: 'Edit the comment on “It already runs.”' }));
    const field = within(group).getByRole('textbox', { name: 'Edit comment' });
    fireEvent.change(field, { target: { value: '  Are you sure?  ' } });
    fireEvent.click(within(group).getByRole('button', { name: /Save/ }));
    expect(drafts.commentsOf(task.id)[0]?.comment).toBe('Are you sure?');
    fireEvent.click(within(group).getByRole('button', { name: 'Remove the comment on “It already runs.”' }));
    expect(drafts.commentsOf(task.id)).toEqual([]);
  });

  it('the CI failure: Remove only', async () => {
    queueCi();
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 1' });
    expect(within(group).queryByRole('button', { name: /^Edit/ })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Remove the CI failure' }));
    expect(ci.queuedCiOf(task.id)).toBeNull();
  });

  it('frozen while a send carries them: Edit and Remove disabled, back when it is done', async () => {
    await add('src/a.ts', 3, 'Name it.');
    drafts.addComment(task.id, quote('q1'));
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 2' });
    await within(group).findByRole('button', { name: 'Edit the comment on src/a.ts:3' });
    const acts = () => within(group).getAllByRole('button', { name: /^(Edit|Remove) / }) as HTMLButtonElement[];
    expect(acts()).toHaveLength(4);
    const send = within(group).getByRole('button', { name: 'Send 2' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    act(() => setToSendFrozen(task.id, true));
    expect(acts().every((b) => b.disabled)).toBe(true);
    // A send already carries them: a second would carry them again (#404 review).
    expect(send.disabled).toBe(true);
    act(() => setToSendFrozen(task.id + 1, false));
    expect(acts().every((b) => b.disabled)).toBe(true);
    act(() => setToSendFrozen(task.id, false));
    expect(acts().every((b) => !b.disabled)).toBe(true);
    expect(send.disabled).toBe(false);
  });

  it('an edit left open while a send carries the comment cannot be saved until it is done', async () => {
    await add('src/a.ts', 3, 'Name it.');
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 1' });
    fireEvent.click(await within(group).findByRole('button', { name: 'Edit the comment on src/a.ts:3' }));
    const field = within(group).getByRole('textbox', { name: 'Edit comment' });
    fireEvent.change(field, { target: { value: 'Too late.' } });
    act(() => setToSendFrozen(task.id, true));
    expect((within(group).getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await act(async () => {});
    expect((await listComments(task.id))[0]?.body).toBe('Name it.');
    // The words are kept; once the send is done they save.
    act(() => setToSendFrozen(task.id, false));
    fireEvent.keyDown(within(group).getByRole('textbox', { name: 'Edit comment' }), { key: 'Enter', metaKey: true });
    await waitFor(async () => expect((await listComments(task.id))[0]?.body).toBe('Too late.'));
  });

  it('Jump with no transcript to take it says so', async () => {
    jumpTaken.value = false;
    drafts.addComment(task.id, quote('q1'));
    pane();
    const group = await screen.findByRole('group', { name: 'To Send, 1' });
    fireEvent.click(within(group).getByRole('button', { name: /Transcript quote/ }));
    expect(screen.getByText('Open the task’s transcript to jump to the passage.')).toBeTruthy();
  });

  it('code comments a held message carries are Held, first, with nothing to change, and counted (#409)', async () => {
    const carriedId = await add('src/a.ts', 3, 'On its way.');
    await add('src/b.ts', 4, 'Still to send.');
    outbox.holdMessage(task.id, 'the held body', Date.now(), [carriedId]);
    pane();
    const held = await screen.findByRole('group', { name: 'Held, 1' });
    expect(within(held).getByText('On its way.')).toBeTruthy();
    expect(within(held).queryByRole('button', { name: /^(Edit|Remove) / })).toBeNull();
    const toSend = await screen.findByRole('group', { name: 'To Send, 1' });
    expect(within(toSend).queryByText('On its way.')).toBeNull();
    expect([...document.querySelectorAll('.tf-comments-group')].map((g) => g.getAttribute('aria-label'))).toEqual(['Held, 1', 'To Send, 1']);
    expect(document.querySelector('.tf-section-count')?.textContent).toBe('2');
    // The held message removed: back To Send.
    act(() => outbox.removeHeld(task.id, outbox.heldFor(task.id)[0]!.id));
    expect(await screen.findByRole('group', { name: 'To Send, 2' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: /^Held/ })).toBeNull();
  });
});

describe('GitHub Draft and Posted (#409)', () => {
  it('drafts are their own group with Submit Review…, never in To Send; posted ones fold into Posted, not Resolved', async () => {
    const review = { ...task, reviewUrl: 'https://github.com/acme/widgets/pull/12' } as Task;
    await add('src/a.ts', 3, 'For Claude.');
    await add('src/a.ts', 5, 'A draft.', 'draft');
    const posted = await add('src/a.ts', 7, 'Already posted.', 'draft');
    await markDraftsPosted(task.id, [posted]);
    pane(review);
    const toSend = await screen.findByRole('group', { name: 'To Send, 1' });
    expect(within(toSend).queryByText('A draft.')).toBeNull();
    const draftGroup = await screen.findByRole('group', { name: 'GitHub Draft, 1' });
    expect(within(draftGroup).getByText('GitHub Draft · 1')).toBeTruthy();
    expect(within(draftGroup).getByRole('button', { name: 'Submit Review…' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Resolved/ })).toBeNull();
    const postedGroup = screen.getByRole('group', { name: 'Posted, 1' });
    expect(within(postedGroup).queryByText('Already posted.')).toBeNull();
    fireEvent.click(within(postedGroup).getByRole('button', { name: /Posted · 1/ }));
    expect(within(postedGroup).getByText('Already posted.')).toBeTruthy();
    expect(within(postedGroup).queryByRole('button', { name: /Reopen/ })).toBeNull();
    // The groups in the mockup's order.
    const order = [...document.querySelectorAll('.tf-comments-group')].map((g) => g.getAttribute('aria-label'));
    expect(order).toEqual(['To Send, 1', 'GitHub Draft, 1', 'Posted, 1']);
  });
});
