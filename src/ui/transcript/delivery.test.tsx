/**
 * @vitest-environment jsdom
 *
 * A message written to the pty that never reaches the transcript is not
 * delivered (#433): it comes back to the head of the outbox, marked so, and
 * nothing else goes to the task until the person acts on it. A message that
 * lands -- as a prompt row, in Claude Code's queue, or slowly but within the
 * timeout -- is left alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '../../types';

const h = vi.hoisted(() => ({
  captures: new Set<(u: { sessionId: string }) => void>(),
  since: [] as Message[],
  fail: false,
}));

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  usePtyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: () => () => {},
}));
vi.mock('../../capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture')>()),
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.captures.add(cb);
    return () => void h.captures.delete(cb);
  },
}));
vi.mock('../BackgroundWork', () => ({ useBackgroundWork: () => [], backgroundShown: () => [] }));
vi.mock('./OverlayScrollbar', () => ({ default: () => null }));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: vi.fn(async () => []),
  mainRowsSince: vi.fn(async (_taskId: number, _sessionId: string | null, since: number) => {
    if (h.fail) throw new Error('database is locked');
    return h.since.filter((m) => m.ts >= since);
  }),
}));

const { parseTranscript } = await import('../../capture/adapter');
const { recordQueueOperations, seedQueue } = await import('../../capture/queue');
const { submitPty, ptyLiveSince } = await import('../Terminal');
const delivery = await import('./delivery');
const { DELIVERY_TIMEOUT_MS, LATE_LANDING_MS, NOT_DELIVERED, expectedFor, onNotDelivered, startDeliveryWatch, __resetDelivery } = delivery;
const { mustHold, sendToSession, submitLocked } = await import('./send');
const { __resetOutbox, heldFor, holdMessage, nextRun, outboxCodec, releaseHeld, sendAnyway } = await import('./outbox');
const { __resetTurns, noteTaskSessions } = await import('./turn');
const { __resetConnectivity } = await import('../../lib/connectivity');
const { QueuedStrip } = await import('./QueuedStrip');
const { TranscriptPane } = await import('./TranscriptPane');
const { NOT_DELIVERED_NOTICE } = await import('./Composer');

const T = Date.parse('2026-11-17T09:00:00.000Z');
const SPAWNED = T - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function userRow(content: string, ms: number): Message {
  const line = JSON.stringify({ type: 'user', sessionId: 's1', uuid: `u-${ms}`, message: { role: 'user', content }, timestamp: iso(ms) });
  return { ...parseTranscript(line)[0]!, id: ms, taskId: 1 };
}

/** The watcher read new lines of the task's session. */
function captured(): void {
  for (const cb of [...h.captures]) cb({ sessionId: 's1' });
}

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
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  __resetConnectivity(async () => true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T);
  h.since = [];
  h.fail = false;
  vi.mocked(ptyLiveSince).mockReturnValue(SPAWNED);
  vi.mocked(submitPty).mockClear();
  __resetOutbox();
  noteTaskSessions([{ id: 1, sessionId: 's1' }]);
  startDeliveryWatch();
});

afterEach(() => {
  cleanup();
  seedQueue(['s1'], []);
  __resetDelivery();
  __resetTurns();
  __resetOutbox();
  __resetConnectivity();
  vi.useRealTimers();
});

