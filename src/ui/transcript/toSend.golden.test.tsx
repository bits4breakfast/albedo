/**
 * @vitest-environment jsdom
 *
 * What goes to Claude with To Send (#404) is exactly what went before it:
 * the views now read one list, the message is still made by `send` and
 * `sendComments` from the same stores. These bodies were recorded on `main`
 * before #404 and must not change: a CI failure, two code comments in two
 * files (stored out of id order), two quotes added out of transcript order,
 * and the box's text -- and which comments are marked sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { hasLivePty, ptyLiveSince, startPty, submitPty } from '../Terminal';
import { Composer } from './Composer';
import { __resetDrafts, addComment, commentsOf } from './drafts';
import type { TranscriptComment } from './transcriptQuotes';
import { __resetOutbox, heldFor } from './outbox';
import { startOutboxRelease } from './outboxRelease';
import { __resetTurns, noteTaskSessions } from './turn';
import { recordQueueOperations, seedQueue } from '../../capture/queue';
import { __resetConnectivity } from '../../lib/connectivity';

vi.mock('../Terminal', () => {
  const listeners = new Set<(taskId: number, live: boolean) => void>();
  return {
    submitPty: vi.fn(async () => true),
    startPty: vi.fn(() => false),
    hasLivePty: vi.fn(() => true),
    ptyLiveSince: vi.fn(() => null),
    canResume: vi.fn(() => false),
    onPtyPresenceChange: vi.fn((cb: (taskId: number, live: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    __emitPresence: (taskId: number, live: boolean) => {
      for (const cb of [...listeners]) cb(taskId, live);
    },
  };
});

const codeRows = vi.hoisted(() => ({
  rows: [] as import('../../db/comments').ReviewComment[],
  listeners: new Set<(taskId: number) => void>(),
}));
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => codeRows.rows),
    onCommentsChanged: vi.fn((cb: (taskId: number) => void) => {
      codeRows.listeners.add(cb);
      return () => codeRows.listeners.delete(cb);
    }),
    markCommentsSent: vi.fn(async () => {}),
    editComment: vi.fn(async () => {}),
  };
});
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/me') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }));

const { editComment, listComments, markCommentsSent } = await import('../../db/comments');
const { __resetOpenEdits } = await import('./toSend');
const term = (await import('../Terminal')) as unknown as { __emitPresence: (taskId: number, live: boolean) => void };

/** The code comments are read once on mount; let that read land. */
async function codeLoaded() {
  await waitFor(() => expect(listComments).toHaveBeenCalled());
  await act(async () => {});
}

function code(id: number, path: string, line: number, body: string): import('../../db/comments').ReviewComment {
  return {
    id, taskId: 1, path, lineStart: line, lineEnd: line, anchorText: `line ${line} of ${path}`, body,
    createdAt: id, updatedAt: id, sentAt: null, resolvedAt: null, github: null, replyTo: null,
  };
}

const later: TranscriptComment = {
  id: 'q2', messageId: 9, quote: 'runs a query per day', code: false, comment: 'one query for the whole range', at: 200, offset: 0, addedAt: 1,
};
const earlier: TranscriptComment = {
  id: 'q1', messageId: 4, quote: 'const n = rows.length', code: true, lang: 'ts', comment: 'Why count here?', at: 100, offset: 3, addedAt: 2,
} as TranscriptComment;

const SHA = 'abc1234def5678900000000000000000000000aa';

async function queueFailure() {
  const { observeCi, resetCiNoticesForTests } = await import('../ciNotice');
  const { parsePrView } = await import('../../gh/prStatus');
  const at = (runs: object[]) =>
    parsePrView(JSON.stringify({ number: 412, state: 'OPEN', headRefName: 'b', headRefOid: SHA, statusCheckRollup: runs }))!;
  const run = (name: string, conclusion: string | null) => ({
    __typename: 'CheckRun', name, detailsUrl: `https://ci.example.com/${name}`, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion,
  });
  resetCiNoticesForTests();
  act(() => {
    observeCi({ id: 1, title: 't' }, at([run('build', null)]), 1);
    observeCi({ id: 1, title: 't' }, at([run('build', 'FAILURE')]), 1);
  });
}

