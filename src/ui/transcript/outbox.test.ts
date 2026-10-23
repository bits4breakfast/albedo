/**
 * @vitest-environment jsdom
 *
 * The outbox: what is held, in what order it goes, and that nothing in it is
 * lost or sent twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KEYS } from '../persisted';
import {
  __resetOutbox,
  editHeld,
  heldFor,
  holdMessage,
  isReleasing,
  keepOutboxFor,
  lastReleaseFailed,
  onHeldReleased,
  outboxCodec,
  releaseHeld,
  removeHeld,
  sendAnyway,
  setEditing,
  tasksWithHeld,
} from './outbox';

const T0 = Date.parse('2026-10-23T09:00:00.000Z');

function installStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): void {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

beforeEach(() => {
  const data = new Map<string, string>();
  installStorage({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  });
  __resetOutbox();
});

afterEach(() => {
  __resetOutbox();
});

const texts = (taskId: number) => heldFor(taskId).map((h) => h.text);

describe('outboxCodec', () => {
  it('round-trips, and drops a malformed entry rather than everything', () => {
    const outbox = new Map([[3, [{ id: 'a', text: 'hi', heldAt: T0 }]]]);
    const raw = outboxCodec.encode(outbox) as string;
    expect(outboxCodec.decode(raw)).toEqual(outbox);
    const mixed = JSON.stringify({ 3: [{ id: 'a', text: 'hi', heldAt: T0 }, { id: 7 }], 4: 'x', y: [] });
    expect(outboxCodec.decode(mixed)).toEqual(outbox);
  });

  it('removes the key when nothing is held', () => {
    expect(outboxCodec.encode(new Map())).toBeNull();
  });
});

describe('holding', () => {
  it('keeps messages per task, in the order they were sent', () => {
    holdMessage(1, 'first', T0);
    holdMessage(2, 'for B', T0);
    holdMessage(1, 'second', T0);
    expect(texts(1)).toEqual(['first', 'second']);
    expect(texts(2)).toEqual(['for B']);
    expect(new Set(heldFor(1).map((h) => h.id)).size).toBe(2);
  });

  it('does not hold whitespace', () => {
    expect(holdMessage(1, '  \n')).toBeNull();
    expect(tasksWithHeld()).toEqual([]);
  });

  it('survives a restart: written at once, read back from storage', () => {
    holdMessage(1, 'sent offline', T0);
    expect(window.localStorage.getItem(KEYS.composerOutbox)).not.toBeNull();
    __resetOutbox();
    expect(heldFor(1)).toEqual([expect.objectContaining({ text: 'sent offline', heldAt: T0 })]);
  });

  it('edits in place, and an empty edit removes', () => {
    holdMessage(1, 'a');
    const b = holdMessage(1, 'b')!;
    holdMessage(1, 'c');
    editHeld(1, b.id, 'b, better');
    expect(texts(1)).toEqual(['a', 'b, better', 'c']);
    editHeld(1, b.id, ' ');
    expect(texts(1)).toEqual(['a', 'c']);
    __resetOutbox();
    expect(texts(1)).toEqual(['a', 'c']);
  });

  it('removes one, and an emptied task leaves storage', () => {
    const a = holdMessage(1, 'a')!;
    removeHeld(1, a.id);
    expect(tasksWithHeld()).toEqual([]);
    expect(window.localStorage.getItem(KEYS.composerOutbox)).toBeNull();
  });

  it('keepOutboxFor drops archived and deleted tasks only', () => {
    holdMessage(1, 'live');
    holdMessage(2, 'archived');
    keepOutboxFor([1, 9]);
    expect(tasksWithHeld()).toEqual([1]);
  });
});

describe('releasing', () => {
  it('sends in order, each once, and empties the outbox', async () => {
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    holdMessage(1, 'three');
    const sent: string[] = [];
    const released = vi.fn();
    onHeldReleased(released);
    expect(await releaseHeld(1, async (t) => (sent.push(t), true))).toBe(3);
    expect(sent).toEqual(['one', 'two', 'three']);
    expect(released.mock.calls.map(([id, held]) => [id, held.text])).toEqual([
      [1, 'one'],
      [1, 'two'],
      [1, 'three'],
    ]);
    expect(texts(1)).toEqual([]);
  });

  it('a crash mid-send leaves the message as maybe sent: never resent on its own, never lost', async () => {
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    void releaseHeld(1, () => new Promise<boolean>(() => {})); // the write never comes back
    expect(heldFor(1)[0]?.sending).toBe(true);
    __resetOutbox(); // the crash: only storage survives
    expect(heldFor(1).map((h) => [h.text, h.maybeSent ?? false, h.sending ?? false])).toEqual([
      ['one', true, false],
      ['two', false, false],
    ]);
    // The release stops at it, keeping order.
    const sent: string[] = [];
    const send = async (t: string) => (sent.push(t), true);
    expect(await releaseHeld(1, send)).toBe(0);
    expect(sent).toEqual([]);
    // Send: the person says it did not arrive.
    sendAnyway(1, heldFor(1)[0]!.id);
    expect(heldFor(1)[0]?.maybeSent).toBeUndefined();
    expect(await releaseHeld(1, send)).toBe(2);
    expect(sent).toEqual(['one', 'two']);
  });

  it('a maybe-sent message can be removed instead, and the rest go', async () => {
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    void releaseHeld(1, () => new Promise<boolean>(() => {}));
    __resetOutbox();
    removeHeld(1, heldFor(1)[0]!.id);
    const sent: string[] = [];
    await releaseHeld(1, async (t) => (sent.push(t), true));
    expect(sent).toEqual(['two']);
    __resetOutbox();
    expect(tasksWithHeld()).toEqual([]);
  });

  it('stops at a failed send and keeps it at the head, so nothing is lost or reordered', async () => {
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    holdMessage(1, 'three');
    const send = vi.fn(async (t: string) => t !== 'two');
    expect(await releaseHeld(1, send)).toBe(1);
    expect(texts(1)).toEqual(['two', 'three']);
    // A throw is a failure too.
    expect(await releaseHeld(1, async () => Promise.reject(new Error('pty gone')))).toBe(0);
    expect(texts(1)).toEqual(['two', 'three']);
  });

  it('marks each message as sending before sending it: a second release at the same time sends nothing twice', async () => {
    holdMessage(1, 'one');
    holdMessage(1, 'two');
    let land: () => void = () => {};
    const sent: string[] = [];
    const slow = (t: string) => new Promise<boolean>((r) => (sent.push(t), (land = () => r(true))));
    const first = releaseHeld(1, slow);
    expect(isReleasing(1)).toBe(true);
    expect(heldFor(1).map((h) => [h.text, h.sending ?? false])).toEqual([
      ['one', true],
      ['two', false],
    ]);
    expect(await releaseHeld(1, slow)).toBe(0);
    land();
    await vi.waitFor(() => expect(sent).toEqual(['one', 'two']));
    land();
    expect(await first).toBe(2);
    expect(isReleasing(1)).toBe(false);
  });

  it('a message held during a release goes after the ones before it', async () => {
    holdMessage(1, 'one');
    const sent: string[] = [];
    await releaseHeld(1, async (t) => {
      sent.push(t);
      if (t === 'one') holdMessage(1, 'typed meanwhile');
      return true;
    });
    expect(sent).toEqual(['one', 'typed meanwhile']);
  });

  it('keeps the review comments a message carries, through a restart, and hands them over on delivery', async () => {
    holdMessage(1, 'see a.ts:3', T0, [7, 8]);
    __resetOutbox();
    const released = vi.fn();
    onHeldReleased(released);
    await releaseHeld(1, async () => true);
    expect(released.mock.calls[0]?.[1]).toMatchObject({ text: 'see a.ts:3', commentIds: [7, 8] });
  });

  it('waits, without counting it a failure, while the gate is shut', async () => {
    holdMessage(1, 'one');
    const send = vi.fn(async () => true);
    expect(await releaseHeld(1, send, () => false)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(lastReleaseFailed(1)).toBe(false);
    await releaseHeld(1, async () => false);
    expect(lastReleaseFailed(1)).toBe(true);
  });

  it('stops before a message open for editing, and goes on once it is closed', async () => {
    holdMessage(1, 'one');
    const b = holdMessage(1, 'two')!;
    holdMessage(1, 'three');
    setEditing(1, b.id, true);
    const sent: string[] = [];
    const send = async (t: string) => (sent.push(t), true);
    await releaseHeld(1, send);
    expect(sent).toEqual(['one']);
    editHeld(1, b.id, 'two, edited');
    setEditing(1, b.id, false);
    await releaseHeld(1, send);
    expect(sent).toEqual(['one', 'two, edited', 'three']);
  });
});
