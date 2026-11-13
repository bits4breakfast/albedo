/**
 * @vitest-environment jsdom
 *
 * Commands sent from buttons show at once (#384): the echo's store, when each
 * kind of command lands, a running `/compact`, the no-reply state, and the
 * pane and the message box drawing them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message, Task } from '../../types';

const h = vi.hoisted(() => ({
  presence: new Set<(id: number, live: boolean) => void>(),
  captures: new Set<(u: { sessionId: string }) => void>(),
  window: [] as Message[],
  since: [] as Message[],
  sinceCalls: [] as [number, string | null, number][],
}));

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  usePtyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: (cb: (id: number, live: boolean) => void) => {
    h.presence.add(cb);
    return () => void h.presence.delete(cb);
  },
}));
vi.mock('../BackgroundWork', () => ({ useBackgroundWork: () => [], backgroundShown: () => [] }));
vi.mock('./OverlayScrollbar', () => ({ default: () => null }));
vi.mock('../../capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture')>()),
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.captures.add(cb);
    return () => void h.captures.delete(cb);
  },
}));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: vi.fn(async () => h.window),
  mainRowsSince: vi.fn(async (taskId: number, sessionId: string | null, since: number) => {
    h.sinceCalls.push([taskId, sessionId, since]);
    return h.since;
  }),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));

const { parseTranscript } = await import('../../capture/adapter');
const echo = await import('./commandEcho');
const { sendToSession, submitLocked } = await import('./send');
const { CommandEchoRow, commandEchoMeta } = await import('./CommandEchoRow');
const { TranscriptPane } = await import('./TranscriptPane');
const { ContextClear, commandBlocker, COMPACTING_HINT } = await import('../ClearContextButton');
const { SEND_FROM } = await import('./sendFrom');

const { COMMAND_ECHO_MAX_MS, COMPACT_MAX_MS, commandEchoFor, commandLanded, isCompacting, __resetCommandEchoes, __setCommandEcho } =
  echo;

const SENT = Date.parse('2026-11-13T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Rows as capture stores them, from the lines Claude Code writes. */
function rows(lines: Record<string, unknown>[], sessionId = 's1', taskId: number | null = 1): Message[] {
  const text = lines.map((l, i) => JSON.stringify({ sessionId, uuid: `u-${sessionId}-${i}`, ...l })).join('\n');
  return parseTranscript(text).map((r, i) => ({ ...r, id: i + 1, taskId }));
}

const userLine = (content: string, ms: number, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  timestamp: iso(ms),
  ...extra,
});
const envelope = (name: string, args: string) =>
  `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`;
const localCommand = (content: string, ms: number) => ({
  type: 'system',
  subtype: 'local_command',
  content,
  level: 'info',
  timestamp: iso(ms),
  isMeta: false,
});
const boundary = (ms: number, trigger = 'manual') => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  timestamp: iso(ms),
  compactMetadata: { trigger, preTokens: 148_000, durationMs: 83_000 },
});

const task = { id: 1, status: 'idle', sessionId: 's1' } as Task;

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
  h.window = [];
  h.since = [];
  h.sinceCalls = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetCommandEchoes();
});

describe('what echoes', () => {
  it('a command a button sent, at once, naming the button', async () => {
    expect(await sendToSession(1, '/model sonnet', SEND_FROM.model)).toBe('sent');
    expect(commandEchoFor(1)).toMatchObject({ text: '/model sonnet', from: 'the model picker', compact: false, noReply: false });
  });

  it.each([
    ['/compact', SEND_FROM.compact, 'Compact Now'],
    ['/clear', SEND_FROM.clear, 'Clear'],
    ['/model opus', SEND_FROM.model, 'the model picker'],
    ['/remote-control', SEND_FROM.remote, 'Remote Control'],
    ['/rename Tidy the retry helper', SEND_FROM.rename, 'Rename'],
  ])('%s says "from %s"', async (text, from, words) => {
    await sendToSession(1, text, from);
    expect(commandEchoMeta(commandEchoFor(1)!)).toMatch(new RegExp(`^from ${words}`));
  });

  it('nothing for a message, or a command no button named: the pane echoes those itself', async () => {
    await sendToSession(1, 'please fix the test');
    await submitLocked(1, '/model opus');
    expect(commandEchoFor(1)).toBeNull();
  });

  it('a /compact however Albedo sent it, since only the echo says it is running', async () => {
    await submitLocked(1, '/compact keep the test plan');
    expect(commandEchoFor(1)).toMatchObject({ from: null, compact: true });
    expect(isCompacting(1)).toBe(true);
    expect(commandEchoMeta(commandEchoFor(1)!)).toBe('');
  });

  it('nothing when the write failed', async () => {
    const { submitPty } = await import('../Terminal');
    vi.mocked(submitPty).mockResolvedValueOnce(false);
    expect(await sendToSession(1, '/model opus', SEND_FROM.model)).toBe('failed');
    expect(commandEchoFor(1)).toBeNull();
  });
});