const CI = 'CI failed on PR #412 (abc1234):\n- build: failed — https://ci.example.com/build';
const CODE = [
  'I left some review comments on your changes. Please address each one:',
  '',
  '1. src/report/daily.ts:42',
  '```',
  'line 42 of src/report/daily.ts',
  '```',
  'use the local timezone',
  '',
  '2. src/report/export.ts:12',
  '```',
  'line 12 of src/report/export.ts',
  '```',
  'Name this rowsForRange',
].join('\n');
const QUOTES = [
  '<transcript-quote id="1" message="4">',
  '> ```ts',
  '> const n = rows.length',
  '> ```',
  '</transcript-quote id="1">',
  '',
  'Why count here?',
  '',
  '<transcript-quote id="2" message="9">',
  '> runs a query per day',
  '</transcript-quote id="2">',
  '',
  'one query for the whole range',
].join('\n');

describe('To Send leaves what is sent unchanged (#404)', () => {
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
    const { __resetQueuedCi } = await import('./ciFailure');
    const { __setAttentionBackend } = await import('../attention');
    __setAttentionBackend(() => {}, true, () => {});
    __resetQueuedCi();
    __resetDrafts();
    __resetConnectivity(async () => true);
    __resetOutbox();
    __resetTurns();
    seedQueue(['s1'], []);
    vi.mocked(hasLivePty).mockReturnValue(true);
    vi.mocked(submitPty).mockResolvedValue(true);
    // As listComments orders them: by file, then line.
    codeRows.rows = [code(9, 'src/report/daily.ts', 42, 'use the local timezone'), code(3, 'src/report/export.ts', 12, 'Name this rowsForRange')];
    addComment(1, later);
    addComment(1, earlier);
  });
  afterEach(async () => {
    const { __setAttentionBackend } = await import('../attention');
    __setAttentionBackend(null);
    cleanup();
    vi.clearAllMocks();
    __resetDrafts();
    __resetOutbox();
    __resetTurns();
    __resetConnectivity();
    codeRows.rows = [];
  });

  it('Send with text: CI, the code comments, the quotes in transcript order, then the text', async () => {
    render(<Composer taskId={1} onSent={vi.fn()} />);
    await queueFailure();
    await codeLoaded();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Please fix these.' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitPty).mock.calls[0]).toEqual([1, `${CI}\n\n${CODE}\n\n${QUOTES}\n\nPlease fix these.`]);
    expect(markCommentsSent).toHaveBeenCalledWith(1, [9, 3]);
    expect(commentsOf(1)).toEqual([]);
    // Delivered, and on their way until the sent mark is read back: never
    // To Send again meanwhile (the store here never says sent).
    await act(async () => {});
    expect(document.querySelector('.tx-waiting')).toBeNull();
  });

  it('Send alone (⇧⌘S, the guide, Files): the same, with no text, and the draft stays', async () => {
    const { sendWaitingComments } = await import('./composerBridge');
    render(<Composer taskId={1} onSent={vi.fn()} />);
    await queueFailure();
    await codeLoaded();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half a thought' } });
    expect(sendWaitingComments(1)).toBe(true);
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitPty).mock.calls[0]).toEqual([1, `${CI}\n\n${CODE}\n\n${QUOTES}`]);
    expect(markCommentsSent).toHaveBeenCalledWith(1, [9, 3]);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('half a thought');
  });
});

