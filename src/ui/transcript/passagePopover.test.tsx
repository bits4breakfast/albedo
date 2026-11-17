/**
 * @vitest-environment jsdom
 *
 * The comment on a marked passage (#434), through the pane a person uses: a
 * click on the mark's text shows its comments under it, with the To Send
 * list's Edit and Remove. jsdom has no layout, so the engine's caret at a
 * point is stood in for: each click names the text it lands on.
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
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));

const { TranscriptPane } = await import('./TranscriptPane');
const { __resetDrafts, addComment, commentsOf, takeComments } = await import('./drafts');
const { __resetOpenEdits, __resetToSendFrozen, editsOf, openEdit, setToSendFrozen } = await import('./toSend');
const { charAt, marksAt } = await import('./markHit');
type TranscriptComment = import('./transcriptQuotes').TranscriptComment;

const T0 = new Date('2026-10-30T10:00:00Z').getTime();
function msg(id: number, role: Message['role'], body: string): Message {
  return { id, taskId: 1, sessionId: 's1', seq: id * 100, role, toolName: null, targetPath: null, body, rawJson: '{}', agentId: null, ts: T0 + id * 1000 };
}

const FIRST = 'The parser reads every line twice before it gives up.';
const SECOND = 'Nothing else in the queue depends on the cache.';
let rows: Message[] = [];

function comment(id: string, quote: string, words: string, addedAt: number, messageId = 1): TranscriptComment {
  return { id, messageId, quote, code: false, comment: words, at: T0 + messageId * 1000, offset: 0, addedAt };
}

/** Where the stand-in caret lands: the next click's text. */
let caret: { offsetNode: Node; offset: number } | null = null;
const doc = document as unknown as { caretPositionFromPoint?: (x: number, y: number) => unknown };

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
  __resetOpenEdits();
  __resetToSendFrozen();
  rows = [msg(1, 'assistant', FIRST), msg(2, 'assistant', SECOND)];
  caret = null;
  doc.caretPositionFromPoint = () => caret;
});

afterEach(() => {
  cleanup();
  delete doc.caretPositionFromPoint;
  document.getSelection()?.removeAllRanges();
  __resetDrafts();
  __resetOpenEdits();
  __resetToSendFrozen();
});

const rowEl = (id: number) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
const scroller = () => document.querySelector('.tx-scroll') as HTMLElement;

function textNode(el: Element, text: string): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes(text)) return n as Text;
  throw new Error(`no text node with ${text}`);
}

/** A plain click on the first character of `word` in a row. */
function clickOn(id: number, word: string, init: MouseEventInit = {}): void {
  const node = textNode(rowEl(id), word);
  caret = { offsetNode: node, offset: node.data.indexOf(word) };
  fireEvent.click(node.parentElement!, { button: 0, detail: 1, clientX: 10, clientY: 10, ...init });
}

async function renderPane(): Promise<void> {
  render(<TranscriptPane taskId={1} sessionId="s1" />);
  await waitFor(() => expect(rowEl(2)).toBeTruthy());
}

async function withMark(...cs: TranscriptComment[]): Promise<void> {
  for (const c of cs) addComment(1, c);
  await renderPane();
  await waitFor(() => expect(rowEl(cs[0]!.messageId).dataset.comments).toBe(String(cs.filter((c) => c.messageId === cs[0]!.messageId).length)));
}

const popover = () => screen.queryByRole('dialog', { name: /Your comment/ });

describe('a click on a marked passage', () => {
  it('shows its comment under it, To Send, with Edit and Remove', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    const pop = await screen.findByRole('dialog', { name: 'Your comment' });
    expect(pop.textContent).toContain('Is twice on purpose?');
    expect(pop.textContent).toContain('To Send · goes with your next message');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    // It takes focus, so Esc reaches it.
    expect(document.activeElement).toBe(pop);
  });

  it('does nothing on text outside the mark', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'parser');
    clickOn(2, 'queue');
    expect(popover()).toBeNull();
  });

  it('a drag that starts on the mark still selects, and opens nothing', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    const node = textNode(rowEl(1), 'every');
    const range = document.createRange();
    range.setStart(node, node.data.indexOf('every'));
    range.setEnd(node, node.data.indexOf('gives'));
    document.getSelection()!.addRange(range);
    clickOn(1, 'line');
    expect(popover()).toBeNull();
    expect(document.getSelection()!.toString()).toBe('every line twice before it ');
  });

  it('a double click picks a word: the popover the first click opened closes', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    expect(popover()).toBeTruthy();
    clickOn(1, 'line', { detail: 2 });
    expect(popover()).toBeNull();
  });

  it('a modified click is not a click on the mark', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line', { metaKey: true });
    clickOn(1, 'line', { shiftKey: true });
    expect(popover()).toBeNull();
  });

  it('lists every comment on the passage, overlapping ones too, oldest first', async () => {
    await withMark(
      comment('late', 'line twice', 'Second thought.', 20),
      comment('early', 'every line', 'First thought.', 10),
      comment('other', 'gives up', 'Not here.', 5),
    );
    clickOn(1, 'line');
    const pop = await screen.findByRole('dialog', { name: 'Your comments' });
    expect(pop.textContent).toContain('Your 2 comments');
    const items = [...pop.querySelectorAll('.tx-cmt-pop-text')].map((e) => e.textContent);
    expect(items).toEqual(['First thought.', 'Second thought.']);
  });

  it('Esc closes it and goes no further, marked handled', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    try {
      clickOn(1, 'line');
      const pop = await screen.findByRole('dialog', { name: 'Your comment' });
      const notCancelled = fireEvent.keyDown(pop, { key: 'Escape' });
      expect(notCancelled).toBe(false);
      expect(popover()).toBeNull();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });

  it('a press anywhere else closes it; a press inside does not', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Edit' }));
    expect(popover()).toBeTruthy();
    fireEvent.mouseDown(rowEl(2));
    expect(popover()).toBeNull();
  });

  it('the pointer and a tooltip say a mark can be clicked', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    const node = textNode(rowEl(1), 'line');
    caret = { offsetNode: node, offset: node.data.indexOf('line') };
    fireEvent.mouseMove(node.parentElement!, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(scroller().hasAttribute('data-on-mark')).toBe(true));
    expect(scroller().getAttribute('title')).toBe('Your comment — click to see it');
    caret = { offsetNode: node, offset: node.data.indexOf('parser') };
    fireEvent.mouseMove(node.parentElement!, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(scroller().hasAttribute('data-on-mark')).toBe(false));
    expect(scroller().hasAttribute('title')).toBe(false);
  });
});

