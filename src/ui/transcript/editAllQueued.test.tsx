/**
 * @vitest-environment jsdom
 *
 * ↑ in an empty message box takes every held message into it, to edit as
 * one (#399): the box and the Queued band together, as the app shows them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { hasLivePty, ptyLiveSince, submitPty } from '../Terminal';
import { Composer } from './Composer';
import { QueuedStrip } from './QueuedStrip';
import { __resetDrafts, addComment, dropDraft, flushDrafts, getDraft } from './drafts';
import { __resetOutbox, heldFor, holdMessage, inBoxFor } from './outbox';
import { startOutboxRelease } from './outboxRelease';
import { __resetTurns, noteTaskSessions } from './turn';
import { recordQueueOperations, seedQueue } from '../../capture/queue';
import { __resetConnectivity } from '../../lib/connectivity';
import { markPastes, placeholderFor } from './pastedText';
import { __resetHeldInBox, putBackWhereNoDraft, putBackWhereNoDraftAtStartup } from './heldInBox';
import { composeWithComments, type TranscriptComment } from './transcriptQuotes';
import { markCommentsSent } from '../../db/comments';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => false),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => []),
    onCommentsChanged: vi.fn(() => () => {}),
    markCommentsSent: vi.fn(async () => {}),
  };
});

const T = Date.now() - 120_000;

/** The transcript's facts for the task's session, as the watcher records them. */
const fact = (taskId: number, op: 'prompt' | 'turn-end') =>
  recordQueueOperations([
    op === 'prompt'
      ? { op, sessionId: `s${taskId}`, text: 'p', ts: Date.now() - 1_000 }
      : { op, sessionId: `s${taskId}`, ts: Date.now() },
  ]);

/** A live session whose transcript says a turn is running. */
function turnRunning(taskId: number): void {
  vi.mocked(hasLivePty).mockReturnValue(true);
  vi.mocked(ptyLiveSince).mockReturnValue(Date.now() - 60_000);
  noteTaskSessions([{ id: taskId, sessionId: `s${taskId}` }]);
  fact(taskId, 'prompt');
}

const THREE = [
  'also check the timezone on the daily report',
  "and don't touch the migration, I'll do that myself",
  'when you are done run the export tests',
];

function holdThree(taskId = 1): void {
  THREE.forEach((t, i) => holdMessage(taskId, t, T + i));
}

/** The box and the band for a task, as the transcript pane stacks them. */
function Pane({ taskId }: { taskId: number }) {
  return (
    <>
      <QueuedStrip sessionId={`s${taskId}`} taskId={taskId} liveSince={null} />
      <Composer taskId={taskId} status="running" onSent={vi.fn()} />
    </>
  );
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const band = () => screen.getByRole('status', { name: 'Queued messages' });
const up = () => fireEvent.keyDown(box(), { key: 'ArrowUp' });
const esc = () => fireEvent.keyDown(box(), { key: 'Escape' });

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
  __resetConnectivity(async () => true);
  __resetOutbox();
  __resetTurns();
  __resetDrafts();
  __resetHeldInBox();
  seedQueue(['s1', 's2'], []);
  vi.mocked(submitPty).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetTurns();
  __resetOutbox();
  __resetDrafts();
  __resetConnectivity();
  seedQueue(['s1', 's2'], []);
  vi.mocked(hasLivePty).mockReturnValue(false);
  vi.mocked(ptyLiveSince).mockReturnValue(null);
});