/*
   While a send of the box is under way it already carries To Send. Send N
   (Files, the guide) and ⇧⌘S must not make a second message with the same
   comments (#404 review): Claude would read them twice. Each path: the body
   that goes is the one recorded above, once, and the comments are marked
   sent once.
*/
describe('To Send goes once while a send carries it (#404)', () => {
  const ALL = `${CI}\n\n${CODE}\n\n${QUOTES}\n\nPlease fix these.`;
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
    const { __resetQueuedCi } = await import('./ciFailure');
    const { __setAttentionBackend } = await import('../attention');
    __setAttentionBackend(() => {}, true, () => {});
    __resetQueuedCi();
    __resetDrafts();
    __resetConnectivity(async () => true);
    __resetOutbox();
    __resetTurns();
    seedQueue(['s1'], []);
    vi.mocked(hasLivePty).mockReturnValue(true);
    vi.mocked(submitPty).mockResolvedValue(true);
    codeRows.rows = [code(9, 'src/report/daily.ts', 42, 'use the local timezone'), code(3, 'src/report/export.ts', 12, 'Name this rowsForRange')];
    addComment(1, later);
    addComment(1, earlier);
  });
  afterEach(async () => {
    const { __setAttentionBackend } = await import('../attention');
    __setAttentionBackend(null);
    cleanup();
    vi.clearAllMocks();
    __resetDrafts();
    __resetOutbox();
    __resetTurns();
    __resetConnectivity();
    seedQueue(['s1'], []);
    vi.mocked(ptyLiveSince).mockReturnValue(null);
    codeRows.rows = [];
  });

  const typeAndSend = () => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Please fix these.' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  };

  it('held at a permission prompt: Send N / ⇧⌘S is refused; on the answer the one message goes, its comments marked once', async () => {
    const { sendWaitingComments } = await import('./composerBridge');
    const { rerender } = render(<Composer taskId={1} status="blocked" onSent={vi.fn()} />);
    await queueFailure();
    await codeLoaded();
    typeAndSend();
    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());
    const { onShowTranscriptRequest } = await import('./composerBridge');
    const shown: number[] = [];
    const off = onShowTranscriptRequest((id) => shown.push(id));
    let answer = true;
    act(() => {
      answer = sendWaitingComments(1);
    });
    off();
    expect(answer).toBe(false);
    // Not silent: the transcript shows, and the box says why (#404 review).
    expect(shown).toEqual([1]);
    expect(screen.getByText('Your message is already on its way with To Send')).toBeTruthy();
    expect(heldFor(1)).toEqual([]);
    expect(submitPty).not.toHaveBeenCalled();
    await act(async () => {
      rerender(<Composer taskId={1} status="idle" onSent={vi.fn()} />);
    });
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, ALL]]);
    expect(heldFor(1)).toEqual([]);
    expect(vi.mocked(markCommentsSent).mock.calls).toEqual([[1, [9, 3]]]);
  });

  it('waiting for the session to start: refused too; when it is up, the one message goes', async () => {
    const { sendWaitingComments } = await import('./composerBridge');
    vi.mocked(hasLivePty).mockReturnValue(false);
    vi.mocked(submitPty).mockResolvedValueOnce(false);
    vi.mocked(startPty).mockReturnValue(true);
    render(<Composer taskId={1} onSent={vi.fn()} />);
    await queueFailure();
    await codeLoaded();
    typeAndSend();
    await waitFor(() => expect(screen.getByText(/Starting the session/)).toBeTruthy());
    expect(sendWaitingComments(1)).toBe(false);
    expect(heldFor(1)).toEqual([]);
    vi.mocked(hasLivePty).mockReturnValue(true);
    await act(async () => term.__emitPresence(1, true));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    await act(async () => {});
    // The failed first write, then the one that went: the same body.
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, ALL], [1, ALL]]);
    expect(heldFor(1)).toEqual([]);
    expect(vi.mocked(markCommentsSent).mock.calls).toEqual([[1, [9, 3]]]);
  });

  it('held for a running turn: the outbox holds the one body; nothing is left To Send; the release sends it once', async () => {
    const { sendWaitingComments } = await import('./composerBridge');
    const stop = startOutboxRelease();
    vi.mocked(ptyLiveSince).mockReturnValue(Date.now() - 60_000);
    noteTaskSessions([{ id: 1, sessionId: 's1' }]);
    recordQueueOperations([{ op: 'prompt', sessionId: 's1', text: 'p', ts: Date.now() - 1_000 }]);
    render(<Composer taskId={1} status="running" onSent={vi.fn()} />);
    await queueFailure();
    await codeLoaded();
    typeAndSend();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual([ALL]));
    expect(heldFor(1)[0]!.commentIds).toEqual([9, 3]);
    // What the held message carries is not To Send any more.
    expect(sendWaitingComments(1)).toBe(false);
    expect(heldFor(1)).toHaveLength(1);
    expect(submitPty).not.toHaveBeenCalled();
    act(() => recordQueueOperations([{ op: 'turn-end', sessionId: 's1', ts: Date.now() }]));
    await waitFor(() => expect(heldFor(1)).toEqual([]));
    await act(async () => {});
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, ALL]]);
    expect(vi.mocked(markCommentsSent).mock.calls).toEqual([[1, [9, 3]]]);
    // Held, then Sent: never back To Send between the release and the mark (#404 review).
    expect(document.querySelector('.tx-waiting')).toBeNull();
    expect(sendWaitingComments(1)).toBe(false);
    stop();
  });
});

