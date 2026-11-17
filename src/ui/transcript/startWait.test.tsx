/**
 * @vitest-environment jsdom
 *
 * A message sent before Claude Code has started (#439): shown at once as
 * yours, waiting, with a clock; past 15 s a warning with Show Terminal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => true),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { __resetOutbox, holdMessage, holdNotDelivered } from './outbox';
import { __resetStartGate, awaitingStart, noteSessionStarted, setAwaitingStart } from './startGate';
import { startOutboxRelease } from './outboxRelease';
import { submitPty } from '../Terminal';
import { setTrustWaiting } from '../../capture/workspaceTrust';
import { START_WAIT_TEXT, START_WARN_MS, START_WARN_TITLE, StartWaitNotice, StartWaitRows } from './StartWait';

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
  vi.useFakeTimers();
  __resetOutbox();
});

afterEach(() => {
  cleanup();
  __resetStartGate();
  __resetOutbox();
  setTrustWaiting(1, false);
  vi.useRealTimers();
});

function view(onShowTerminal = vi.fn()) {
  render(
    <>
      <StartWaitRows taskId={1} />
      <StartWaitNotice taskId={1} onShowTerminal={onShowTerminal} />
    </>,
  );
  return onShowTerminal;
}

describe('waiting for Claude Code to start (#439)', () => {
  it('shows a held message at once, as yours, waiting, with a clock that counts', async () => {
    setAwaitingStart(1, Date.now());
    holdMessage(1, 'can we tidy the header?');
    view();
    expect(screen.getByText('can we tidy the header?')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(document.querySelector('.tx-start-wait-meta')?.textContent).toBe(`${START_WAIT_TEXT} · 0s`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(document.querySelector('.tx-start-wait-meta')?.textContent).toBe(`${START_WAIT_TEXT} · 3s`);
    // No warning yet.
    expect(screen.queryByText(START_WARN_TITLE)).toBeNull();
  });

  it('past 15 s, warns and offers Show Terminal', async () => {
    setAwaitingStart(1, Date.now());
    holdMessage(1, 'still waiting');
    const show = view();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WARN_MS - 1_000);
    });
    expect(screen.queryByText(START_WARN_TITLE)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(START_WARN_TITLE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show Terminal' }));
    expect(show).toHaveBeenCalledWith(1);
  });

  it('Send Anyway opens the gate by hand: the release then sends them in order', async () => {
    vi.mocked(submitPty).mockResolvedValue(true);
    const stop = startOutboxRelease();
    try {
      setAwaitingStart(1, Date.now());
      holdMessage(1, 'first');
      holdMessage(1, 'second');
      view();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(START_WARN_MS);
      });
      expect(submitPty).not.toHaveBeenCalled();
      expect(awaitingStart(1)).toBe(true);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send Anyway' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(awaitingStart(1)).toBe(false);
      expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'first\n\nsecond']]);
      expect(screen.queryByText(START_WARN_TITLE)).toBeNull();
    } finally {
      stop();
    }
  });

  it('after Send Anyway, the task\u2019s next wait warns at once; a reported start forgets that', async () => {
    setAwaitingStart(1, Date.now());
    holdMessage(1, 'one');
    view();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WARN_MS);
    });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Send Anyway' })));
    expect(awaitingStart(1)).toBe(false);

    // A respawn: its hooks may never fire either.
    act(() => {
      setAwaitingStart(1, Date.now());
      holdMessage(1, 'two');
    });
    expect(screen.getByText(START_WARN_TITLE)).toBeTruthy();

    // This process did report its start: the hooks work, so the next wait waits 15 s again.
    act(() => noteSessionStarted(1));
    act(() => {
      setAwaitingStart(1, Date.now());
      holdMessage(1, 'three');
    });
    expect(screen.queryByText(START_WARN_TITLE)).toBeNull();
  });

  it('the clock is hidden from assistive tech; the words are not', () => {
    setAwaitingStart(1, Date.now());
    holdMessage(1, 'quiet');
    view();
    const time = document.querySelector('.tx-start-wait-time');
    expect(time?.getAttribute('aria-hidden')).toBe('true');
    expect(time?.closest('[aria-live]')).not.toBeNull();
    expect(screen.getByText(START_WAIT_TEXT, { exact: false })).toBeTruthy();
  });

  it('shows nothing once Claude Code is up, or with nothing held', async () => {
    setAwaitingStart(1, Date.now());
    view();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WARN_MS);
    });
    // Starting slowly, but nothing waits on it.
    expect(document.querySelector('.tx-row-start-wait')).toBeNull();
    expect(screen.queryByText(START_WARN_TITLE)).toBeNull();

    act(() => void holdMessage(1, 'goes once it is up'));
    expect(document.querySelector('.tx-row-start-wait')).not.toBeNull();
    act(() => setAwaitingStart(1, null));
    expect(document.querySelector('.tx-row-start-wait')).toBeNull();
    expect(screen.queryByText(START_WARN_TITLE)).toBeNull();
  });

  it('a running session never shows it, whatever is held', () => {
    holdMessage(1, 'held for a turn');
    view();
    expect(document.querySelector('.tx-row-start-wait')).toBeNull();
  });

  it('leaves out one not delivered: the band says that, and it goes only at the person’s word', () => {
    setAwaitingStart(1, Date.now());
    holdNotDelivered(1, 'from the last process', Date.now(), []);
    holdMessage(1, 'new one');
    view();
    expect(screen.queryByText('from the last process')).toBeNull();
    expect(screen.getByText('new one')).toBeTruthy();
  });

  it('no warning while the trust dialog is up: its own card says so', async () => {
    setAwaitingStart(1, Date.now());
    setTrustWaiting(1, true);
    holdMessage(1, 'after trust');
    view();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WARN_MS);
    });
    expect(screen.queryByText(START_WARN_TITLE)).toBeNull();
    expect(document.querySelector('.tx-row-start-wait')).not.toBeNull();
  });
});
