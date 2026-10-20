/**
 * @vitest-environment jsdom
 *
 * VALIDATION OF THE DOM HARNESS ITSELF, not of a product component.
 *
 * It exists so the workstream writing the composer tests does not have to
 * discover the mechanics first. Everything the composer's failure paths need
 * is exercised here against a stand-in component of the same shape:
 *
 *   - mocking `./Terminal` so xterm and the Tauri pty bridge never load
 *   - an effect that subscribes to `onPtyPresenceChange` and unsubscribes
 *   - an async handler whose await resolves after a later event
 *   - fake timers, for the "presence never arrives" timeout
 *   - identity changing mid-await (the task switch that wedged the latch)
 *
 * If any of this stops working, component tests are broken as infrastructure
 * rather than as assertions, and that distinction is worth being able to make.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';

import { hasLivePty, onPtyPresenceChange, startPty, submitPty } from './Terminal';

// The whole point: the heavy module is replaced, so nothing pulls in xterm,
// the Tauri bridge, or the module-scope listener registry.
vi.mock('./Terminal', () => {
  const listeners = new Set<(taskId: number, live: boolean) => void>();
  return {
    // Signature matches the real module: submitPty is ASYNC. TypeScript
    // enforces that here, which is worth knowing — a mock that drifts from
    // the real export fails the build rather than the assertion.
    submitPty: vi.fn(async () => false),
    startPty: vi.fn(),
    hasLivePty: vi.fn(() => false),
    onPtyPresenceChange: vi.fn((cb: (taskId: number, live: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    /** Test-only: drive a presence event the way Terminal.tsx would. */
    __emitPresence: (taskId: number, live: boolean) => {
      for (const cb of [...listeners]) cb(taskId, live);
    },
    __listenerCount: () => listeners.size,
  };
});

const term = (await import('./Terminal')) as unknown as {
  __emitPresence: (taskId: number, live: boolean) => void;
  __listenerCount: () => number;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** How long the real composer waits for a session `startPty` promised. */
const PRESENCE_TIMEOUT_MS = 12_000;

/**
 * Stand-in with the composer's control flow: submit, and if that fails ask for
 * a pty and wait for presence before sending exactly once.
 */
function Composer({ taskId }: { taskId: number }) {
  const [sent, setSent] = useState(0);
  const pending = useRef<{ taskId: number; text: string } | null>(null);

  useEffect(() => {
    return onPtyPresenceChange((id, live) => {
      const p = pending.current;
      if (!p || !live || id !== p.taskId) return;
      pending.current = null; // taken: a second event finds nothing
      submitPty(p.taskId, p.text);
      setSent((n) => n + 1);
    });
  }, []);

  // A task switch must not strand a pending send for the previous task.
  useEffect(() => {
    return () => {
      pending.current = null;
    };
  }, [taskId]);

  return (
    <>
      <button
        onClick={() => {
          void (async () => {
            if (await submitPty(taskId, 'hello')) {
              setSent((n) => n + 1);
              return;
            }
            pending.current = { taskId, text: 'hello' };
            if (startPty(taskId) && hasLivePty(taskId)) {
              pending.current = null;
              await submitPty(taskId, 'hello');
              setSent((n) => n + 1);
            }
          })();
        }}
      >
        send
      </button>
      <output data-testid="sent">{sent}</output>
    </>
  );
}

describe('harness: module mocking', () => {
  it('replaces Terminal without loading xterm or the pty bridge', () => {
    expect(vi.isMockFunction(submitPty)).toBe(true);
    expect(vi.isMockFunction(startPty)).toBe(true);
    expect(vi.isMockFunction(onPtyPresenceChange)).toBe(true);
  });
});

describe('harness: effects, subscriptions and events', () => {
  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<Composer taskId={1} />);
    expect(term.__listenerCount()).toBe(1);
    unmount();
    expect(term.__listenerCount()).toBe(0);
  });

  it('drives a presence event into a state update', async () => {
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(false);

    render(<Composer taskId={1} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1)); // failed attempt

    act(() => term.__emitPresence(1, true));

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    // and the state update reached the DOM
    await waitFor(() => expect(screen.getByTestId('sent').textContent).toBe('1'));
  });

  it('a second presence event finds nothing left to send', async () => {
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(false);

    render(<Composer taskId={1} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    act(() => term.__emitPresence(1, true));
    act(() => term.__emitPresence(1, true));

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2)); // 1 fail + 1 send
  });

  it('ignores presence for a DIFFERENT task', async () => {
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(false);

    render(<Composer taskId={1} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    act(() => term.__emitPresence(2, true));

    expect(submitPty).toHaveBeenCalledTimes(1); // still just the failure
  });

  it('sends immediately when startPty reports an ALREADY-LIVE pty', async () => {
    // The real bug: startPty returns true for a pty that is already up, so no
    // presence event ever arrives and the send waited for the timeout.
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);

    render(<Composer taskId={1} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2)); // no waiting
  });

  it('a task switch mid-await does not strand the pending send', async () => {
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(false);

    const { rerender } = render(<Composer taskId={1} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    rerender(<Composer taskId={2} />); // user switches task while the send waits

    act(() => term.__emitPresence(1, true)); // late presence for the old task
    expect(submitPty).toHaveBeenCalledTimes(1); // nothing sent for task 1

    // and the composer is not wedged: the next send still works
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    act(() => term.__emitPresence(2, true));
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(3));
  });
});

describe('harness: fake timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('can advance past a presence timeout without waiting for it', () => {
    const onTimeout = vi.fn();
    setTimeout(onTimeout, PRESENCE_TIMEOUT_MS);
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(PRESENCE_TIMEOUT_MS));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
