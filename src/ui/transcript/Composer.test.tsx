/**
 * @vitest-environment jsdom
 *
 * The transcript composer's send/retry wiring.
 *
 * This covers the one piece of control flow in the pane that cannot be
 * verified by reading it: a send that fails, asks `startPty` for a session,
 * and completes when `onPtyPresenceChange` reports one. Two of the three cases
 * below are regressions for bugs that actually shipped and were found by
 * tracing, not by reasoning forward:
 *
 *   (a) a task switch mid-await left the in-flight latch stuck true, so every
 *       later send was silently ignored — the composer was wedged shut;
 *   (b) `startPty` returns true for an ALREADY-LIVE pty, so no presence event
 *       was ever coming and the message waited out the full 12s timeout.
 *
 * (c) guards exactly-once, which works today and would regress silently.
 *
 * The property that makes all of this safe to ship is that every failure path
 * leaves the typed text where it is; the assertions below check that as much
 * as they check the call counts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { hasLivePty, onPtyPresenceChange, startPty, submitPty } from '../Terminal';
import { Composer } from './TranscriptPane';

// Replaces the real module, so xterm and the Tauri pty bridge never load.
// The signatures are checked against the real exports by tsc: a mock that
// drifts fails the build rather than the assertion.
vi.mock('../Terminal', () => {
  const listeners = new Set<(taskId: number, live: boolean) => void>();
  return {
    submitPty: vi.fn(async () => false),
    startPty: vi.fn(() => false),
    hasLivePty: vi.fn(() => false),
    onPtyPresenceChange: vi.fn((cb: (taskId: number, live: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    __emitPresence: (taskId: number, live: boolean) => {
      for (const cb of [...listeners]) cb(taskId, live);
    },
  };
});

const term = (await import('../Terminal')) as unknown as {
  __emitPresence: (taskId: number, live: boolean) => void;
};

// Vitest globals are off, so RTL cannot register its own auto-cleanup.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const pressEnter = () => fireEvent.keyDown(box(), { key: 'Enter' });

/** No live pty: the first send fails and the composer must ask for a session. */
function deadPty() {
  vi.mocked(submitPty).mockResolvedValue(false);
  vi.mocked(startPty).mockReturnValue(true);
  vi.mocked(hasLivePty).mockReturnValue(false);
}

// ---------------------------------------------------------------------------
// (a) task switch while a send is pending
// ---------------------------------------------------------------------------

