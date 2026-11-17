/**
 * @vitest-environment jsdom
 *
 * A message written to the pty that never reaches the transcript is not
 * delivered (#433): it comes back to the head of the outbox, marked so, with
 * its comments unmarked, and nothing else goes to the task until the person
 * acts on it. A message that lands -- as a prompt row, in Claude Code's
 * queue, or slowly but within the timeout -- is left alone, and so is one
 * the watcher has not caught up with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '../../types';

const h = vi.hoisted(() => ({
  captures: new Set<(u: { sessionId: string }) => void>(),
  rows: [] as Message[],
  fail: false,
  behind: false,
  unmarked: [] as [number, number[]][],
  marked: [] as [number, number[]][],
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
vi.mock('../BackgroundWork', () => ({ useBackgroundWork: () => [], backgroundShown: () => [] }));
vi.mock('./OverlayScrollbar', () => ({ default: () => null }));
vi.mock('../../capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture')>()),
  onCaptureUpdate: (cb: (u: { sessionId: string }) => void) => {
    h.captures.add(cb);
    return () => void h.captures.delete(cb);
  },
  ingestBehind: vi.fn(async () => h.behind),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
  markCommentsSent: vi.fn(async (taskId: number, ids: readonly number[]) => void h.marked.push([taskId, [...ids]])),
  unmarkCommentsSent: vi.fn(async (taskId: number, ids: readonly number[]) => void h.unmarked.push([taskId, [...ids]])),
}));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getMessages: vi.fn(async () => []),
  // As the real query: the task's or the session's rows, main thread, user
  // and system only, since `since`, newest first, at most `limit`.
  mainRowsSince: vi.fn(async (taskId: number, sessionId: string | null, since: number, limit = 200) => {
    if (h.fail) throw new Error('database is locked');
    return h.rows
      .filter(
        (m) =>
          m.ts >= since &&
          (m.taskId === taskId || m.sessionId === (sessionId ?? '')) &&
          m.agentId === null &&
          (m.role === 'user' || m.role === 'system'),
      )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, Math.max(1, limit));
  }),
}));

const { parseTranscript } = await import('../../capture/adapter');
const { recordQueueOperations, seedQueue } = await import('../../capture/queue');
const { submitPty, ptyLiveSince } = await import('../Terminal');
const delivery = await import('./delivery');
const {
  BEHIND_MAX_MS,
  DELIVERY_TIMEOUT_MS,
  FIRST_SEND_TIMEOUT_MS,
  LATE_LANDING_MS,
  NOT_DELIVERED,
  NOT_DELIVERED_BEFORE_RESTART,
  expectedFor,
  notDeliveredNote,
  onNotDelivered,
  sameText,
  startDeliveryWatch,
  __noteSpawnSeen,
  __resetDelivery,
} = delivery;
const { mustHold, sendToSession, submitLocked } = await import('./send');
const { awaitingDelivery, __resetDeliveryGate } = await import('./deliveryGate');
const outbox = await import('./outbox');
const { __resetOutbox, editHeld, heldFor, holdMessage, nextRun, outboxCodec, releaseHeld, sendAnyway, setEditing } = outbox;
const { canRelease, conditionsFor } = await import('./outboxRelease');
const { __resetTurns, isTurnRunning, noteTaskSessions } = await import('./turn');
const { __resetCommandEchoes, commandEchoFor } = await import('./commandEcho');
const { __resetConnectivity } = await import('../../lib/connectivity');
const { QueuedStrip } = await import('./QueuedStrip');
const { TranscriptPane } = await import('./TranscriptPane');
const { NOT_DELIVERED_NOTICE } = await import('./Composer');

/** An hour after this run started (delivery.ts's `RUN_STARTED_AT`), on a whole second. */
const T = Math.ceil((Date.now() + 3_600_000) / 1000) * 1000;
const SPAWNED = T - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let uid = 0;
/** A `user` row as capture stores it. */
function userRow(content: string, ms: number, over: Partial<Message> = {}): Message {
  const line = JSON.stringify({ type: 'user', sessionId: 's1', uuid: `u-${uid++}`, message: { role: 'user', content }, timestamp: iso(ms) });
  return { ...parseTranscript(line)[0]!, id: ++uid, taskId: 1, ...over };
}

/** The watcher read new lines of the task's session. */
function captured(): void {
  for (const cb of [...h.captures]) cb({ sessionId: 's1' });
}