/*
   An edit left open while a send carries its item (#404 review): the row
   goes once the item is delivered, the words do not. A code comment, now
   sent, takes them as an edit; a quote's go into the message box.
*/
describe('an edit open while the send carries its item', () => {
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
    const { __setAttentionBackend } = await import('../attention');
    __setAttentionBackend(() => {}, true, () => {});
    __resetDrafts();
    __resetConnectivity(async () => true);
    __resetOutbox();
    __resetTurns();
    __resetOpenEdits();
    seedQueue(['s1'], []);
    vi.mocked(hasLivePty).mockReturnValue(true);
    vi.mocked(submitPty).mockResolvedValue(true);
  });
  afterEach(async () => {
    const { __setAttentionBackend } = await import('../attention');
    __setAttentionBackend(null);
    cleanup();
    vi.clearAllMocks();
    __resetDrafts();
    __resetOutbox();
    __resetOpenEdits();
    __resetConnectivity();
    codeRows.rows = [];
    vi.mocked(markCommentsSent).mockImplementation(async () => {});
  });

  /** Held at a prompt with the list open and one item being edited, then answered. */
  async function editThenDeliver(open: () => void, words: string) {
    const { rerender } = render(<Composer taskId={1} status="blocked" onSent={vi.fn()} />);
    await codeLoaded();
    fireEvent.click(document.querySelector('.tx-waiting-head')!);
    open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment' }), { target: { value: words } });
    // Send while Claude asks: held, the list frozen.
    fireEvent.keyDown(document.querySelector('.tx-composer-input')!, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      rerender(<Composer taskId={1} status="idle" onSent={vi.fn()} />);
    });
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
  }

  it('a code comment, now sent, takes the words as an edit', { timeout: 10_000 }, async () => {
    codeRows.rows = [code(9, 'src/report/daily.ts', 42, 'use the local timezone')];
    // The sent mark, as the store writes it: read back on its change event.
    vi.mocked(markCommentsSent).mockImplementation(async (taskId: number) => {
      codeRows.rows = codeRows.rows.map((c) => ({ ...c, sentAt: Date.now() }));
      for (const cb of [...codeRows.listeners]) cb(taskId);
    });
    await editThenDeliver(() => fireEvent.click(screen.getByRole('button', { name: 'Edit' })), 'use the hotel’s timezone');
    expect(vi.mocked(submitPty).mock.calls[0]![1]).toContain('use the local timezone');
    // Settled once it reads as sent: after the release's settle (RELEASE_SETTLE_MS).
    await waitFor(() => expect(editComment).toHaveBeenCalledWith(1, 9, 'use the hotel’s timezone'), { timeout: 5_000 });
    expect(screen.queryByRole('textbox', { name: 'Edit comment' })).toBeNull();
  });

  it('a quote’s words go into the message box', async () => {
    addComment(1, later);
    await editThenDeliver(() => fireEvent.click(screen.getByRole('button', { name: 'Edit' })), 'two queries at most');
    expect(vi.mocked(submitPty).mock.calls[0]![1]).toContain('one query for the whole range');
    await waitFor(() => expect((document.querySelector('.tx-composer-input') as HTMLTextAreaElement).value).toBe('two queries at most'));
  });

  it('unchanged words settle as nothing', async () => {
    addComment(1, later);
    await editThenDeliver(() => fireEvent.click(screen.getByRole('button', { name: 'Edit' })), 'one query for the whole range');
    await act(async () => {});
    expect((document.querySelector('.tx-composer-input') as HTMLTextAreaElement).value).toBe('');
  });
});