describe('when a command lands', () => {
  const at = SENT;
  it('/model: its `user` envelope row', () => {
    expect(commandLanded({ at, compact: false }, rows([userLine(envelope('/model', 'sonnet'), at + 300)]))).toBe(true);
  });

  it('/rename and /remote-control: the `system` local-command line', () => {
    const r = rows([localCommand(envelope('/rename', 'Tidy'), at + 200), localCommand('<local-command-stdout>Session renamed to: Tidy</local-command-stdout>', at + 200)]);
    expect(commandLanded({ at, compact: false }, r)).toBe(true);
  });

  it('/clear: the first row of the new session, which the pane draws as "Context cleared"', () => {
    const r = rows([userLine(envelope('/clear', ''), at + 400)], 's2');
    expect(commandLanded({ at, compact: false }, r)).toBe(true);
  });

  it('never on a row from before the send, or a subagent’s', () => {
    expect(commandLanded({ at, compact: false }, rows([userLine(envelope('/model', 'sonnet'), at - 5_000)]))).toBe(false);
    const sub = rows([userLine('look at this', at + 300)]).map((m) => ({ ...m, agentId: 'agent-1' }));
    expect(commandLanded({ at, compact: false }, sub)).toBe(false);
  });

  it('/compact: on the compaction written after the send, not on its envelope stamped at the start', () => {
    const start = rows([userLine(envelope('/compact', ''), at + 50)]);
    expect(commandLanded({ at, compact: true }, start)).toBe(false);
    // An earlier compaction, from before this send, is not this one.
    expect(commandLanded({ at, compact: true }, rows([boundary(at - 60_000, 'auto')]))).toBe(false);
    expect(commandLanded({ at, compact: true }, rows([boundary(at + 83_000)]))).toBe(true);
  });

  it('/compact: or on the line that closes the command, should it end without compacting', () => {
    const done = rows([userLine('<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>', at + 83_100)]);
    expect(commandLanded({ at, compact: true }, done)).toBe(true);
  });

  it('a task not on screen: the store reads the rows since the send on a capture update', async () => {
    await sendToSession(1, '/compact', SEND_FROM.compact);
    const sent = commandEchoFor(1)!.at;
    act(() => {
      for (const cb of [...h.captures]) cb({ sessionId: 's1' });
    });
    await waitFor(() => expect(h.sinceCalls.length).toBeGreaterThan(0));
    expect(h.sinceCalls[0]![2]).toBe(sent - 1_000);
    expect(isCompacting(1)).toBe(true);

    h.since = rows([boundary(sent + 80_000)]);
    act(() => {
      for (const cb of [...h.captures]) cb({ sessionId: 's1' });
    });
    await waitFor(() => expect(commandEchoFor(1)).toBeNull());
    expect(isCompacting(1)).toBe(false);
  });

  it('ends with the task’s pty', async () => {
    await sendToSession(1, '/compact', SEND_FROM.compact);
    act(() => {
      for (const cb of [...h.presence]) cb(1, false);
    });
    expect(commandEchoFor(1)).toBeNull();
  });
});

describe('a command that never lands', () => {
  it('says so after 30 s, and stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await sendToSession(1, '/remote-control', SEND_FROM.remote);
    vi.advanceTimersByTime(COMMAND_ECHO_MAX_MS - 1);
    expect(commandEchoFor(1)?.noReply).toBe(false);
    vi.advanceTimersByTime(1);
    expect(commandEchoFor(1)?.noReply).toBe(true);
    expect(commandEchoMeta(commandEchoFor(1)!)).toBe('from Remote Control · no reply from the session · see the terminal');
    vi.advanceTimersByTime(60 * 60_000);
    expect(commandEchoFor(1)).not.toBeNull();
  });

  it('/compact has no 30 s limit: ten minutes, then it is no longer compacting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await sendToSession(1, '/compact', SEND_FROM.compact);
    vi.advanceTimersByTime(COMMAND_ECHO_MAX_MS * 4);
    expect(isCompacting(1)).toBe(true);
    vi.advanceTimersByTime(COMPACT_MAX_MS - COMMAND_ECHO_MAX_MS * 4);
    expect(isCompacting(1)).toBe(false);
    expect(commandEchoFor(1)).toMatchObject({ compact: true, noReply: true });
  });

  it('a later message ends a row with no reply, not one still on its way', async () => {
    await sendToSession(1, '/compact', SEND_FROM.compact);
    await sendToSession(1, 'and then this');
    expect(isCompacting(1)).toBe(true);
    __setCommandEcho(1, { ...commandEchoFor(1)!, noReply: true });
    await sendToSession(1, 'are you there?');
    expect(commandEchoFor(1)).toBeNull();
  });
});