/** Rows arrive and the watcher says so. */
async function arrive(...rows: Message[]): Promise<void> {
  h.rows.push(...rows);
  act(captured);
  await vi.advanceTimersByTimeAsync(0);
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
  h.rows = [];
  h.fail = false;
  h.behind = false;
  h.unmarked = [];
  h.marked = [];
  vi.mocked(ptyLiveSince).mockReturnValue(SPAWNED);
  vi.mocked(submitPty).mockClear();
  __resetOutbox();
  noteTaskSessions([{ id: 1, sessionId: 's1' }]);
  startDeliveryWatch();
  // A send has gone into this pty already: the 20 s deadline applies.
  __noteSpawnSeen(1, SPAWNED);
});

afterEach(() => {
  cleanup();
  seedQueue(['s1'], []);
  __resetDelivery();
  __resetDeliveryGate();
  __resetCommandEchoes();
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
    expect(await sendToSession(1, 'and also this')).toBe('held');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);

    expect(heldFor(1).map((m) => [m.text, m.notDelivered === true])).toEqual([
      ['try again', true],
      ['and also this', false],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mustHold(1)).toBe(true);
    expect(nextRun(heldFor(1))).toEqual([]);
    expect(await releaseHeld(1, (text) => submitLocked(1, text))).toBe(0);
    expect(await sendToSession(1, 'a third one')).toBe('held');
    expect(vi.mocked(submitPty)).toHaveBeenCalledTimes(1);

    sendAnyway(1, heldFor(1)[0]!.id);
    expect(heldFor(1)[0]).not.toHaveProperty('notDelivered');
    expect(nextRun(heldFor(1)).map((m) => m.text)).toEqual(['try again', 'and also this', 'a third one']);
  });

  it('from the outbox: the released message comes back, not lost', async () => {
    holdMessage(1, 'run the migrations', T);
    expect(await releaseHeld(1, (text, ids) => submitLocked(1, text, undefined, ids))).toBe(1);
    expect(heldFor(1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toMatchObject([{ text: 'run the migrations', notDelivered: true }]);
  });

  it('a button’s prompt: its command echo goes, the band has it', async () => {
    expect(await sendToSession(1, 'push the branch and open a pull request', 'Push')).toBe('sent');
    expect(commandEchoFor(1)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(1);
    expect(commandEchoFor(1)).toBeNull();
  });

  it('stays marked across a restart: the stored outbox keeps the mark', async () => {
    await submitLocked(1, 'please rerun the linter', undefined, [7]);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    const back = outboxCodec.decode(outboxCodec.encode(new Map([[1, heldFor(1)]]))!);
    expect(back?.get(1)).toMatchObject([{ text: 'please rerun the linter', maybeSent: true, notDelivered: true, commentIds: [7] }]);
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

  it('one held before the app restarted says so: the input box there is a new one', () => {
    expect(notDeliveredNote({ heldAt: 1_000 }, 2_000)).toBe(NOT_DELIVERED_BEFORE_RESTART);
    expect(notDeliveredNote({ heldAt: 3_000 }, 2_000)).toBe(NOT_DELIVERED);
    outbox.__resetOutbox();
    window.localStorage.setItem(
      'albedo.composerOutbox',
      JSON.stringify({ 1: [{ id: 'old', text: 'from yesterday', heldAt: 5, maybeSent: true, notDelivered: true }] }),
    );
    render(<QueuedStrip sessionId="s1" taskId={1} liveSince={SPAWNED} />);
    expect(screen.getByText(NOT_DELIVERED_BEFORE_RESTART)).toBeTruthy();
  });
});

describe('until it shows, nothing else goes', () => {
  it('a turn ending on its own within the 20 s does not let the next send through', async () => {
    await submitLocked(1, 'please rerun the linter');
    recordQueueOperations([{ op: 'turn-end', sessionId: 's1', ts: T + 2_000 }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(isTurnRunning(1)).toBe(false);
    expect(awaitingDelivery(1)).toBe(true);
    expect(await sendToSession(1, 'and another thing')).toBe('held');
    expect(vi.mocked(submitPty)).toHaveBeenCalledTimes(1);
    expect(canRelease(conditionsFor(1))).toBe(false);
    // It lands: the gate opens.
    await arrive(userRow('please rerun the linter', T + 2_500));
    expect(awaitingDelivery(1)).toBe(false);
  });

  it('the release sends one run, then waits for it to show before the next', async () => {
    holdMessage(1, 'first', T);
    holdMessage(1, '/model opus', T);
    const mayGo = () => canRelease(conditionsFor(1));
    expect(await releaseHeld(1, (text, ids) => submitLocked(1, text, undefined, ids), mayGo)).toBe(1);
    expect(heldFor(1).map((m) => m.text)).toEqual(['/model opus']);
    expect(vi.mocked(submitPty)).toHaveBeenCalledTimes(1);
  });
});

describe('the code comments it carried', () => {
  it('are unmarked as sent, and kept with the held message', async () => {
    await submitLocked(1, 'see the comments below', undefined, [7, 8]);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(h.unmarked).toEqual([[1, [7, 8]]]);
    expect(heldFor(1)[0]?.commentIds).toEqual([7, 8]);
  });

  it('from the outbox: the held message’s ids go with it, and come back with it', async () => {
    holdMessage(1, 'see the comments below', T, [5]);
    expect(await releaseHeld(1, (text, ids) => submitLocked(1, text, undefined, ids))).toBe(1);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(h.unmarked).toEqual([[1, [5]]]);
    expect(heldFor(1)[0]?.commentIds).toEqual([5]);
  });

  it('are marked sent again if it turns up late', async () => {
    await submitLocked(1, 'see the comments below', undefined, [7]);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    await arrive(userRow('see the comments below', Date.now()));
    expect(heldFor(1)).toHaveLength(0);
    expect(h.marked).toEqual([[1, [7]]]);
  });

  it('a delivered one touches nothing', async () => {
    await submitLocked(1, 'see the comments below', undefined, [7]);
    await arrive(userRow('see the comments below', T + 300));
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(h.unmarked).toEqual([]);
  });
});

describe('on screen', () => {
  it('the message box says so, and the pane’s "Sending" echo gives way to the held row; a late landing clears both', async () => {
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

    await act(async () => void (await arrive(userRow('[200~tidy the retry helper', Date.now()))));
    expect(heldFor(1)).toHaveLength(0);
    expect(screen.queryByText(NOT_DELIVERED_NOTICE)).toBeNull();
  });
});

describe('a message that lands', () => {
  it('as a prompt row: nothing is held', async () => {
    await submitLocked(1, 'please rerun the linter');
    await arrive(userRow('please rerun the linter', T + 300));
    expect(expectedFor(1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('as a prompt row read only at the timeout: nothing is held', async () => {
    await submitLocked(1, 'please rerun the linter');
    h.rows.push(userRow('please rerun the linter', T + 300));
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
    await vi.advanceTimersByTimeAsync(15_000);
    await arrive(userRow('please rerun the linter', Date.now()));
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(told).toEqual([]);
    expect(heldFor(1)).toHaveLength(0);
    expect(expectedFor(1)).toHaveLength(0);
  });

  it('the first send into a new pty gets a minute: a resume can be slow to start', async () => {
    vi.mocked(ptyLiveSince).mockReturnValue(T - 1_000);
    await submitLocked(1, 'pick up where we left off');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(heldFor(1)).toHaveLength(0);
    await arrive(userRow('pick up where we left off', Date.now()));
    await vi.advanceTimersByTimeAsync(FIRST_SEND_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(0);
    // The next one into the same pty has the usual 20 s.
    await submitLocked(1, 'and now the tests');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toMatchObject([{ text: 'and now the tests' }]);
  });

  it('a row from before the send is not it, nor another session’s, nor a subagent’s', async () => {
    h.rows.push(
      userRow('an older prompt', T - 2_000),
      userRow('in another session', T + 300, { sessionId: 's9', taskId: 9 }),
      userRow('inside a subagent', T + 300, { agentId: 'agent-1' }),
    );
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(1);
  });

  it('a task notification Claude Code wrote meanwhile is not it', async () => {
    await submitLocked(1, 'please rerun the linter');
    await arrive(userRow('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', T + 400));
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(1);
  });
});

describe('the watcher behind', () => {
  it('is unknown, not undelivered: the decision waits, and a row that arrives settles it', async () => {
    h.behind = true;
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS + 30_000);
    expect(heldFor(1)).toHaveLength(0);
    expect(awaitingDelivery(1)).toBe(true);
    await arrive(userRow('please rerun the linter', T + 400));
    expect(awaitingDelivery(1)).toBe(false);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('once caught up with no row, it was not delivered', async () => {
    h.behind = true;
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS + 10_000);
    expect(heldFor(1)).toHaveLength(0);
    h.behind = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heldFor(1)).toHaveLength(1);
  });

  it('behind for too long: nothing is said, and the task is free again', async () => {
    h.behind = true;
    await submitLocked(1, 'please rerun the linter');
    await vi.advanceTimersByTimeAsync(BEHIND_MAX_MS + 10_000);
    expect(heldFor(1)).toHaveLength(0);
    expect(expectedFor(1)).toHaveLength(0);
    expect(awaitingDelivery(1)).toBe(false);
  });
});

describe('late, after it was said to be undelivered', () => {
  async function undelivered(text: string): Promise<void> {
    await submitLocked(1, text);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(heldFor(1)).toHaveLength(1);
  }

  it('its own text, as Enter in the terminal leaves it: it leaves the outbox again', async () => {
    await undelivered('please rerun the linter');
    await arrive(userRow('[200~please rerun the linter', Date.now()));
    expect(heldFor(1)).toHaveLength(0);
  });

  it('found behind hundreds of newer rows', async () => {
    await undelivered('please rerun the linter');
    const at = Date.now();
    const later = Array.from({ length: 300 }, (_, i) => userRow(`something else ${i}`, at + 10 + i));
    await arrive(userRow('please rerun the linter', at), ...later);
    expect(heldFor(1)).toHaveLength(0);
  });

  it('a row that only contains it is not it: "ok" is not "look"', async () => {
    await undelivered('ok');
    await arrive(userRow('look at this first', Date.now()), userRow('ok, and also the tests', Date.now()));
    expect(heldFor(1)).toHaveLength(1);
  });

  it('a task notification carrying the text is not it', async () => {
    await undelivered('ok');
    await arrive(userRow('<task-notification>ok</task-notification>', Date.now()));
    expect(heldFor(1)).toHaveLength(1);
  });

  it('a different prompt: the held one stays, and is no longer looked for after the window', async () => {
    await undelivered('please rerun the linter');
    await arrive(userRow('something typed in the terminal', Date.now()));
    expect(heldFor(1)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LATE_LANDING_MS);
    expect(expectedFor(1)).toHaveLength(0);
    expect(heldFor(1)).toHaveLength(1);
  });

  it('edited: it is the person’s, and a late row does not take it', async () => {
    await undelivered('please rerun the linter');
    const id = heldFor(1)[0]!.id;
    editHeld(1, id, 'please rerun the linter on the api package');
    expect(expectedFor(1)).toHaveLength(0);
    await arrive(userRow('please rerun the linter', Date.now()));
    expect(heldFor(1).map((m) => m.text)).toEqual(['please rerun the linter on the api package']);
  });

  it('open for editing: the same, even with the text unchanged', async () => {
    await undelivered('please rerun the linter');
    const id = heldFor(1)[0]!.id;
    setEditing(1, id, true);
    expect(expectedFor(1)).toHaveLength(0);
    await arrive(userRow('please rerun the linter', Date.now()));
    expect(heldFor(1)).toHaveLength(1);
  });
});

describe('sameText', () => {
  it('the whole text, markers aside', () => {
    expect(sameText('[200~ok', 'ok')).toBe(true);
    expect(sameText('\x1b[200~ok\x1b[201~', 'ok')).toBe(true);
    expect(sameText('ok[201~', 'ok')).toBe(true);
    expect(sameText('look', 'ok')).toBe(false);
    expect(sameText('ok then', 'ok')).toBe(false);
    expect(sameText('', '')).toBe(false);
  });

  it('a long message by its start, a short one never', () => {
    const long = `${'a long careful description of the change. '.repeat(10)}`;
    expect(sameText(`${long.slice(0, 250)}[cut]`, long)).toBe(true);
    expect(sameText(long.slice(0, 50), long)).toBe(false);
  });
});

describe('what is not watched, or cannot be told', () => {
  it('a slash command: its echo says when nothing came back', async () => {
    await submitLocked(1, '/compact');
    expect(expectedFor(1)).toHaveLength(0);
    expect(awaitingDelivery(1)).toBe(false);
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
    expect(awaitingDelivery(1)).toBe(false);
  });
});
