/**
 * @vitest-environment jsdom
 *
 * Commenting on a passage of the transcript (#187), through the pane a
 * person uses: select text, the bar offers Comment (inside one message) and
 * Copy; the field under the passage keeps the comment with the task's draft;
 * ⌘' does what Comment does; a sent quote takes you back to its passage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message } from '../../types';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  usePtyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../BackgroundWork', () => ({ useBackgroundWork: () => [], backgroundShown: () => [] }));
vi.mock('./OverlayScrollbar', () => ({ default: () => null }));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: vi.fn(async () => rows),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  markCommentsSent: vi.fn(async () => {}),
  // No code comments wait in the queue here (#222).
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));

const { TranscriptPane } = await import('./TranscriptPane');
const { __resetDrafts, addComment, commentsOf } = await import('./drafts');
const { composeWithComments } = await import('./transcriptQuotes');
const { findPassage, offsetOf } = await import('./passages');

const T0 = new Date('2026-10-30T10:00:00Z').getTime();
function msg(id: number, role: Message['role'], body: string): Message {
  return { id, taskId: 1, sessionId: 's1', seq: id * 100, role, toolName: null, targetPath: null, body, rawJson: '{}', agentId: null, ts: T0 + id * 1000 };
}

const FIRST = 'Production already runs 8.2.35, from our own build.';
const SECOND = 'Keep not rebuilding the base images with --pull.';
let rows: Message[] = [];

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  __resetDrafts();
  rows = [msg(1, 'assistant', FIRST), msg(2, 'assistant', SECOND)];
});

const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  cleanup();
  document.getSelection()?.removeAllRanges();
  __resetDrafts();
});

const scroller = () => document.querySelector('.tx-scroll') as HTMLElement;
const rowEl = (id: number) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;

/** The first text node under `el` that holds `text`. */
function textNode(el: Element, text: string): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes(text)) return n as Text;
  throw new Error(`no text node with ${text}`);
}

/** Select from `a` in one row to `b` in another (or the same), as a drag would, and let go. */
function select(fromId: number, a: string, toId: number, b: string): void {
  const start = textNode(rowEl(fromId), a);
  const end = textNode(rowEl(toId), b);
  const range = document.createRange();
  range.setStart(start, start.data.indexOf(a));
  range.setEnd(end, end.data.indexOf(b) + b.length);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(scroller());
}

async function renderPane(): Promise<void> {
  render(<TranscriptPane taskId={1} sessionId="s1" />);
  await waitFor(() => expect(rowEl(2)).toBeTruthy());
}

describe('selecting text in the transcript', () => {
  it('inside one message: Comment and Copy', async () => {
    await renderPane();
    select(1, 'already runs', 1, '8.2.35');
    const bar = await screen.findByRole('toolbar', { name: 'Selected text' });
    expect(bar.textContent).toBe('CommentCopy');
  });

  it('across two messages: Copy only', async () => {
    await renderPane();
    select(1, 'our own build', 2, 'Keep not');
    const bar = await screen.findByRole('toolbar', { name: 'Selected text' });
    expect(bar.textContent).toBe('Copy');
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
  });

  it('nothing selected: no bar', async () => {
    await renderPane();
    select(1, 'already', 1, 'already');
    document.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(scroller());
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('Comment opens a field; Add (⌘↩) keeps it with the task, and nothing is sent', async () => {
    const term = await import('../Terminal');
    await renderPane();
    select(1, 'already runs', 1, '8.2.35');
    fireEvent.click(await screen.findByRole('button', { name: 'Comment' }));
    const field = screen.getByRole('textbox', { name: 'Comment on the selected passage' });
    expect(screen.getByRole('button', { name: /Add/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(field, { target: { value: 'How do you know?' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(commentsOf(1)).toEqual([
      expect.objectContaining({ messageId: 1, quote: 'already runs 8.2.35', comment: 'How do you know?', code: false, at: T0 + 1000 }),
    ]);
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
    expect(term.submitPty).not.toHaveBeenCalled();
    // The row says it has one waiting, and the message box lists it.
    await waitFor(() => expect(rowEl(1).dataset.comments).toBe('1'));
    expect(screen.getByRole('button', { name: /1 Comment/ })).toBeTruthy();
  });

  it("⌘' opens the field from the keyboard; Esc drops it", async () => {
    await renderPane();
    select(2, 'base images', 2, '--pull');
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    const field = screen.getByRole('textbox', { name: 'Comment on the selected passage' });
    fireEvent.change(field, { target: { value: 'until when?' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
    expect(commentsOf(1)).toEqual([]);
  });

  it("⌘' does nothing for a selection across messages", async () => {
    await renderPane();
    select(1, 'our own build', 2, 'Keep');
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    expect(screen.queryByRole('textbox', { name: 'Comment on the selected passage' })).toBeNull();
  });
});

describe('a sent quote takes you to its passage', () => {
  it('scrolls to the source row and flashes it', async () => {
    const body = composeWithComments(
      [{ id: 'a', messageId: 1, quote: '8.2.35', code: false, comment: 'Sure?', at: T0 + 1000, offset: 0, addedAt: 0 }],
      '',
    );
    rows = [...rows, msg(3, 'user', body)];
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: '8.2.35' }));
    await waitFor(() => expect(rowEl(1).classList.contains('tx-row-flash')).toBe(true));
    expect(scrolled.mock.contexts[0]).toBe(rowEl(1));
  });

  it('says so when the passage is not in the conversation any more', async () => {
    const body = composeWithComments(
      [{ id: 'a', messageId: 999, quote: 'gone', code: false, comment: 'Sure?', at: 0, offset: 0, addedAt: 0 }],
      '',
    );
    rows = [...rows, msg(3, 'user', body)];
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'gone' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/not in this conversation/);
  });

  it('marks the passage of a waiting comment, and a jump from the list reaches it', async () => {
    addComment(1, { id: 'w', messageId: 2, quote: 'base images', code: false, comment: 'why?', at: T0 + 2000, offset: 0, addedAt: 0 });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await renderPane();
    await waitFor(() => expect(rowEl(2).dataset.comments).toBe('1'));
    fireEvent.click(screen.getByRole('button', { name: /1 Comment/ }));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    });
    await waitFor(() => expect(rowEl(2).classList.contains('tx-row-flash')).toBe(true));
  });
});

describe('finding a passage again', () => {
  it('matches across elements and whitespace, and picks the occurrence nearest where it was', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>run it <b>again</b></p><pre><div>run it</div><div>  again</div></pre>';
    const range = findPassage(root, 'run it\nagain', 9)!;
    expect(range.startContainer.parentElement?.tagName).toBe('DIV');
    expect(offsetOf(root, range)).toBe(10);
    expect(findPassage(root, 'run it again', 0)?.startContainer.parentElement?.tagName).toBe('P');
    expect(findPassage(root, 'not there')).toBeNull();
  });
});
