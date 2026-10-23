/**
 * @vitest-environment jsdom
 *
 * The Queued band: Claude Code's queue while the session is alive, and the
 * outbox's held messages, which can be edited and removed in place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const queue: { entries: Array<{ text: string; ts: number; injected: boolean }> } = { entries: [] };
vi.mock('../../capture', () => ({
  queuedFor: () => queue.entries,
  queueSettlesAt: () => null,
  onQueueChange: () => () => {},
}));
vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => false),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

const { QueuedStrip } = await import('./TranscriptPane');
const { __resetOutbox, heldFor, holdMessage, releaseHeld } = await import('./outbox');
const { __resetConnectivity } = await import('../../lib/connectivity');

let online = true;

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
  queue.entries = [];
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  __resetConnectivity(async () => online);
  __resetOutbox();
});

afterEach(() => {
  cleanup();
  __resetConnectivity();
  __resetOutbox();
});

const T = Date.parse('2026-10-23T09:00:00.000Z');
/** When the session's pty was spawned: before every entry unless a test says otherwise. */
const SPAWNED = T - 60_000;

describe("Claude Code's queue", () => {
  it('shows typed entries while the session is alive, whatever the status says', () => {
    queue.entries = [
      { text: 'still waiting', ts: T, injected: false },
      { text: '<task-notification>x</task-notification>', ts: T, injected: true },
    ];
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByText('still waiting')).toBeTruthy();
    expect(screen.getByText('sent when Claude Code finishes its current step')).toBeTruthy();
    expect(screen.queryByText(/task-notification/)).toBeNull();
  });

  it('hides what an earlier process queued: a resumed session starts with an empty queue', () => {
    // seedQueue rebuilt these from the transcript; that claude is gone.
    queue.entries = [
      { text: 'from before the restart', ts: T, injected: false },
      { text: 'and this', ts: T + 10, injected: false },
    ];
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={T + 60_000} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('hides what a session that is gone never took', () => {
    queue.entries = [{ text: 'never taken', ts: T, injected: false }];
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={null} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('held messages', () => {
  it('are listed after the queue, waiting for the connection', () => {
    queue.entries = [{ text: 'in Claude Code', ts: T, injected: false }];
    holdMessage(1, 'in Albedo');
    online = false;
    window.dispatchEvent(new Event('offline'));
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    const band = screen.getByRole('status');
    expect(band.textContent).toMatch(/in Claude Code.*Waiting for connection.*in Albedo/);
    expect(screen.getByText('sent in order once it is back')).toBeTruthy();
  });

  it('show even when the session is not running: they are Albedo’s, not its', () => {
    holdMessage(1, 'kept');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={null} />);
    expect(screen.getByText('kept')).toBeTruthy();
  });

  it('can be removed', () => {
    holdMessage(1, 'never mind');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(heldFor(1)).toEqual([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('can be edited in place; Enter saves, Escape puts it back', () => {
    holdMessage(1, 'frist');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit held message' });
    fireEvent.change(field, { target: { value: 'first' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(heldFor(1).map((h) => h.text)).toEqual(['first']);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'oops' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(heldFor(1).map((h) => h.text)).toEqual(['first']);
  });

  it('are not released while open for editing', async () => {
    holdMessage(1, 'being edited');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const send = vi.fn(async () => true);
    await act(async () => {
      await releaseHeld(1, send);
    });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {
      await releaseHeld(1, send);
    });
    expect(send).toHaveBeenCalledWith('being edited');
  });

  it('say when one may already have been sent, and offer Send, Edit and Remove', async () => {
    holdMessage(1, 'cut off');
    void releaseHeld(1, () => new Promise<boolean>(() => {}));
    __resetOutbox(); // a crash mid-send
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByText('May already have been sent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByText('May already have been sent')).toBeNull();
    expect(heldFor(1)[0]?.maybeSent).toBeUndefined();
  });

  it('keep an edit left open when the band goes away', () => {
    holdMessage(1, 'draft');
    const { unmount } = render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft, finished' } });
    unmount();
    expect(heldFor(1).map((h) => h.text)).toEqual(['draft, finished']);
  });
});
