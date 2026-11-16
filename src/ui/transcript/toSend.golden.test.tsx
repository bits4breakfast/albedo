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
import { hasLivePty, submitPty } from '../Terminal';
import { Composer } from './Composer';
import { __resetDrafts, addComment, commentsOf } from './drafts';
import type { TranscriptComment } from './transcriptQuotes';
import { __resetOutbox } from './outbox';
import { __resetTurns } from './turn';
import { seedQueue } from '../../capture/queue';
import { __resetConnectivity } from '../../lib/connectivity';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

const codeRows = vi.hoisted(() => ({ rows: [] as import('../../db/comments').ReviewComment[] }));
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => codeRows.rows),
    onCommentsChanged: vi.fn(() => () => {}),
    markCommentsSent: vi.fn(async () => {}),
  };
});
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/me') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }));

const { listComments, markCommentsSent } = await import('../../db/comments');

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
