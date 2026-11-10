/**
 * @vitest-environment jsdom
 *
 * The transcript pane draws Remote Control's menu notice (#343) above the
 * message box, and its Show Terminal is the pane's "answer in terminal" -- the
 * one App wires to switch Transcript only to Split and focus the terminal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  getMessages: vi.fn(async () => []),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));

const { TranscriptPane } = await import('./TranscriptPane');
const { __resetRemoteWaits, __setRemoteWait } = await import('../remoteWait');

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
});
afterEach(() => {
  cleanup();
  __resetRemoteWaits();
});

describe("Remote Control's menu in the transcript pane", () => {
  it('sits above the message box, and Show Terminal asks for this task’s terminal', async () => {
    const answer = vi.fn();
    render(<TranscriptPane taskId={1} sessionId="s1" onAnswerInTerminal={answer} />);
    await waitFor(() => expect(document.querySelector('.tx-composer')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Show Terminal' })).toBeNull();

    act(() => __setRemoteWait(1, { phase: 'menu', at: 1_000 }));
    const notice = document.querySelector('.rc-menu') as HTMLElement;
    const composer = document.querySelector('.tx-composer') as HTMLElement;
    expect(notice).toBeTruthy();
    // Before the composer in document order: above the message box.
    expect(notice.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show Terminal' }));
    expect(answer).toHaveBeenCalledWith(1);
  });
});