describe('↑ in an empty box', () => {
  it('takes every held message into the box, oldest first, a blank line apart; the band says where they are', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    expect(band().textContent).toContain('Edit All');
    up();
    expect(box().value).toBe(THREE.join('\n\n'));
    expect(band().textContent).toBe('Queued 3being edited in the message box');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    const note = screen.getByRole('note');
    expect(note.textContent).toBe('Sends as one message, held like the others until the turn endsEsc Put Back as 3');
    // Still held, unchanged, only in the box.
    expect(heldFor(1).map((h) => h.text)).toEqual(THREE);
    expect(inBoxFor(1)).toHaveLength(3);
  });

  it('with text in the box, moves the caret as always and takes nothing', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    fireEvent.change(box(), { target: { value: 'typing' } });
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    box().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(box().value).toBe('typing');
    expect(inBoxFor(1)).toEqual([]);
  });

  it('with a modifier, takes nothing', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    fireEvent.keyDown(box(), { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(box(), { key: 'ArrowUp', metaKey: true });
    fireEvent.keyDown(box(), { key: 'ArrowUp', altKey: true });
    expect(box().value).toBe('');
    expect(inBoxFor(1)).toEqual([]);
  });

  it('with nothing held, does nothing', () => {
    render(<Pane taskId={1} />);
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    box().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(box().value).toBe('');
  });

  it('one held message comes in the same way', () => {
    turnRunning(1);
    holdMessage(1, 'only this one', T);
    render(<Pane taskId={1} />);
    // The hint is for two or more.
    expect(band().textContent).not.toContain('Edit All');
    up();
    expect(box().value).toBe('only this one');
    expect(screen.getByRole('note').textContent).toContain('Esc Put Back');
    expect(screen.getByRole('note').textContent).not.toContain('as 1');
  });

  it('a paste comes in as its token, and goes back in its marker', async () => {
    turnRunning(1);
    const log = 'one\ntwo\nthree\nfour';
    holdMessage(1, markPastes(`see ${placeholderFor(1, log)}`, new Map([[1, log]])), T);
    holdMessage(1, 'and fix it', T + 1);
    render(<Pane taskId={1} />);
    up();
    expect(box().value).toBe(`see ${placeholderFor(1, log)}\n\nand fix it`);
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    expect(heldFor(1)[0]!.text).toBe(markPastes(`see ${placeholderFor(1, log)}\n\nand fix it`, new Map([[1, log]])));
  });
});

describe('a quoted passage from the transcript (#187)', () => {
  it('comes in as its token, and goes back as the quote it was', async () => {
    turnRunning(1);
    const quote: TranscriptComment = {
      id: 'q', messageId: 9, quote: 'The export runs nightly.', code: false, comment: 'Since when?', at: T, offset: 0, addedAt: T,
    };
    const body = composeWithComments([quote], 'and check the timezone');
    holdMessage(1, body, T);
    holdMessage(1, 'then run the tests', T + 1);
    render(<Pane taskId={1} />);
    up();
    expect(box().value).toBe('[Quote #1: The export runs nightly.]\n\nSince when?\n\nand check the timezone\n\nthen run the tests');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    expect(heldFor(1)[0]!.text).toBe(`${body}\n\nthen run the tests`);
  });
});

describe('rewritten from scratch while a turn runs', () => {
  it('a task-list refresh does not put them back under the box: one message goes, once', async () => {
    const stop = startOutboxRelease();
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: '' } }); // ⌘A Delete
    // The refreshes a running turn brings, the startup one among them.
    act(() => {
      putBackWhereNoDraftAtStartup();
      putBackWhereNoDraft();
    });
    expect(inBoxFor(1)).toHaveLength(3);
    fireEvent.change(box(), { target: { value: 'one new message instead' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['one new message instead']));
    act(() => fact(1, 'turn-end'));
    await waitFor(() => expect(heldFor(1)).toHaveLength(0));
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'one new message instead']]);
    stop();
  });
});