describe('the row', () => {
  it('a short command: "You", the command, the button, sending…', () => {
    render(<CommandEchoRow echo={{ text: '/model sonnet', from: 'the model picker', at: Date.now(), compact: false, noReply: false }} />);
    const row = document.querySelector('.tx-row-command-echo')!;
    expect(row.querySelector('.tx-gutter')?.textContent).toBe('You');
    expect(row.querySelector('.tx-echo-command')?.textContent).toBe('/model sonnet');
    expect(row.querySelector('.tx-echo-meta')?.textContent).toBe('from the model picker · sending…');
    expect(row.querySelector('[data-no-reply]')).toBeNull();
  });

  it('a running /compact counts up under it, past 30 s', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(SENT);
    render(<CommandEchoRow echo={{ text: '/compact', from: 'Compact Now', at: SENT, compact: true, noReply: false }} />);
    expect(screen.getByRole('status').textContent).toBe('Compacting context… 0s');
    expect(document.querySelector('.tx-echo-meta')?.textContent).toBe('from Compact Now');
    act(() => void vi.advanceTimersByTime(21_000));
    expect(screen.getByRole('status').textContent).toBe('Compacting context… 21s');
    act(() => void vi.advanceTimersByTime(62_000));
    expect(screen.getByRole('status').textContent).toBe('Compacting context… 1m 23s');
  });

  it('no reply: the meta in the warning colour, and the clock gone', () => {
    render(<CommandEchoRow echo={{ text: '/compact', from: 'Compact Now', at: SENT, compact: true, noReply: true }} />);
    const meta = document.querySelector('.tx-echo-meta')!;
    expect(meta.hasAttribute('data-no-reply')).toBe(true);
    expect(meta.textContent).toBe('from Compact Now · no reply from the session · see the terminal');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('in the pane', () => {
  const pane = () => render(<TranscriptPane taskId={1} sessionId="s1" />);
  const ready = () => waitFor(() => expect(document.querySelector('.tx-composer')).toBeTruthy());

  it('shows a button’s command at once, and no "Sending" working line for it', async () => {
    pane();
    await ready();
    await act(async () => void (await sendToSession(1, '/model sonnet', SEND_FROM.model)));
    expect(document.querySelector('.tx-row-command-echo .tx-echo-command')?.textContent).toBe('/model sonnet');
    expect(document.querySelector('.tx-row-working')).toBeNull();
  });

  it('goes as soon as the rows on screen have the command: never shown twice', async () => {
    __setCommandEcho(1, { text: '/model sonnet', from: 'the model picker', at: SENT, compact: false, noReply: false });
    h.window = rows([userLine(envelope('/model', 'sonnet'), SENT + 300)]);
    pane();
    await waitFor(() => expect(document.querySelector('.tx-cmd-name')?.textContent).toBe('/model'));
    await waitFor(() => expect(document.querySelector('.tx-row-command-echo')).toBeNull());
    expect(commandEchoFor(1)).toBeNull();
  });

  it('a /compact stays while only its envelope is there, and goes with the compaction', async () => {
    __setCommandEcho(1, { text: '/compact', from: 'Compact Now', at: SENT, compact: true, noReply: false });
    h.window = rows([userLine('So the fix is just the label.', SENT - 60_000), userLine(envelope('/compact', ''), SENT + 20)]);
    pane();
    await waitFor(() => expect(document.querySelector('.tx-cmd-name')?.textContent).toBe('/compact'));
    expect(document.querySelector('.tx-row-command-echo')).not.toBeNull();
    cleanup();

    h.window = rows([boundary(SENT + 83_000), userLine(envelope('/compact', ''), SENT + 20)]);
    pane();
    await waitFor(() => expect(document.querySelector('.tx-row-command-echo')).toBeNull());
    expect(isCompacting(1)).toBe(false);
  });

  it('only this task’s rows count', async () => {
    __setCommandEcho(1, { text: '/model sonnet', from: 'the model picker', at: SENT, compact: false, noReply: false });
    h.window = rows([userLine(envelope('/model', 'sonnet'), SENT + 300)], 's9', 9);
    pane();
    await ready();
    await waitFor(() => expect(document.querySelector('.tx-cmd-name')).not.toBeNull());
    expect(document.querySelector('.tx-row-command-echo')).not.toBeNull();
  });
});

describe('while a /compact runs', () => {
  it('Compact Now and Clear stand down, saying "Compacting now"', () => {
    expect(COMPACTING_HINT).toBe('Compacting now');
    expect(commandBlocker(true, 'idle', false, true)).toBe('Compacting now');
    // A dead session still says so first.
    expect(commandBlocker(false, 'idle', false, true)).toBe('No session is running for this task.');
    expect(commandBlocker(true, 'idle', false, false)).toBeNull();
  });

  it('the message box reads "Compacting…", at any fill, with both buttons disabled', () => {
    __setCommandEcho(1, { text: '/compact', from: 'Compact Now', at: Date.now(), compact: true, noReply: false });
    render(<ContextClear task={task} usage={null} />);
    expect(document.querySelector('.ctx-clear-reading')?.textContent).toBe('Compacting…');
    for (const name of ['Compact Now', 'Clear']) {
      const b = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe('Compacting now');
    }
  });

  it('back to the reading once it has compacted', () => {
    __setCommandEcho(1, { text: '/compact', from: 'Compact Now', at: Date.now(), compact: true, noReply: false });
    render(<ContextClear task={task} usage={null} />);
    act(() => __setCommandEcho(1, null));
    expect(document.querySelector('.ctx-clear')).toBeNull();
  });
});

describe('the buttons label what they send', () => {
  it('Compact Now and Clear beside the message box', async () => {
    const usage = { used: 800_000, limit: 1_000_000, fraction: 0.8, limitBasis: 'known' as const, model: 'm', at: 0 };
    render(<ContextClear task={task} usage={usage} />);
    fireEvent.click(screen.getByRole('button', { name: 'Compact Now' }));
    await waitFor(() => expect(commandEchoFor(1)).toMatchObject({ text: '/compact', from: 'Compact Now' }));
    act(() => __setCommandEcho(1, null));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Context?' }));
    await waitFor(() => expect(commandEchoFor(1)).toMatchObject({ text: '/clear', from: 'Clear' }));
  });
});

describe('typed in the message box', () => {
  it('a /compact shows once, as running, not also as a message "sending"', async () => {
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '/compact' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(commandEchoFor(1)).toMatchObject({ text: '/compact', from: null, compact: true }));
    await waitFor(() => expect(document.querySelectorAll('.tx-row-echo')).toHaveLength(1));
    expect(document.querySelector('.tx-row-command-echo')).not.toBeNull();
    expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/^Compacting context…/);
  });

  it('a message still gets the box’s own echo, as before', async () => {
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'fix the label' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.tx-echo-text')?.textContent).toBe('fix the label'));
    expect(document.querySelector('.tx-row-command-echo')).toBeNull();
    expect(commandEchoFor(1)).toBeNull();
  });
});

describe('released from the outbox', () => {
  it('a held /compact shows once, as running; a held message keeps the box’s echo', async () => {
    const { holdMessage, sendHeldNow, __resetOutbox } = await import('./outbox');
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    await screen.findByRole('textbox');

    const compact = holdMessage(1, '/compact')!;
    await act(async () => void (await sendHeldNow(1, compact.id, (t) => submitLocked(1, t))));
    expect(commandEchoFor(1)).toMatchObject({ text: '/compact', from: null, compact: true });
    expect(document.querySelectorAll('.tx-row-echo')).toHaveLength(1);
    expect(document.querySelector('.tx-row-command-echo')).not.toBeNull();

    act(() => __setCommandEcho(1, null));
    const message = holdMessage(1, 'after the compaction')!;
    await act(async () => void (await sendHeldNow(1, message.id, (t) => submitLocked(1, t))));
    expect(document.querySelector('.tx-echo-text')?.textContent).toBe('after the compaction');
    expect(document.querySelector('.tx-row-command-echo')).toBeNull();
    __resetOutbox();
  });
});

describe('after /clear, on a task not on screen', () => {
  it('reads again when the task moves to the new session, whose row was read before it was linked', async () => {
    const { noteTaskSessions, __resetTurns } = await import('./turn');
    noteTaskSessions([{ id: 1, sessionId: 's1' }]);
    await sendToSession(1, '/clear', SEND_FROM.clear);
    const sent = commandEchoFor(1)!.at;
    h.since = rows([userLine(envelope('/clear', ''), sent + 300)], 's2', null);
    act(() => noteTaskSessions([{ id: 1, sessionId: 's2' }]));
    await waitFor(() => expect(commandEchoFor(1)).toBeNull());
    expect(h.sinceCalls.at(-1)?.[1]).toBe('s2');
    __resetTurns();
  });
});
