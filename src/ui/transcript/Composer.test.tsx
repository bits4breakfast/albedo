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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useFocusAreaCycle } from '../focusAreas';

import { canResume, hasLivePty, onPtyPresenceChange, ptyLiveSince, startPty, submitPty } from '../Terminal';
import { Composer } from './TranscriptPane';
import { __resetDrafts, getDraft, saveDraft } from './drafts';
import { __resetOutbox, heldFor, holdMessage, removeHeld } from './outbox';
import { startOutboxRelease } from './outboxRelease';
import { __resetTurns, noteTaskSessions } from './turn';
import { recordQueueOperations, seedQueue } from '../../capture/queue';
import { __resetConnectivity } from '../../lib/connectivity';

// Replaces the real module, so xterm and the Tauri pty bridge never load.
// The signatures are checked against the real exports by tsc: a mock that
// drifts fails the build rather than the assertion.
vi.mock('../Terminal', () => {
  const listeners = new Set<(taskId: number, live: boolean) => void>();
  return {
    submitPty: vi.fn(async () => false),
    startPty: vi.fn(() => false),
    hasLivePty: vi.fn(() => false),
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

// A held message's review comments are marked sent through this on delivery.
vi.mock('../../db/comments', () => ({ markCommentsSent: vi.fn(async () => {}) }));

// Paste writes through these; nothing touches a real disk.
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/me') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }));

const term = (await import('../Terminal')) as unknown as {
  __emitPresence: (taskId: number, live: boolean) => void;
};

// Vitest globals are off, so RTL cannot register its own auto-cleanup.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetDrafts();
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

  it('a switch away from a send waiting for a session cancels it and keeps the text as a draft', async () => {
    deadPty();
    const { rerender } = render(<Composer taskId={1} onSent={vi.fn()} />);

    type('half-written thought');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    // A failed send keeps the text. Losing it would be the unforgivable case.
    expect(box().value).toBe('half-written thought');
    expect(getDraft(1)).toBeNull(); // pending, so not a draft

    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    expect(box().value).toBe('');
    // The session comes up after all: the cancelled send must not fire.
    act(() => term.__emitPresence(1, true));
    expect(submitPty).toHaveBeenCalledTimes(1);

    rerender(<Composer taskId={1} onSent={vi.fn()} />);
    expect(box().value).toBe('half-written thought');
    expect(box().readOnly).toBe(false);
    expect(screen.getByText('Not sent \u2014 press Send when you\u2019re ready.')).toBeTruthy();
    act(() => term.__emitPresence(1, true));
    expect(submitPty).toHaveBeenCalledTimes(1);
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

    await waitFor(() => expect(screen.getByText(/nowhere to send this/i)).toBeDefined());
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

    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());

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
    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());

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
    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(box().readOnly).toBe(false);
    expect(box().value).toBe('never mind');
    // ...and the cancelled body must not fire when the status later clears.
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('holds a command at a prompt in the outbox: after the answer the turn goes on, and it must not land in it', async () => {
    render(<Composer taskId={1} status="blocked" onSent={vi.fn()} />);
    type('/compact');
    pressEnter();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['/compact']));
    expect(box().value).toBe('');
    expect(submitPty).not.toHaveBeenCalled();
    for (const h of heldFor(1)) removeHeld(1, h.id);
  });

  it('does not take a running status for a prompt: no prompt hold', async () => {
    livePty();
    render(<Composer taskId={5} status="running" onSent={vi.fn()} />);
    type('follow-up mid-turn');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
  });
});

describe('placeholder when no terminal is running', () => {
  it('promises the conversation is picked up when the CLI can resume it', () => {
    vi.mocked(hasLivePty).mockReturnValue(false);
    vi.mocked(canResume).mockReturnValue(true);
    render(<Composer taskId={1} onSent={vi.fn()} status="idle" />);
    expect(box().placeholder).toMatch(/pick this conversation back up/);
  });

  it('says a new session starts when it cannot, rather than over-promising', () => {
    vi.mocked(hasLivePty).mockReturnValue(false);
    vi.mocked(canResume).mockReturnValue(false);
    render(<Composer taskId={1} onSent={vi.fn()} status="idle" />);
    expect(box().placeholder).toMatch(/new session/);
  });
});

