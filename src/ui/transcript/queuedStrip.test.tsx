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
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

const { QueuedStrip } = await import('./TranscriptPane');
const { __resetOutbox, heldFor, holdMessage, releaseHeld } = await import('./outbox');
const { __resetConnectivity } = await import('../../lib/connectivity');
const { hasLivePty, ptyLiveSince, submitPty } = await import('../Terminal');
const { __resetTurns, noteTaskSessions } = await import('./turn');
const { recordQueueOperations, seedQueue } = await import('../../capture/queue');
const { markPastes, placeholderFor } = await import('./pastedText');

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

/** A live session whose transcript says a turn is running. */
function turnRunning(): void {
  vi.mocked(hasLivePty).mockReturnValue(true);
  vi.mocked(ptyLiveSince).mockReturnValue(SPAWNED);
  noteTaskSessions([{ id: 1, sessionId: 's' }]);
  recordQueueOperations([{ op: 'prompt', sessionId: 's', text: 'p', ts: T }]);
}

afterEach(() => {
  seedQueue(['s'], []);
  cleanup();
  __resetConnectivity();
  __resetOutbox();
  __resetTurns();
  vi.mocked(ptyLiveSince).mockReturnValue(null);
  vi.mocked(hasLivePty).mockReturnValue(false);
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

  it('held for a running turn: Queued, sent when the turn ends, and still editable and removable', () => {
    turnRunning();
    holdMessage(1, 'also check the lint output');
    holdMessage(1, 'and update the docs');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    const band = screen.getByRole('status');
    expect(band.textContent).toMatch(/^Queued 2sent when Claude finishes this turn/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(heldFor(1).map((h) => h.text)).toEqual(['and update the docs']);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit held message' });
    fireEvent.change(field, { target: { value: 'and update the README' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(heldFor(1).map((h) => h.text)).toEqual(['and update the README']);
  });

  it('change their head when the turn ends', () => {
    turnRunning();
    holdMessage(1, 'next');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByText('sent when Claude finishes this turn')).toBeTruthy();
    act(() => recordQueueOperations([{ op: 'turn-end', sessionId: 's', ts: T + 1 }]));
    expect(screen.queryByText('sent when Claude finishes this turn')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/^Sending 1/);
  });

  it('offer Send Now while only the turn holds them, usable with a live session', async () => {
    turnRunning();
    holdMessage(1, 'now, please');
    const { rerender } = render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    const button = screen.getByRole('button', { name: 'Send Now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    vi.mocked(hasLivePty).mockReturnValue(false);
    rerender(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect((screen.getByRole('button', { name: 'Send Now' }) as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(hasLivePty).mockReturnValue(true);
    rerender(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send Now' }));
    });
    expect(submitPty).toHaveBeenCalledWith(1, 'now, please');
    expect(heldFor(1)).toEqual([]);
  });

  it('never offer Send Now on a command: it only goes into an idle session', () => {
    turnRunning();
    holdMessage(1, '/compact');
    holdMessage(1, 'a message');
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getAllByRole('button', { name: 'Send Now' })).toHaveLength(1);
  });

  it('say so briefly when Send Now could not go: a release had the lock', async () => {
    vi.mocked(submitPty).mockClear();
    turnRunning();
    holdMessage(1, 'being written');
    holdMessage(1, 'now, please');
    let finish: (ok: boolean) => void = () => {};
    // A release under way, its write still in flight.
    const release = releaseHeld(1, () => new Promise<boolean>((r) => (finish = r)));
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    const buttons = screen.getAllByRole('button', { name: 'Send Now' });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]!);
    });
    expect(screen.getByText('Couldn\u2019t send now — try again')).toBeTruthy();
    expect(submitPty).not.toHaveBeenCalled();
    finish(false);
    await act(async () => {
      await release;
    });
  });

  it('do not offer Send Now when the connection, not the turn, holds them', () => {
    holdMessage(1, 'offline');
    online = false;
    window.dispatchEvent(new Event('offline'));
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.queryByRole('button', { name: 'Send Now' })).toBeNull();
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

describe('a paste from the message box (#155)', () => {
  const log = Array.from({ length: 42 }, (_, i) => `step ${i + 1}: ok`).join('\n');
  const body = markPastes(`why does this fail?\n${placeholderFor(1, log)}`, new Map([[1, log]]));

  it("reads as its mention in Claude Code's queue, never as tags or forty lines", () => {
    queue.entries = [{ text: body, ts: T, injected: false }];
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    const band = screen.getByRole('status');
    expect(band.textContent).toContain('why does this fail?\n[Pasted text · 42 lines]');
    expect(band.textContent).not.toContain('pasted-text');
    expect(band.textContent).not.toContain('step 42');
    expect(band.querySelector('.tx-queued-item')?.getAttribute('title')).toBe('why does this fail?\n[Pasted text · 42 lines]');
  });

  it('held: reads as its mention, edits as the box shows it, and keeps its marker on save', () => {
    turnRunning();
    holdMessage(1, body);
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByRole('status').textContent).toContain('[Pasted text · 42 lines]');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit held message' }) as HTMLTextAreaElement;
    expect(field.value).toBe(`why does this fail?\n${placeholderFor(1, log)}`);
    fireEvent.change(field, { target: { value: `why does this still fail?\n${placeholderFor(1, log)}` } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(heldFor(1).map((h) => h.text)).toEqual([markPastes(`why does this still fail?\n${placeholderFor(1, log)}`, new Map([[1, log]]))]);
  });

  it('held: saving it unchanged leaves it as it was', () => {
    turnRunning();
    // Its marker id is not the one a fresh token would get.
    const seven = markPastes(placeholderFor(7, log), new Map([[7, log]]));
    holdMessage(1, seven);
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit held message' }), { key: 'Enter' });
    expect(heldFor(1).map((h) => h.text)).toEqual([seven]);
  });
});

describe('references from the message box (#154)', () => {
  const fix = {
    kind: 'task' as const,
    label: '@Fix login retry',
    title: 'Fix login retry',
    taskId: 2,
    session: 'Fix login retry',
    sessionId: 'sid-2',
    worktree: '/code/wt/2',
    transcript: null,
  };
  const marked = async () => {
    const { encodeMention, fileMention } = await import('./mentions');
    return `ask ${encodeMention(fix)} about ${encodeMention(fileMention('src/a.ts'))}`;
  };

  it("read as @Title and @path in Claude Code's queue, never as tags", async () => {
    queue.entries = [{ text: await marked(), ts: T, injected: false }];
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    const band = screen.getByRole('status');
    expect(band.textContent).toContain('ask @Fix login retry about @src/a.ts');
    expect(band.textContent).not.toContain('-ref');
  });

  it('held: edits as tokens, and keeps its markers on save', async () => {
    turnRunning();
    const body = await marked();
    holdMessage(1, body);
    render(<QueuedStrip sessionId="s" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByRole('status').textContent).toContain('ask @Fix login retry about @src/a.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit held message' }) as HTMLTextAreaElement;
    expect(field.value).toBe('ask @[Fix login retry] about @src/a.ts');
    fireEvent.change(field, { target: { value: 'please ask @[Fix login retry] about @src/a.ts' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(heldFor(1).map((h) => h.text)).toEqual([`please ${body}`]);
  });
});