describe('(a) a task switch mid-await does not wedge the composer', () => {
  it('still sends for the new task after switching away from a pending send', async () => {
    deadPty();
    const onSent = vi.fn();
    const { rerender } = render(<Composer taskId={1} onSent={onSent} />);

    type('first message');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1)); // the failure

    // The user switches task while that send is still waiting for a session.
    rerender(<Composer taskId={2} onSent={onSent} />);

    // A late presence event for the abandoned task must send nothing.
    act(() => term.__emitPresence(1, true));
    expect(submitPty).toHaveBeenCalledTimes(1);

    // THE REGRESSION: the in-flight latch used to stay set across the switch,
    // so this second send was dropped on the floor with no feedback at all.
    vi.mocked(submitPty).mockResolvedValue(true);
    type('second message');
    pressEnter();

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitPty).mock.calls[1]).toEqual([2, 'second message']);
  });

  it('clears the draft on a task switch, and only then', async () => {
    deadPty();
    const { rerender } = render(<Composer taskId={1} onSent={vi.fn()} />);

    type('half-written thought');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    // A failed send keeps the text. Losing it would be the unforgivable case.
    expect(box().value).toBe('half-written thought');

    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    expect(box().value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// (b) startPty reporting an already-live pty
// ---------------------------------------------------------------------------

describe('(b) startPty returning true for an already-live pty', () => {
  it('sends immediately rather than waiting out the presence timeout', async () => {
    // submitPty can fail against a LIVE pty (a write error). startPty then
    // returns true because one is already up — and no presence event is ever
    // coming, because nothing changed.
    vi.mocked(submitPty).mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);

    const onSent = vi.fn();
    render(<Composer taskId={7} onSent={onSent} />);

    type('retry me');
    pressEnter();

    // No timers advanced and no presence emitted: reaching the second call at
    // all proves the immediate flush fired. Before the fix this sat for 12s
    // and then told the user to try again.
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitPty).mock.calls[1]).toEqual([7, 'retry me']);

    await waitFor(() => expect(box().value).toBe(''));
    expect(onSent).toHaveBeenCalledTimes(1); // and the pane scrolled to the tail
  });

  it('keeps the text when the immediate retry also fails', async () => {
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);

    render(<Composer taskId={7} onSent={vi.fn()} />);
    type('still mine');
    pressEnter();

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    expect(box().value).toBe('still mine');
    // and the composer is usable again rather than stuck in the waiting state
    await waitFor(() => expect(box().readOnly).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// (c) exactly-once on a normal retry
// ---------------------------------------------------------------------------

describe('(c) exactly-once when presence brings the session up', () => {
  it('sends once when presence arrives, and a second event finds nothing', async () => {
    vi.mocked(submitPty).mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.mocked(startPty).mockReturnValue(true);
    vi.mocked(hasLivePty).mockReturnValue(false);

    const onSent = vi.fn();
    render(<Composer taskId={3} onSent={onSent} />);

    type('hello there');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1)); // failed
    expect(box().readOnly).toBe(true); // draft frozen while the send is pending

    // Two presence events. The pending body is TAKEN, not read, so the second
    // finds null — "sent twice" is structurally impossible, not merely unlikely.
    act(() => term.__emitPresence(3, true));
    act(() => term.__emitPresence(3, true));

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitPty).mock.calls[1]).toEqual([3, 'hello there']);

    await waitFor(() => expect(box().value).toBe(''));
    expect(onSent).toHaveBeenCalledTimes(1);

    // A third event, well after the send completed, still sends nothing.
    act(() => term.__emitPresence(3, true));
    expect(submitPty).toHaveBeenCalledTimes(2);
  });

  it('ignores presence for a different task', async () => {
    deadPty();
    render(<Composer taskId={3} onSent={vi.fn()} />);

    type('scoped');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));

    act(() => term.__emitPresence(99, true));
    expect(submitPty).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('scoped');
  });

  it('does not start a second send while one is pending', async () => {
    deadPty();
    render(<Composer taskId={3} onSent={vi.fn()} />);

    type('once');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));

    // Enter still reaches the handler (the field is readOnly, not disabled, so
    // the caret is not lost); the in-flight latch is what stops it.
    pressEnter();
    pressEnter();
    expect(submitPty).toHaveBeenCalledTimes(1);
  });

  it('reports and keeps the draft when the task is not open', async () => {
    vi.mocked(submitPty).mockResolvedValue(false);
    vi.mocked(startPty).mockReturnValue(false); // nothing mounted: unfixable here
    vi.mocked(hasLivePty).mockReturnValue(false);

    render(<Composer taskId={4} onSent={vi.fn()} />);
    type('nowhere to go');
    pressEnter();

    await waitFor(() => expect(screen.getByText(/no terminal to send to/i)).toBeDefined());
    expect(box().value).toBe('nowhere to go');
    expect(box().readOnly).toBe(false);
  });

  it('never sends an empty or whitespace-only message', () => {
    deadPty();
    render(<Composer taskId={5} onSent={vi.fn()} />);

    pressEnter();
    type('   \n  ');
    pressEnter();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('subscribes on mount and stops listening on unmount', async () => {
    deadPty();
    const { unmount } = render(<Composer taskId={6} onSent={vi.fn()} />);
    expect(onPtyPresenceChange).toHaveBeenCalledTimes(1);

    type('pending when the pane closes');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));

    unmount();
    // A presence event after unmount must not resurrect the send, and must not
    // warn about setting state on an unmounted tree.
    act(() => term.__emitPresence(6, true));
    expect(submitPty).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter does not send', () => {
    deadPty();
    render(<Composer taskId={5} onSent={vi.fn()} />);

    type('line one');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(submitPty).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (d) a session sitting on a permission prompt
// ---------------------------------------------------------------------------

/** A live pty whose writes succeed — the dangerous case, not a failing one. */
function livePty() {
  vi.mocked(submitPty).mockResolvedValue(true);
  vi.mocked(startPty).mockReturnValue(true);
  vi.mocked(hasLivePty).mockReturnValue(true);
}

describe('(d) blocked: the message is held instead of typed into the prompt', () => {
  it('does not write to the pty while the task is blocked', async () => {
    // The whole point. submitPty types into the pty, and a pty showing "1/2/3"
    // reads a paragraph as an answer to that question.
    livePty();
    render(<Composer taskId={5} status="blocked" onSent={vi.fn()} />);

    type('please also update the tests');
    pressEnter();

    await waitFor(() => expect(screen.getByText(/permission prompt/)).toBeTruthy());
    expect(submitPty).not.toHaveBeenCalled();
    // Frozen where the user left it, not cleared and not hidden.
    expect(box().value).toBe('please also update the tests');
    expect(box().readOnly).toBe(true);
  });

  it('sends it by itself once the status clears', async () => {
    livePty();
    const onSent = vi.fn();
    const { rerender } = render(<Composer taskId={5} status="blocked" onSent={onSent} />);

    type('please also update the tests');
    pressEnter();
    await waitFor(() => expect(screen.getByText(/permission prompt/)).toBeTruthy());

    await act(async () => {
      rerender(<Composer taskId={5} status="running" onSent={onSent} />);
    });

    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    expect(submitPty).toHaveBeenCalledWith(5, 'please also update the tests');
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('');
  });

  it('releases exactly once even if the status flickers', async () => {
    // deriveStatus runs on every capture tick; blocked -> running -> blocked
    // -> running must not send the same body three times.
    livePty();
    const { rerender } = render(<Composer taskId={5} status="blocked" onSent={vi.fn()} />);
    type('once please');
    pressEnter();
    await waitFor(() => expect(screen.getByText(/permission prompt/)).toBeTruthy());

    for (const s of ['running', 'blocked', 'running', 'idle'] as const) {
      await act(async () => {
        rerender(<Composer taskId={5} status={s} onSent={vi.fn()} />);
      });
    }
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
  });

  it('gives the message back when the hold is cancelled', async () => {
    // A permission prompt waits for a person and has no timeout, so without
    // this the composer would be frozen until someone answered it.
    livePty();
    render(<Composer taskId={5} status="blocked" onSent={vi.fn()} />);
    type('never mind');
    pressEnter();
    await waitFor(() => expect(screen.getByText(/permission prompt/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(box().readOnly).toBe(false);
    expect(box().value).toBe('never mind');
    // ...and the cancelled body must not fire when the status later clears.
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('leaves a merely running task alone — Claude Code queues those itself', async () => {
    livePty();
    render(<Composer taskId={5} status="running" onSent={vi.fn()} />);
    type('follow-up mid-turn');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
  });
});