describe('a command among them', () => {
  it('↑ takes only the run before it, so nothing comes back ahead of it', async () => {
    turnRunning(1);
    holdMessage(1, 'a', T);
    holdMessage(1, '/clear', T + 1);
    holdMessage(1, 'b', T + 2);
    render(<Pane taskId={1} />);
    up();
    expect(box().value).toBe('a');
    fireEvent.change(box(), { target: { value: 'a, edited' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['a, edited', '/clear', 'b']));
  });
});

describe('an emptied box with comments waiting', () => {
  const comment: TranscriptComment = {
    id: 'c1', messageId: 9, quote: 'The export runs nightly.', code: false, comment: 'Since when?', at: T, offset: 0, addedAt: T,
  };

  it('Send puts the held messages back, and the comments are held behind them, not in their place', async () => {
    turnRunning(1);
    holdThree();
    const before = structuredClone(heldFor(1));
    addComment(1, comment);
    render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: '  ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(heldFor(1)).toHaveLength(4));
    expect(heldFor(1).slice(0, 3)).toEqual(before);
    expect(heldFor(1)[3]!.text).toBe(composeWithComments([comment], ''));
    expect(inBoxFor(1)).toEqual([]);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('with nothing else waiting, Send on the emptied box puts them back', () => {
    turnRunning(1);
    holdThree();
    const before = structuredClone(heldFor(1));
    render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(heldFor(1)).toEqual(before);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('Esc', () => {
  it('while an IME is composing, is the IME\u2019s', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    fireEvent.keyDown(box(), { key: 'Escape', keyCode: 229 });
    expect(inBoxFor(1)).toHaveLength(3);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(inBoxFor(1)).toEqual([]);
  });

  it('puts them back exactly as they were and empties the box, changed or not', () => {
    turnRunning(1);
    holdMessage(1, THREE[0]!, T, [4]);
    holdMessage(1, THREE[1]!, T + 1);
    holdMessage(1, THREE[2]!, T + 2, [5]);
    const before = structuredClone(heldFor(1));
    render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: 'something else entirely' } });
    esc();
    expect(box().value).toBe('');
    expect(heldFor(1)).toEqual(before);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(3);
  });

  it('is taken: nothing behind the box sees it', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box().dispatchEvent(ev);
    window.removeEventListener('keydown', behind);
    expect(ev.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    expect(inBoxFor(1)).toEqual([]);
  });

  it('with nothing taken, is left alone', () => {
    render(<Pane taskId={1} />);
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    fireEvent.keyDown(box(), { key: 'Escape' });
    window.removeEventListener('keydown', behind);
    expect(behind).toHaveBeenCalledTimes(1);
  });
});

describe('sending', () => {
  it('replaces them with one message, held while the turn runs, sent once when it ends', async () => {
    const stop = startOutboxRelease();
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: 'check the timezone, leave the migration, run the export tests' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() =>
      expect(heldFor(1).map((h) => h.text)).toEqual(['check the timezone, leave the migration, run the export tests']),
    );
    expect(box().value).toBe('');
    expect(getDraft(1)).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
    expect(band().textContent).toContain('Queued 1');
    act(() => fact(1, 'turn-end'));
    await waitFor(() => expect(heldFor(1)).toHaveLength(0));
    act(() => fact(1, 'turn-end'));
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'check the timezone, leave the migration, run the export tests']]);
    stop();
  });

  it('carries the review comments they carried, marked sent once it is delivered', async () => {
    const stop = startOutboxRelease();
    turnRunning(1);
    holdMessage(1, 'first, with a comment', T, [11]);
    holdMessage(1, 'second, with another', T + 1, [12]);
    render(<Pane taskId={1} />);
    up();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    expect(heldFor(1)[0]!.commentIds).toEqual([11, 12]);
    act(() => fact(1, 'turn-end'));
    await waitFor(() => expect(markCommentsSent).toHaveBeenCalledWith(1, [11, 12]));
    stop();
  });

  it('goes at once through the release when nothing holds it', async () => {
    const stop = startOutboxRelease();
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    act(() => fact(1, 'turn-end'));
    // In the box: the turn's end sends nothing.
    await act(async () => {});
    expect(submitPty).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitPty).mock.calls[0]).toEqual([1, THREE.join('\n\n')]);
    await waitFor(() => expect(heldFor(1)).toHaveLength(0));
    stop();
  });
});