describe('editing from the popover: the To Send list’s editor and rules', () => {
  it('Edit opens the field with the words; ⌘↩ saves them', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(field.value).toBe('Is twice on purpose?');
    fireEvent.change(field, { target: { value: 'Is reading twice on purpose?' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(commentsOf(1).map((c) => c.comment)).toEqual(['Is reading twice on purpose?']);
    expect(screen.queryByRole('textbox', { name: 'Edit comment' })).toBeNull();
    expect(popover()!.textContent).toContain('Is reading twice on purpose?');
    expect(editsOf(1)).toEqual([]);
  });

  it('Esc in the field cancels the edit only; the popover stays, and takes focus back', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit comment' });
    fireEvent.change(field, { target: { value: 'never mind' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit comment' })).toBeNull();
    expect(commentsOf(1).map((c) => c.comment)).toEqual(['Is twice on purpose?']);
    const pop = popover();
    expect(pop).toBeTruthy();
    expect(document.activeElement).toBe(pop);
  });

  it('closing the popover mid-edit keeps what was typed, and opening it again brings it back', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment' }), { target: { value: 'half typed' } });
    fireEvent.mouseDown(rowEl(2));
    expect(popover()).toBeNull();
    clickOn(1, 'line');
    expect((screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement).value).toBe('half typed');
  });

  it('Remove takes it out of To Send, closes its edits in every view, and closes the popover', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    act(() => openEdit({ taskId: 1, view: 'box', kind: 'quote', id: 'a', initial: 'Is twice on purpose?' }));
    clickOn(1, 'line');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(commentsOf(1)).toEqual([]);
    expect(editsOf(1)).toEqual([]);
    expect(popover()).toBeNull();
    await waitFor(() => expect(rowEl(1).dataset.comments).toBeUndefined());
  });

  it('Remove of one of two keeps the popover open on the other', async () => {
    await withMark(comment('b', 'line twice', 'Second.', 20), comment('a', 'every line', 'First.', 10));
    clickOn(1, 'line');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0]!);
    expect(commentsOf(1).map((c) => c.id)).toEqual(['b']);
    const pop = popover()!;
    expect(pop.textContent).toContain('Second.');
    expect(pop.textContent).not.toContain('First.');
    expect(document.activeElement).toBe(pop);
  });

  it('while a send carries the list, Edit and Remove wait', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    act(() => setToSendFrozen(1, true));
    clickOn(1, 'line');
    expect(screen.getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(true);
    act(() => setToSendFrozen(1, false));
    expect(screen.getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(false);
  });

  it('once the comment is sent, the popover goes with it', async () => {
    await withMark(comment('a', 'every line twice', 'Is twice on purpose?', 1));
    clickOn(1, 'line');
    expect(popover()).toBeTruthy();
    act(() => takeComments(1, ['a']));
    await waitFor(() => expect(popover()).toBeNull());
    // Given back (a send that did not go): marked again, but nothing pops up unasked.
    act(() => addComment(1, comment('a', 'every line twice', 'Is twice on purpose?', 1)));
    await waitFor(() => expect(rowEl(1).dataset.comments).toBe('1'));
    expect(popover()).toBeNull();
  });
});

describe('hit-testing a mark', () => {
  const getRect = Range.prototype.getBoundingClientRect;
  afterEach(() => {
    if (getRect) Range.prototype.getBoundingClientRect = getRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  /** Each character 10px wide on one 20px line, from x = 0. */
  function laidOut(): void {
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const left = this.startOffset * 10;
      const right = this.endOffset * 10;
      return { left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  }

  it('finds the character whose box holds the point, either side of the caret', () => {
    laidOut();
    const p = document.createElement('p');
    p.textContent = 'abcdef';
    document.body.append(p);
    const node = p.firstChild as Text;
    // The caret sits before "d" (offset 3); the point is on "c".
    expect(charAt(25, 10, () => ({ node, offset: 3 }))?.offset).toBe(2);
    expect(charAt(35, 10, () => ({ node, offset: 3 }))?.offset).toBe(3);
    p.remove();
  });

  it('a point past the line’s end is on no mark, though the caret is at the mark’s end', () => {
    laidOut();
    const p = document.createElement('p');
    p.textContent = 'abcdef';
    document.body.append(p);
    const node = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 3);
    range.setEnd(node, 6);
    const marks = [{ range }];
    expect(marksAt(marks, 300, 10, () => ({ node, offset: 6 })).hits).toEqual([]);
    expect(marksAt(marks, 55, 10, () => ({ node, offset: 6 })).hits).toEqual(marks);
    // The character just before the mark is not in it.
    expect(marksAt(marks, 25, 10, () => ({ node, offset: 3 })).hits).toEqual([]);
    p.remove();
  });
});