describe('a message that never reaches the transcript', () => {
  it('is held at the head of the outbox as not delivered, and the box and the pane are told', async () => {
    const told: string[] = [];
    onNotDelivered((e) => told.push(e.text));
    expect(await submitLocked(1, 'please rerun the linter')).toBe(true);

    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS - 1);
    expect(heldFor(1)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(heldFor(1)).toMatchObject([{ text: 'please rerun the linter', maybeSent: true, notDelivered: true }]);
    expect(told).toEqual(['please rerun the linter']);
  });

  it('goes ahead of anything held since, and nothing is sent to the task until the person acts', async () => {
    await submitLocked(1, 'try again');
    expect(vi.mocked(submitPty)).toHaveBeenCalledTimes(1);
    // Sent meanwhile: held behind the submit's turn grace.
    expect(await sendToSession(1, 'and also this')).toBe('held');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);

    expect(heldFor(1).map((m) => [m.text, m.notDelivered === true])).toEqual([
      ['try again', true],
      ['and also this', false],
    ]);
    // Well past turn.ts's grace: still nothing goes, from any path.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mustHold(1)).toBe(true);
    expect(nextRun(heldFor(1))).toEqual([]);
    expect(await releaseHeld(1, (text) => submitLocked(1, text))).toBe(0);
    expect(await sendToSession(1, 'a third one')).toBe('held');
    expect(vi.mocked(submitPty)).toHaveBeenCalledTimes(1);

    // Send on the row: the person cleared the terminal and sends it again.
    sendAnyway(1, heldFor(1)[0]!.id);
    expect(heldFor(1)[0]).not.toHaveProperty('notDelivered');
    expect(nextRun(heldFor(1)).map((m) => m.text)).toEqual(['try again', 'and also this', 'a third one']);
  });

  it('from the outbox: the released message comes back, not lost', async () => {
    holdMessage(1, 'run the migrations', T);
    expect(await releaseHeld(1, (text) => submitLocked(1, text))).toBe(1);
    expect(heldFor(1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toMatchObject([{ text: 'run the migrations', notDelivered: true }]);
  });

  it('stays marked across a restart: the stored outbox keeps the mark', async () => {
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    const back = outboxCodec.decode(outboxCodec.encode(new Map([[1, heldFor(1)]]))!);
    expect(back?.get(1)).toMatchObject([{ text: 'please rerun the linter', maybeSent: true, notDelivered: true }]);
    // A mark of the wrong type is a malformed entry, dropped as any other.
    expect(outboxCodec.decode(JSON.stringify({ 1: [{ id: 'a', text: 'x', heldAt: 1, notDelivered: 'yes' }] }))?.get(1)).toBeUndefined();
  });

  it('the band says so on the row, with Send', async () => {
    await submitLocked(1, 'look at the flaky test');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    render(<QueuedStrip sessionId="s1" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByText(NOT_DELIVERED)).toBeTruthy();
    expect(screen.queryByText('May already have been sent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

describe('on screen', () => {
  it('the message box says so, and the pane\u2019s "Sending" echo gives way to the held row', async () => {
    render(<TranscriptPane taskId={1} sessionId="s1" />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'tidy the retry helper' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(box.value).toBe('');
    expect(document.querySelector('.tx-echo-text')?.textContent).toBe('tidy the retry helper');

    await act(async () => void (await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS)));
    expect(screen.getByText(NOT_DELIVERED_NOTICE)).toBeTruthy();
    expect(document.querySelector('.tx-echo-text')).toBeNull();
    expect(screen.getByText(NOT_DELIVERED)).toBeTruthy();
    expect(heldFor(1)).toMatchObject([{ text: 'tidy the retry helper', notDelivered: true }]);
  });
});

describe('a message that lands', () => {
  it('as a prompt row: nothing is held', async () => {
    await submitLocked(1, 'please rerun the linter');
    h.since = [userRow('please rerun the linter', T + 300)];
    act(captured);
    await vi.advanceTimersByTimeAsync(0);
    expect(expectedFor(1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('as a prompt row read only at the timeout: nothing is held', async () => {
    await submitLocked(1, 'please rerun the linter');
    h.since = [userRow('please rerun the linter', T + 300)];
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('queued, sent while Claude Code was busy: its enqueue is enough', async () => {
    await submitLocked(1, 'and check the docs too');
    recordQueueOperations([{ op: 'enqueue', sessionId: 's1', text: 'and check the docs too', ts: T + 200 }]);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('queued and taken in one read, with no row of its own: the dequeue is enough', async () => {
    await submitLocked(1, 'and check the docs too');
    recordQueueOperations([
      { op: 'enqueue', sessionId: 's1', text: 'and check the docs too', ts: T + 200 },
      { op: 'dequeue', sessionId: 's1', ts: T + 900 },
    ]);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('slowly, but within the timeout: nothing is held, and nothing said', async () => {
    const told: string[] = [];
    onNotDelivered((e) => told.push(e.text));
    await submitLocked(1, 'please rerun the linter');
    // A session still starting, or a busy machine: 15 s before the row.
    await vi.advanceTimersByTimeAsync(15_000);
    h.since = [userRow('please rerun the linter', Date.now())];
    act(captured);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(told).toEqual([]);
    expect(heldFor(1)).toHaveLength(0);
    expect(expectedFor(1)).toHaveLength(0);
  });

  it('a row from before the send is not it', async () => {
    h.since = [userRow('an older prompt', T - 2_000)];
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(1);
  });

  it('late, after it was said to be undelivered: it leaves the outbox again', async () => {
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(1);
    // Enter pressed in the terminal: Claude Code takes what sat in its box.
    h.since = [userRow('[200~please rerun the linter', Date.now())];
    act(captured);
    await vi.advanceTimersByTimeAsync(0);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('late, but a different prompt: the held one stays for the person', async () => {
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    h.since = [userRow('something typed in the terminal', Date.now())];
    act(captured);
    await vi.advanceTimersByTimeAsync(0);
    expect(heldFor(1)).toHaveLength(1);
    // And it is no longer looked for once that window is over.
    await vi.advanceTimersByTimeAsync(LATE_LANDING_MS);
    expect(expectedFor(1)).toHaveLength(0);
    expect(heldFor(1)).toHaveLength(1);
  });
});

describe('what is not watched, or cannot be told', () => {
  it('a slash command: its echo says when nothing came back', async () => {
    await submitLocked(1, '/compact');
    expect(expectedFor(1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('a write that failed: the sender already keeps the text', async () => {
    vi.mocked(submitPty).mockResolvedValueOnce(false);
    expect(await submitLocked(1, 'please rerun the linter')).toBe(false);
    expect(expectedFor(1)).toHaveLength(0);
  });

  it('a transcript that cannot be read: unknown says nothing', async () => {
    h.fail = true;
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });
});