describe('while they are in the box', () => {
  it('a turn ending releases none of them', async () => {
    const stop = startOutboxRelease();
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    act(() => fact(1, 'turn-end'));
    await act(async () => {});
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(1).map((h) => h.text)).toEqual(THREE);
    // Put back, they go.
    esc();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitPty).mock.calls[0]).toEqual([1, THREE.join('\n\n')]);
    stop();
  });

  it('a task switch keeps the draft and keeps them out of the queue; back again, Esc still puts them back', () => {
    turnRunning(1);
    holdThree();
    // The pane is keyed by task in App.tsx: a switch remounts the box.
    const { rerender } = render(<Pane key="tx-1" taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: `${THREE.join('\n\n')} soon` } });
    rerender(<Pane key="tx-2" taskId={2} />);
    expect(box().value).toBe('');
    expect(inBoxFor(1)).toHaveLength(3);
    rerender(<Pane key="tx-1" taskId={1} />);
    expect(box().value).toBe(`${THREE.join('\n\n')} soon`);
    expect(screen.getByRole('note').textContent).toContain('Put Back as 3');
    esc();
    expect(heldFor(1).map((h) => h.text)).toEqual(THREE);
    expect(inBoxFor(1)).toEqual([]);
  });

  it('a restart keeps both the draft and the messages out of the queue', () => {
    turnRunning(1);
    holdThree();
    const { unmount } = render(<Pane taskId={1} />);
    up();
    flushDrafts();
    unmount();
    __resetOutbox(); // memory gone, storage kept
    __resetDrafts();
    render(<Pane taskId={1} />);
    expect(box().value).toBe(THREE.join('\n\n'));
    expect(inBoxFor(1)).toHaveLength(3);
    expect(band().textContent).toBe('Queued 3being edited in the message box');
  });

  it('a box that comes up empty puts them back: the draft never made it to disk', () => {
    turnRunning(1);
    holdThree();
    const { unmount } = render(<Pane taskId={1} />);
    up();
    unmount();
    dropDraft(1);
    render(<Pane taskId={1} />);
    expect(inBoxFor(1)).toEqual([]);
    expect(heldFor(1).map((h) => h.text)).toEqual(THREE);
  });

  it('leaving with the box emptied puts them back at once: the pane remounts, keyed by task as in App', () => {
    turnRunning(1);
    holdThree();
    const { rerender } = render(<Pane key="tx-1" taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: '' } });
    rerender(<Pane key="tx-2" taskId={2} />);
    expect(inBoxFor(1)).toEqual([]);
    expect(heldFor(1).map((h) => h.text)).toEqual(THREE);
  });

  it('leaving with the box emptied puts them back too when the same box stays mounted', () => {
    turnRunning(1);
    holdThree();
    const { rerender } = render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: '' } });
    rerender(<Pane taskId={2} />);
    expect(inBoxFor(1)).toEqual([]);
  });

  it('the draft is on disk the moment they are taken, not 400 ms later', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    __resetDrafts(); // memory gone at once: a crash
    expect(getDraft(1)?.text).toBe(THREE.join('\n\n'));
  });

  it('Send All Now says the ones in the box stay there', () => {
    turnRunning(1);
    holdMessage(1, 'a', T);
    holdMessage(1, 'b', T + 1);
    render(<Pane taskId={1} />);
    up();
    act(() => void holdMessage(1, 'c', T + 2));
    act(() => void holdMessage(1, 'd', T + 3));
    const all = screen.getByRole('button', { name: 'Send All Now' });
    expect(all.title).toContain('The ones being edited in the message box stay there.');
  });

  it('↑ again takes nothing more', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    fireEvent.change(box(), { target: { value: '' } });
    holdMessage(1, 'held meanwhile', T + 10);
    up();
    expect(box().value).toBe('');
    expect(inBoxFor(1)).toHaveLength(3);
  });

  it('a message held meanwhile keeps its row, and waits behind them', () => {
    turnRunning(1);
    holdThree();
    render(<Pane taskId={1} />);
    up();
    act(() => void holdMessage(1, 'held meanwhile', T + 10));
    expect(screen.getByText('held meanwhile')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(band().textContent).toContain('sent after the message being edited');
  });
});