/*
 * The cycle itself is tested in ui/focusAreas.test.tsx; this checks the
 * composer's half of the contract -- that its textarea is the stop -- with the
 * real component, as App mounts it.
 */
describe('Tab with nothing focused', () => {
  const tab = (init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', ...init });

  it('focuses the composer when nothing holds focus', () => {
    renderHook(() => useFocusAreaCycle());
    render(<Composer taskId={1} onSent={() => {}} />);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    tab();

    expect(document.activeElement).toBe(box());
  });

  it('focuses the composer from a control outside every area', () => {
    renderHook(() => useFocusAreaCycle());
    render(
      <>
        <button>other</button>
        <Composer taskId={1} onSent={() => {}} />
      </>,
    );
    screen.getByText('other').focus();

    tab();

    expect(document.activeElement).toBe(box());
  });

  it('does not steal focus from behind an open dialog', () => {
    renderHook(() => useFocusAreaCycle());
    render(
      <>
        <div aria-modal="true" role="dialog" />
        <Composer taskId={1} onSent={() => {}} />
      </>,
    );
    (document.activeElement as HTMLElement | null)?.blur();

    tab();

    expect(document.activeElement).toBe(document.body);
  });
});

describe('resizable composer', () => {
  const grip = () => screen.getByRole('separator');

  // This environment's localStorage is not a working Storage, so give the
  // component a plain in-memory one.
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

  it('dragging the grip up sets the height, and it is remembered', () => {
    render(<Composer taskId={1} onSent={() => {}} />);
    fireEvent.pointerDown(grip(), { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grip(), { clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(grip(), { clientY: 120, pointerId: 1 });

    expect(box().style.height).toBe('80px');
    expect(box().style.maxHeight).toBe('none');
    expect(window.localStorage.getItem('albedo.composerPx')).toBe('80');
  });

  it('double-click resets to auto-grow and forgets the height', () => {
    render(<Composer taskId={1} onSent={() => {}} />);
    fireEvent.pointerDown(grip(), { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grip(), { clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(grip(), { clientY: 120, pointerId: 1 });

    fireEvent.doubleClick(grip());

    expect(box().style.maxHeight).toBe('');
    expect(window.localStorage.getItem('albedo.composerPx')).toBeNull();
  });

  it('starts at a remembered height', () => {
    window.localStorage.setItem('albedo.composerPx', '96');
    render(<Composer taskId={1} onSent={() => {}} />);
    expect(box().style.height).toBe('96px');
  });
});

describe('pasting a screenshot', () => {
  const imageItem = (bytes: number[]) => ({
    kind: 'file',
    type: 'image/png',
    getAsFile: () => ({ type: 'image/png', arrayBuffer: async () => new Uint8Array(bytes).buffer }) as unknown as File,
  });
  const textItem = { kind: 'string', type: 'text/plain', getAsFile: () => null };

  it('writes the image under ~/.albedo/paste and inserts its path like a drop', async () => {
    const fs = await import('@tauri-apps/plugin-fs');
    render(<Composer taskId={1} onSent={vi.fn()} />);
    type('see');
    const notPrevented = fireEvent.paste(box(), { clipboardData: { items: [textItem, imageItem([1, 2, 3])] } });
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(box().value).toMatch(/^see \/Users\/me\/\.albedo\/paste\/\d{8}-\d{6}-\d{3}\.png $/));
    expect(fs.mkdir).toHaveBeenCalledWith('/Users/me/.albedo/paste', { recursive: true });
    const [path, data] = vi.mocked(fs.writeFile).mock.calls[0]!;
    expect(box().value).toBe(`see ${path} `);
    expect([...(data as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('leaves a text paste to the browser, exactly as before', async () => {
    const fs = await import('@tauri-apps/plugin-fs');
    render(<Composer taskId={1} onSent={vi.fn()} />);
    const notPrevented = fireEvent.paste(box(), { clipboardData: { items: [textItem] } });
    expect(notPrevented).toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('says so, and keeps the draft, when the write fails', async () => {
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('forbidden path'));
    render(<Composer taskId={1} onSent={vi.fn()} />);
    type('draft');
    fireEvent.paste(box(), { clipboardData: { items: [imageItem([9])] } });
    await waitFor(() => expect(screen.getByText(/Could not save the pasted image: forbidden path/)).toBeTruthy());
    expect(box().value).toBe('draft');
  });
});

describe('shellEscapePath', () => {
  it('escapes spaces and shell characters the way a terminal does on drop', async () => {
    const { shellEscapePath } = await import('./TranscriptPane');
    expect(shellEscapePath('/T/Screenshot 2026-10-17 at 00.36.49.png')).toBe('/T/Screenshot\\ 2026-10-17\\ at\\ 00.36.49.png');
    expect(shellEscapePath("/a/it's (1).png")).toBe("/a/it\\'s\\ \\(1\\).png");
    expect(shellEscapePath('/plain/path.png')).toBe('/plain/path.png');
  });
});

describe('collapsing a large text paste', () => {
  const clip = (text: string) => ({
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    getData: (t: string) => (t === 'text/plain' ? text : ''),
  });
  const log = 'Error: boom\n  at a (x.ts:1)\n  at b (y.ts:2)\n  at c (z.ts:3)';

  it('shows a placeholder in the box and sends the real text', async () => {
    vi.mocked(submitPty).mockResolvedValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);
    render(<Composer taskId={1} onSent={vi.fn()} />);
    type('why does this fail? ');
    box().setSelectionRange(box().value.length, box().value.length);
    const notPrevented = fireEvent.paste(box(), { clipboardData: clip(log) });
    expect(notPrevented).toBe(false);
    expect(box().value).toBe('why does this fail? [Pasted text #1 +4 lines]');

    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, `why does this fail? ${log}`));
  });

  it('leaves a short paste to the browser', () => {
    render(<Composer taskId={1} onSent={vi.fn()} />);
    const notPrevented = fireEvent.paste(box(), { clipboardData: clip('two\nlines') });
    expect(notPrevented).toBe(true);
    expect(box().value).toBe('');
  });

  it('drops the text when its placeholder was deleted', async () => {
    vi.mocked(submitPty).mockResolvedValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);
    render(<Composer taskId={1} onSent={vi.fn()} />);
    fireEvent.paste(box(), { clipboardData: clip(log) });
    type('never mind');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, 'never mind'));
  });
});

// ---------------------------------------------------------------------------
// (z) text handed in from elsewhere (review comments)
// ---------------------------------------------------------------------------

describe('(z) text handed to the composer through the bridge', () => {
  it("goes into its own task's box only, after any draft, and reports what was sent", async () => {
    const { insertIntoComposer } = await import('./composerBridge');
    vi.mocked(submitPty).mockResolvedValue(true);
    render(<Composer taskId={5} onSent={vi.fn()} />);

    let other = true;
    act(() => {
      other = insertIntoComposer({ taskId: 6, text: 'not mine' });
    });
    expect(other).toBe(false);
    expect(box().value).toBe('');

    type('my draft');
    const onSent = vi.fn(() => true);
    let taken = false;
    act(() => {
      taken = insertIntoComposer({ taskId: 5, text: 'comments\nsecond line', onSent });
    });
    expect(taken).toBe(true);
    expect(box().value).toBe('my draft\n\ncomments\nsecond line');
    expect(onSent).not.toHaveBeenCalled(); // in the box is not sent

    pressEnter();
    await waitFor(() => expect(onSent).toHaveBeenCalledWith('my draft\n\ncomments\nsecond line'));
  });
});

// ---------------------------------------------------------------------------
// (d) one draft per task
// ---------------------------------------------------------------------------

describe('(d) each task keeps its own draft', () => {
  const clip = (text: string) => ({
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    getData: (t: string) => (t === 'text/plain' ? text : ''),
  });
  const log = 'Error: boom\n  at a (x.ts:1)\n  at b (y.ts:2)\n  at c (z.ts:3)';

  it('A, B, then A again: each box holds its own text, caret at the end', async () => {
    const { rerender } = render(<Composer taskId={1} onSent={vi.fn()} />);
    type('for A');
    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    expect(box().value).toBe('');
    type('for B');

    rerender(<Composer taskId={1} onSent={vi.fn()} />);
    expect(box().value).toBe('for A');
    await waitFor(() => expect(box().selectionStart).toBe('for A'.length));
    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    expect(box().value).toBe('for B');
  });

  it('brings the paste placeholders back with the pastes they stand for', async () => {
    vi.mocked(submitPty).mockResolvedValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);
    const { rerender } = render(<Composer taskId={1} onSent={vi.fn()} />);
    fireEvent.paste(box(), { clipboardData: clip(log) });
    expect(box().value).toBe('[Pasted text #1 +4 lines]');

    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    rerender(<Composer taskId={1} onSent={vi.fn()} />);
    expect(box().value).toBe('[Pasted text #1 +4 lines]');

    // A new paste does not reuse the restored placeholder's number.
    box().setSelectionRange(box().value.length, box().value.length);
    fireEvent.paste(box(), { clipboardData: clip('second\nlong\npaste') });
    expect(box().value).toBe('[Pasted text #1 +4 lines][Pasted text #2 +3 lines]');

    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, `${log}second\nlong\npaste`));
  });

  it('a sent draft is gone', async () => {
    vi.mocked(submitPty).mockResolvedValue(true);
    const { rerender } = render(<Composer taskId={1} onSent={vi.fn()} />);
    type('ship it');
    pressEnter();
    await waitFor(() => expect(box().value).toBe(''));
    expect(getDraft(1)).toBeNull();

    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    rerender(<Composer taskId={1} onSent={vi.fn()} />);
    expect(box().value).toBe('');
  });

  it('a held send is not a draft, and cancelling the hold keeps it again', async () => {
    const { rerender } = render(<Composer taskId={5} status="blocked" onSent={vi.fn()} />);
    type('after the prompt');
    expect(getDraft(5)?.text).toBe('after the prompt');
    pressEnter();
    await waitFor(() => expect(box().readOnly).toBe(true));
    expect(getDraft(5)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(getDraft(5)?.text).toBe('after the prompt'));
    rerender(<Composer taskId={5} status="blocked" onSent={vi.fn()} />);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('a switch away from a held send cancels the hold and keeps it, pastes and all', async () => {
    vi.mocked(submitPty).mockResolvedValue(true);
    const clipLog = clip(log);
    const { rerender } = render(<Composer taskId={5} status="blocked" onSent={vi.fn()} />);
    type('look: ');
    box().setSelectionRange(box().value.length, box().value.length);
    fireEvent.paste(box(), { clipboardData: clipLog });
    pressEnter();
    await waitFor(() => expect(box().readOnly).toBe(true));

    rerender(<Composer taskId={6} status="idle" onSent={vi.fn()} />);
    expect(getDraft(5)?.text).toBe('look: [Pasted text #1 +4 lines]');
    // The prompt being answered no longer releases anything.
    rerender(<Composer taskId={6} status="running" onSent={vi.fn()} />);
    expect(submitPty).not.toHaveBeenCalled();

    rerender(<Composer taskId={5} status="idle" onSent={vi.fn()} />);
    expect(box().value).toBe('look: [Pasted text #1 +4 lines]');
    expect(screen.getByText('Not sent \u2014 press Send when you\u2019re ready.')).toBeTruthy();
    expect(submitPty).not.toHaveBeenCalled();

    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitPty).mock.calls[0]).toEqual([5, `look: ${log}`]);
    await waitFor(() => expect(box().value).toBe(''));
    expect(getDraft(5)).toBeNull();
  });

  it('opens on the draft a previous run left', () => {
    saveDraft(8, 'from before the restart', new Map());
    render(<Composer taskId={8} onSent={vi.fn()} />);
    expect(box().value).toBe('from before the restart');
  });

  it('a send that lands after a switch leaves the other task\'s draft alone', async () => {
    let land: (ok: boolean) => void = () => {};
    vi.mocked(submitPty).mockImplementation(() => new Promise<boolean>((r) => (land = r)));
    saveDraft(2, 'B is mine', new Map());
    const onSent = vi.fn();
    const { rerender } = render(<Composer taskId={1} onSent={onSent} />);
    type('for A');
    pressEnter();
    rerender(<Composer taskId={2} onSent={onSent} />);
    expect(box().value).toBe('B is mine');

    await act(async () => land(true));
    expect(box().value).toBe('B is mine');
    expect(getDraft(2)?.text).toBe('B is mine');
    expect(getDraft(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (o) offline: the outbox (#56)
// ---------------------------------------------------------------------------

describe('(o) offline, a send waits in the outbox', () => {
  let online = true;
  const setOnline = (value: boolean) => {
    online = value;
    act(() => {
      window.dispatchEvent(new Event(value ? 'online' : 'offline'));
    });
  };

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
    online = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    __resetConnectivity(async () => online);
    __resetOutbox();
    vi.mocked(submitPty).mockResolvedValue(true);
    vi.mocked(hasLivePty).mockReturnValue(true);
  });

  afterEach(() => {
    __resetConnectivity();
    __resetOutbox();
  });

  it('holds it instead of typing it, empties the box, and says why in one line', async () => {
    render(<Composer taskId={1} onSent={vi.fn()} />);
    setOnline(false);
    expect(screen.getByText('You’re offline. Messages wait here and go when the connection is back.')).toBeTruthy();
    type('while the wifi is down');
    pressEnter();
    await waitFor(() => expect(box().value).toBe(''));
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(1).map((h) => h.text)).toEqual(['while the wifi is down']);
    // Held is not a draft: it cannot come back and be sent twice.
    expect(getDraft(1)).toBeNull();
  });

  it('holds what Claude Code will receive, pastes filled in', async () => {
    render(<Composer taskId={1} onSent={vi.fn()} />);
    setOnline(false);
    const log = 'a\nb\nc\nd\ne';
    fireEvent.paste(box(), {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], getData: () => log },
    });
    pressEnter();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual([log]));
  });

  it('keeps held messages across a task switch and a restart', async () => {
    const { rerender, unmount } = render(<Composer taskId={1} onSent={vi.fn()} />);
    setOnline(false);
    type('for A');
    pressEnter();
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    rerender(<Composer taskId={2} onSent={vi.fn()} />);
    rerender(<Composer taskId={1} onSent={vi.fn()} />);
    expect(heldFor(1).map((h) => h.text)).toEqual(['for A']);
    unmount();
    __resetOutbox(); // the restart: memory gone, storage kept
    expect(heldFor(1).map((h) => h.text)).toEqual(['for A']);
  });

  it('back online, a new message waits behind the held ones rather than overtaking them', async () => {
    render(<Composer taskId={1} onSent={vi.fn()} />);
    setOnline(false);
    type('first');
    pressEnter();
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    setOnline(true);
    type('second');
    pressEnter();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['first', 'second']));
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('holds a typed command like a message, behind what is held: the release sends it only into an idle session', async () => {
    holdMessage(1, 'already waiting');
    render(<Composer taskId={1} onSent={vi.fn()} />);
    type('/clear');
    pressEnter();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['already waiting', '/clear']));
    expect(box().value).toBe('');
    expect(getDraft(1)).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('marks review comments sent when their held message is delivered, after a switch away', async () => {
    const { insertIntoComposer } = await import('./composerBridge');
    const { markCommentsSent } = await import('../../db/comments');
    const stop = startOutboxRelease();
    const { rerender } = render(<Composer taskId={5} onSent={vi.fn()} />);
    setOnline(false);
    const onSent = vi.fn(() => true);
    act(() => {
      insertIntoComposer({ taskId: 5, text: 'Comment at a.ts:3', onSent, comments: [{ id: 7, marker: 'a.ts:3' }] });
    });
    pressEnter();
    await waitFor(() => expect(heldFor(5)).toEqual([expect.objectContaining({ commentIds: [7] })]));
    rerender(<Composer taskId={6} onSent={vi.fn()} />); // the watcher goes with the switch
    expect(markCommentsSent).not.toHaveBeenCalled();

    setOnline(true);
    await waitFor(() => expect(markCommentsSent).toHaveBeenCalledWith(5, [7]));
    expect(submitPty).toHaveBeenCalledWith(5, 'Comment at a.ts:3');
    expect(onSent).not.toHaveBeenCalled();
    stop();
  });

  it('never resends what already went to Claude Code before the outage', async () => {
    const stop = startOutboxRelease();
    render(<Composer taskId={1} onSent={vi.fn()} />);
    type('sent before anyone knew');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    setOnline(false);
    type('held');
    pressEnter();
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    setOnline(true);
    await waitFor(() => expect(heldFor(1)).toHaveLength(0));
    expect(vi.mocked(submitPty).mock.calls).toEqual([
      [1, 'sent before anyone knew'],
      [1, 'held'],
    ]);
    stop();
  });
});

// ---------------------------------------------------------------------------
// (s) a switch while a send is being written
// ---------------------------------------------------------------------------

describe('(s) switching task while a send is still being written', () => {
  let land: (ok: boolean) => void = () => {};
  beforeEach(() => {
    vi.mocked(hasLivePty).mockReturnValue(true);
    vi.mocked(startPty).mockReturnValue(false);
    vi.mocked(submitPty).mockImplementation(() => new Promise<boolean>((r) => (land = r)));
  });

  it('a send that succeeds after the switch leaves the new task’s draft intact', async () => {
    saveDraft(2, 'B, restored', new Map());
    const onSent = vi.fn();
    const { rerender } = render(<Composer taskId={1} onSent={onSent} />);
    type('for A');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    rerender(<Composer taskId={2} onSent={onSent} />);
    expect(box().value).toBe('B, restored');
    expect(getDraft(2)?.text).toBe('B, restored');

    await act(async () => land(true));
    expect(box().value).toBe('B, restored');
    expect(getDraft(2)?.text).toBe('B, restored');
    expect(getDraft(1)).toBeNull(); // sent: not a draft
    // The box is B's to use: a send from it is not blocked by A's.
    type('B, restored and sent');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(2));
  });

  it('a send that fails after the switch comes back as the old task’s draft, and the new one is intact', async () => {
    saveDraft(2, 'B, restored', new Map());
    const { rerender } = render(<Composer taskId={1} onSent={vi.fn()} />);
    type('for A');
    pressEnter();
    await waitFor(() => expect(submitPty).toHaveBeenCalledTimes(1));
    rerender(<Composer taskId={2} onSent={vi.fn()} />);

    await act(async () => land(false));
    expect(box().value).toBe('B, restored');
    expect(getDraft(2)?.text).toBe('B, restored');
    expect(screen.queryByText(/Could not|isn’t running/)).toBeNull();
    expect(getDraft(1)).toMatchObject({ text: 'for A', notSent: true });

    rerender(<Composer taskId={1} onSent={vi.fn()} />);
    expect(box().value).toBe('for A');
    expect(screen.getByText('Not sent — press Send when you’re ready.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (t) a running turn: the message waits in the outbox (#61)
// ---------------------------------------------------------------------------

describe('(t) during a running turn, a message waits in the outbox', () => {
  /** The transcript's facts for the task's session, as the watcher records them. */
  const fact = (taskId: number, op: 'prompt' | 'turn-end') =>
    recordQueueOperations([
      op === 'prompt'
        ? { op, sessionId: `s${taskId}`, text: 'p', ts: Date.now() - 1_000 }
        : { op, sessionId: `s${taskId}`, ts: Date.now() },
    ]);
  /** A live session whose transcript says a turn is running. */
  const turnRunning = (taskId: number) => {
    vi.mocked(hasLivePty).mockReturnValue(true);
    vi.mocked(ptyLiveSince).mockReturnValue(Date.now() - 60_000);
    noteTaskSessions([{ id: taskId, sessionId: `s${taskId}` }]);
    fact(taskId, 'prompt');
  };

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
    __resetConnectivity(async () => true);
    __resetOutbox();
    __resetTurns();
    seedQueue(['s1', 's2', 's5'], []);
    vi.mocked(submitPty).mockResolvedValue(true);
  });

  afterEach(() => {
    __resetTurns();
    __resetOutbox();
    __resetConnectivity();
    seedQueue(['s1', 's2', 's5'], []);
    vi.mocked(ptyLiveSince).mockReturnValue(null);
  });

  it('holds it instead of typing it, and empties the box without a notice: the band shows it', async () => {
    turnRunning(1);
    const onSent = vi.fn();
    render(<Composer taskId={1} status="running" onSent={onSent} />);
    type('also check the lint output');
    pressEnter();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['also check the lint output']));
    expect(box().value).toBe('');
    expect(getDraft(1)).toBeNull();
    expect(screen.queryByText(/asking you something|can’t wait/)).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled(); // no echo: the band shows it
  });

  it('holds a command too: typed into the turn it could land in a dialog', async () => {
    turnRunning(1);
    render(<Composer taskId={1} status="running" onSent={vi.fn()} />);
    type('/compact');
    pressEnter();
    await waitFor(() => expect(heldFor(1).map((h) => h.text)).toEqual(['/compact']));
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('a message held at a prompt joins the outbox when a turn is running by the time it is released, shown once', async () => {
    vi.mocked(hasLivePty).mockReturnValue(true);
    vi.mocked(ptyLiveSince).mockReturnValue(Date.now() - 60_000);
    noteTaskSessions([{ id: 5, sessionId: 's5' }]);
    const onSent = vi.fn();
    const { rerender } = render(<Composer taskId={5} status="blocked" onSent={onSent} />);
    type('after the answer');
    pressEnter();
    await waitFor(() => expect(screen.getByText(/asking you something/)).toBeTruthy());
    fact(5, 'prompt'); // answered: the turn goes on
    await act(async () => {
      rerender(<Composer taskId={5} status="running" onSent={onSent} />);
    });
    await waitFor(() => expect(heldFor(5).map((h) => h.text)).toEqual(['after the answer']));
    // In the band only: not echoed as sent, not left in the box, no notice.
    expect(onSent).not.toHaveBeenCalled();
    expect(box().value).toBe('');
    expect(box().readOnly).toBe(false);
    expect(screen.queryByText(/asking you something/)).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('keeps it across a task switch and a restart', async () => {
    turnRunning(1);
    const { rerender, unmount } = render(<Composer taskId={1} status="running" onSent={vi.fn()} />);
    type('for A');
    pressEnter();
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    rerender(<Composer taskId={2} status="idle" onSent={vi.fn()} />);
    rerender(<Composer taskId={1} status="running" onSent={vi.fn()} />);
    expect(heldFor(1).map((h) => h.text)).toEqual(['for A']);
    unmount();
    __resetOutbox(); // the restart: memory gone, storage kept
    expect(heldFor(1).map((h) => h.text)).toEqual(['for A']);
  });

  it('sends it once when the turn ends, and never twice', async () => {
    const stop = startOutboxRelease();
    turnRunning(1);
    render(<Composer taskId={1} status="running" onSent={vi.fn()} />);
    type('when you are done');
    pressEnter();
    await waitFor(() => expect(heldFor(1)).toHaveLength(1));
    act(() => fact(1, 'turn-end'));
    await waitFor(() => expect(heldFor(1)).toHaveLength(0));
    act(() => fact(1, 'turn-end'));
    term.__emitPresence(1, true);
    expect(vi.mocked(submitPty).mock.calls).toEqual([[1, 'when you are done']]);
    stop();
  });
});
