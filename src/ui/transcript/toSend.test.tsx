/**
 * @vitest-environment jsdom
 *
 * To Send (#404): one list in the message's order and its count, Send N and
 * the line beside it, the freeze the composer announces while a send carries
 * the list, and Jump from outside the transcript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { hasLivePty, startPty, submitPty } from '../Terminal';
import { Composer } from './Composer';
import { __resetDrafts, addComment } from './drafts';
import type { TranscriptComment } from './transcriptQuotes';
import { __resetOutbox } from './outbox';
import { __resetTurns } from './turn';
import { __resetConnectivity } from '../../lib/connectivity';
import {
  __resetOpenEdits,
  __resetToSendFrozen,
  closeEditsFor,
  editsOf,
  openEdit,
  sendLabel,
  setEditWords,
  setToSendFrozen,
  toSendOf,
  useToSendFrozen,
} from './toSend';
import { jumpToPassage, onRevealPassageRequest, onShowTranscriptRequest } from './composerBridge';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
  markCommentsSent: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/me') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }));

const q = (id: string, at: number): TranscriptComment => ({
  id, messageId: at, quote: `passage ${id}`, code: false, comment: `about ${id}`, at, offset: 0, addedAt: 10 - at,
});

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
  __resetOutbox();
  __resetTurns();
  __resetConnectivity(async () => true);
  __resetToSendFrozen();
  vi.mocked(hasLivePty).mockReturnValue(true);
  vi.mocked(submitPty).mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetConnectivity();
});

describe('the list', () => {
  it('quotes in transcript order, the CI failure counting as one', () => {
    const ci = { sha: 'a', prNumber: 1, checks: [] } as unknown as import('./ciFailure').QueuedCiFailure;
    const list = toSendOf(ci, [], [q('late', 3), q('early', 1)]);
    expect(list.quotes.map((c) => c.id)).toEqual(['early', 'late']);
    expect(list.count).toBe(3);
    expect(toSendOf(null, [], []).count).toBe(0);
  });

  it('Send N says the count, and just Send with none', () => {
    expect(sendLabel(4)).toBe('Send 4');
    expect(sendLabel(0)).toBe('Send');
  });
});

describe('Send N in the message box', () => {
  it('with text, says it goes with the list; a command goes alone and is just Send', async () => {
    addComment(1, q('a', 1));
    addComment(1, q('b', 2));
    render(<Composer taskId={1} onSent={vi.fn()} />);
    expect(document.querySelector('.tx-composer-sends')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'and this' } });
    expect(document.querySelector('.tx-composer-sends')?.textContent).toBe('Sends your text with the 2 above');
    const send = screen.getByRole('button', { name: 'Send 2' });
    expect(send.textContent).toBe('Send 2');
    expect(send.hasAttribute('aria-keyshortcuts')).toBe(false);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/compact' } });
    expect(document.querySelector('.tx-composer-sends')?.textContent).toBe('The command goes alone; the 2 above wait');
    expect(screen.getByRole('button', { name: 'Send' }).querySelector('svg')).not.toBeNull();
  });

  it('with nothing To Send it is the arrow, as before', () => {
    render(<Composer taskId={1} onSent={vi.fn()} />);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.querySelector('svg')).not.toBeNull();
    expect(send.hasAttribute('data-count')).toBe(false);
  });
});

describe('frozen while a send carries the list', () => {
  it('the composer says so while it waits for a session, and not after', async () => {
    vi.mocked(hasLivePty).mockReturnValue(false);
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    addComment(1, q('a', 1));
    const frozen = renderHook(() => useToSendFrozen(1));
    const { unmount } = render(<Composer taskId={1} onSent={vi.fn()} />);
    expect(frozen.result.current).toBe(false);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'go' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(frozen.result.current).toBe(true));
    unmount();
    expect(frozen.result.current).toBe(false);
  });

  it('per task', () => {
    const one = renderHook(() => useToSendFrozen(1));
    const two = renderHook(() => useToSendFrozen(2));
    act(() => setToSendFrozen(1, true));
    expect([one.result.current, two.result.current]).toEqual([true, false]);
  });
});

describe('Jump from outside the transcript', () => {
  it('only the task’s own transcript takes it, and only then is the transcript shown', () => {
    const shown: number[] = [];
    const revealed: unknown[] = [];
    const offShow = onShowTranscriptRequest((id) => shown.push(id));
    const target = { messageId: 4, quote: 'x', offset: 0 };
    expect(jumpToPassage(1, target)).toBe(false);
    expect(shown).toEqual([]);
    const offReveal = onRevealPassageRequest((id, t) => {
      if (id !== 1) return false;
      revealed.push(t);
      return true;
    });
    expect(jumpToPassage(2, target)).toBe(false);
    expect(jumpToPassage(1, target)).toBe(true);
    expect(revealed).toEqual([target]);
    expect(shown).toEqual([1]);
    offShow();
    offReveal();
  });
});

describe('open edits, kept beside the list (#404 review)', () => {
  it('keep the words typed, per view, and a removal on purpose drops them in every view', () => {
    __resetOpenEdits();
    openEdit({ taskId: 1, view: 'box', kind: 'quote', id: 'q', initial: 'a' });
    openEdit({ taskId: 1, view: 'files', kind: 'quote', id: 'q', initial: 'a' });
    openEdit({ taskId: 2, view: 'box', kind: 'quote', id: 'q', initial: 'a' });
    setEditWords({ taskId: 1, view: 'box', kind: 'quote', id: 'q' }, 'b');
    expect(editsOf(1).map((e) => [e.view, e.words])).toEqual([
      ['box', 'b'],
      ['files', 'a'],
    ]);
    closeEditsFor(1, 'quote', 'q');
    expect(editsOf(1)).toEqual([]);
    expect(editsOf(2)).toHaveLength(1);
    __resetOpenEdits();
  });

  it('Remove in the box drops an edit Files has open, so its words never land in the box', async () => {
    __resetOpenEdits();
    addComment(1, q('a', 1));
    render(<Composer taskId={1} onSent={vi.fn()} />);
    act(() => openEdit({ taskId: 1, view: 'files', kind: 'quote', id: 'a', initial: 'about a' }));
    act(() => setEditWords({ taskId: 1, view: 'files', kind: 'quote', id: 'a' }, 'changed my mind'));
    fireEvent.click(document.querySelector('.tx-waiting-head')!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await act(async () => {});
    expect(editsOf(1)).toEqual([]);
    expect((document.querySelector('.tx-composer-input') as HTMLTextAreaElement).value).toBe('');
  });
});
