/**
 * @vitest-environment jsdom
 *
 * Jump to the Latest Message moved from ⌘↓ to ⌥⌘↓ (#398): ⌘↓ now steps to
 * the next task, so the transcript answers ⌥⌘↓ only, and its pill says so.
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
vi.mock('../../capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture')>()),
  onCaptureUpdate: () => () => {},
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


const DOWN = { key: 'ArrowDown', code: 'ArrowDown', metaKey: true };

/** The scroller laid out as on screen, read 600px above the end. */
function scrolledUp(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.tx-scroll')!;
  Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => document.body });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
  el.scrollTop = 100;
  fireEvent.scroll(el);
  return el;
}

describe('Jump to the Latest Message (#398)', () => {
  it('is ⌥⌘↓, named on its pill; ⌘↓ leaves the transcript where it is', async () => {
    add(20);
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    await waitFor(() => expect(document.querySelectorAll('.tx-scroll [data-message-id]').length).toBe(20));
    const el = scrolledUp();
    const pill = await screen.findByRole('button', { name: /Latest/ });
    expect(pill.getAttribute('title')).toBe('Jump to the latest message (⌥⌘↓)');
    expect(pill.querySelector('kbd')?.textContent).toBe('⌥⌘↓');
    expect(el.hasAttribute('data-jump-latest')).toBe(true);

    fireEvent.keyDown(window, DOWN);
    expect(el.scrollTop).toBe(100);
    expect(screen.queryByRole('button', { name: /Latest/ })).not.toBeNull();

    const e = new KeyboardEvent('keydown', { ...DOWN, altKey: true, bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(el.scrollTop).toBe(1000);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Latest/ })).toBeNull());
  });
});
