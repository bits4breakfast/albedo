/**
 * @vitest-environment jsdom
 *
 * "Load Earlier Messages" after the live tail has added more than a page
 * (#362). The window asked for `limit + 200`, counting none of the rows the
 * tail had added, so it read back fewer rows than were on screen: the
 * transcript shrank and the load could fire again. It now grows from the rows
 * held, and keeps the objects of rows it already had.
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

/** The database: rows in id order, which is also time order here. */
const db: Message[] = [];
const getMessages = vi.fn(async (opts: { afterId?: number; limit?: number }) => {
  const limit = opts.limit ?? 200;
  if (opts.afterId !== undefined) return db.filter((m) => m.id > opts.afterId!).slice(0, limit).map((m) => ({ ...m }));
  // The window: the newest `limit` rows, as fresh objects every time, as SQLite gives them.
  return db.slice(Math.max(0, db.length - limit)).map((m) => ({ ...m }));
});
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: (opts: { afterId?: number; limit?: number }) => getMessages(opts),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));
let captureListener: ((u: { sessionId: string }) => void) | null = null;
vi.mock('../../capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture')>()),
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    captureListener = cb;
    return () => {
      captureListener = null;
    };
  },
}));

const { TranscriptPane } = await import('./TranscriptPane');

const T0 = Date.parse('2026-11-12T10:00:00Z');
function add(count: number): void {
  const from = db.length;
  for (let i = 0; i < count; i++) {
    const id = from + i + 1;
    db.push({
      id,
      taskId: 1,
      sessionId: 's1',
      seq: id * 100,
      role: 'assistant',
      toolName: null,
      targetPath: null,
      body: `row ${id}`,
      rawJson: JSON.stringify({ type: 'assistant', i: id }),
      agentId: null,
      ts: T0 + id * 1000,
    });
  }
}
const shown = () => document.querySelectorAll('.tx-scroll [data-message-id]').length;

beforeEach(() => {
  db.length = 0;
  getMessages.mockClear();
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
afterEach(() => cleanup());

// Hundreds of rows drawn in jsdom: slow under a loaded machine, not stuck.
const SLOW = 30_000;

describe('Load Earlier Messages after a long live tail (#362)', () => {
  it('never shows fewer rows than before, and asks for the rows held plus a page', async () => {
    add(300);
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    await waitFor(() => expect(shown()).toBe(200), { timeout: SLOW });

    // 250 rows land while the reader watches.
    add(250);
    act(() => captureListener?.({ sessionId: 's1' }));
    await waitFor(() => expect(shown()).toBe(450), { timeout: SLOW });

    fireEvent.click(screen.getByRole('button', { name: 'Load Earlier Messages' }));
    await waitFor(() => expect(screen.getByText('Start of Conversation')).toBeTruthy(), { timeout: SLOW });
    expect(shown()).toBe(550);
    const windowCalls = getMessages.mock.calls.map(([o]) => o).filter((o) => o.afterId === undefined);
    expect(windowCalls.at(-1)?.limit).toBe(650);
  }, SLOW);

  it('keeps going back a page at a time with no live rows, as before', async () => {
    add(450);
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    await waitFor(() => expect(shown()).toBe(200), { timeout: SLOW });
    fireEvent.click(screen.getByRole('button', { name: 'Load Earlier Messages' }));
    await waitFor(() => expect(shown()).toBe(400), { timeout: SLOW });
    expect(screen.getByRole('button', { name: 'Load Earlier Messages' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load Earlier Messages' }));
    await waitFor(() => expect(shown()).toBe(450), { timeout: SLOW });
    expect(screen.getByText('Start of Conversation')).toBeTruthy();
  }, SLOW);

  it('a row already on screen keeps its element across the load', async () => {
    add(300);
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    await waitFor(() => expect(shown()).toBe(200), { timeout: SLOW });
    const before = document.querySelector('[data-message-id="300"]');
    fireEvent.click(screen.getByRole('button', { name: 'Load Earlier Messages' }));
    await waitFor(() => expect(shown()).toBe(300), { timeout: SLOW });
    expect(document.querySelector('[data-message-id="300"]')).toBe(before);
  }, SLOW);
});
