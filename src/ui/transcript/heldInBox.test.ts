/**
 * @vitest-environment jsdom
 *
 * Edit all held messages in the message box (#399): the outbox's side --
 * taken into the box, kept out of every release, put back exactly, replaced
 * by one -- and what the box shows for them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetOutbox,
  allNowRun,
  heldFor,
  holdMessage,
  inBoxFor,
  nextRun,
  putBackFromBox,
  releaseHeld,
  replaceInBox,
  sendAllHeldNow,
  sendHeldNow,
  setEditing,
  takeableIntoBox,
  takeIntoBox,
} from './outbox';
import { heldAsDraft, putBackWhereNoDraft } from './heldInBox';
import { __resetDrafts, saveDraft } from './drafts';
import { KEYS } from '../persisted';
import { draftOf, markPastes, placeholderFor } from './pastedText';
import { markMentions } from './mentions';
import { composeWithComments, markQuotes, type TranscriptComment } from './transcriptQuotes';

const T0 = Date.parse('2026-10-23T09:00:00.000Z');

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
  __resetOutbox();
});

afterEach(() => {
  __resetOutbox();
  __resetDrafts();
});

const texts = (taskId = 1) => heldFor(taskId).map((h) => h.text);

describe('taking held messages into the box', () => {
  it('takes every one it can, oldest first, and leaves them where they are', () => {
    holdMessage(1, 'also check the timezone on the daily report', T0);
    holdMessage(1, "and don't touch the migration", T0 + 1);
    holdMessage(1, 'when you are done run the export tests', T0 + 2);
    const before = heldFor(1);
    const taken = takeIntoBox(1);
    expect(taken.map((h) => h.text)).toEqual([
      'also check the timezone on the daily report',
      "and don't touch the migration",
      'when you are done run the export tests',
    ]);
    expect(heldFor(1).map((h) => h.id)).toEqual(before.map((h) => h.id));
    expect(heldFor(1).every((h) => h.inBox === true)).toBe(true);
  });

  it('takes only the unbroken run: nothing past a command, so nothing comes back ahead of it', () => {
    holdMessage(1, 'a', T0);
    holdMessage(1, '/clear', T0 + 1);
    holdMessage(1, 'b', T0 + 2);
    expect(takeableIntoBox(1).map((h) => h.text)).toEqual(['a']);
    expect(takeIntoBox(1).map((h) => h.text)).toEqual(['a']);
    // Sent from the box, it takes a's place: b still goes after /clear.
    replaceInBox(1, 'a, edited', T0 + 10);
    expect(texts()).toEqual(['a, edited', '/clear', 'b']);
  });

  it('nor past one open in the band: the run starts at the first it can take and stops at the next it cannot', () => {
    holdMessage(1, '/compact', T0);
    holdMessage(1, 'first', T0 + 1);
    holdMessage(1, 'second', T0 + 2);
    const open = holdMessage(1, 'open in the band', T0 + 3)!;
    holdMessage(1, 'last', T0 + 4);
    setEditing(1, open.id, true);
    expect(takeableIntoBox(1).map((h) => h.text)).toEqual(['first', 'second']);
    expect(takeIntoBox(1).map((h) => h.text)).toEqual(['first', 'second']);
    expect(heldFor(1).filter((h) => !h.inBox).map((h) => h.text)).toEqual(['/compact', 'open in the band', 'last']);
  });

  it('never takes a message being written or one that may already have gone', async () => {
    holdMessage(1, 'going now', T0);
    holdMessage(1, 'after it', T0 + 1);
    let finish: (ok: boolean) => void = () => {};
    const release = releaseHeld(1, () => new Promise<boolean>((r) => (finish = r)), () => true);
    // Both are being written as one run.
    expect(heldFor(1).every((h) => h.sending)).toBe(true);
    expect(takeIntoBox(1)).toEqual([]);
    finish(true);
    await release;
    // Cut off mid-send by a restart: it may have gone.
    window.localStorage.setItem(
      KEYS.composerOutbox,
      JSON.stringify({ 1: [{ id: 'a', text: 'maybe', heldAt: T0, sending: true }, { id: 'b', text: 'fine', heldAt: T0 + 1 }] }),
    );
    __resetOutbox();
    expect(heldFor(1)[0]!.maybeSent).toBe(true);
    expect(takeIntoBox(1).map((h) => h.id)).toEqual(['b']);
    expect(heldFor(1)[0]!.inBox).toBeUndefined();
  });

  it('does nothing while some are already in the box', () => {
    holdMessage(1, 'one', T0);
    takeIntoBox(1);
    holdMessage(1, 'two', T0 + 1);
    expect(takeIntoBox(1)).toEqual([]);
    expect(inBoxFor(1).map((h) => h.text)).toEqual(['one']);
  });

  it('a single held message is taken the same way', () => {
    holdMessage(1, 'only one', T0);
    expect(takeIntoBox(1).map((h) => h.text)).toEqual(['only one']);
  });
});

describe('while in the box, nothing sends them', () => {
  it('no release passes them, and what is behind them waits', async () => {
    holdMessage(1, 'first', T0);
    takeIntoBox(1);
    holdMessage(1, 'held later', T0 + 1);
    expect(nextRun(heldFor(1))).toEqual([]);
    const send = vi.fn(async () => true);
    expect(await releaseHeld(1, send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(texts()).toEqual(['first', 'held later']);
  });

  it('Send Now and Send All Now leave them out', async () => {
    const a = holdMessage(1, 'a', T0)!;
    holdMessage(1, 'b', T0 + 1);
    takeIntoBox(1);
    const send = vi.fn(async () => true);
    expect(await sendHeldNow(1, a.id, send)).toBe(false);
    expect(allNowRun(heldFor(1))).toEqual([]);
    expect(await sendAllHeldNow(1, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('a restart keeps them in the box and out of the queue', async () => {
    holdMessage(1, 'first', T0);
    holdMessage(1, 'second', T0 + 1);
    takeIntoBox(1);
    __resetOutbox(); // memory gone, storage kept
    expect(inBoxFor(1).map((h) => h.text)).toEqual(['first', 'second']);
    const send = vi.fn(async () => true);
    expect(await releaseHeld(1, send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('putting them back', () => {
  it('restores them exactly: ids, order, texts, comments, times', async () => {
    holdMessage(1, 'first', T0, [7]);
    holdMessage(1, 'second', T0 + 1, [8, 9]);
    holdMessage(1, '/compact', T0 + 2);
    const before = structuredClone(heldFor(1));
    expect(takeIntoBox(1)).toHaveLength(2);
    putBackFromBox(1);
    expect(heldFor(1)).toEqual(before);
    __resetOutbox();
    expect(heldFor(1)).toEqual(before);
    // And they go again.
    const send = vi.fn(async () => true);
    expect(await releaseHeld(1, send)).toBe(3);
  });
});

describe('replacing them with the message from the box', () => {
  it('one message in the place of the first, carrying every comment, the rest kept in order', () => {
    holdMessage(1, 'first', T0, [7]);
    holdMessage(1, 'second', T0 + 1, [8]);
    holdMessage(1, '/compact', T0 + 2);
    holdMessage(1, 'fourth', T0 + 3);
    expect(takeIntoBox(1).map((h) => h.text)).toEqual(['first', 'second']);
    holdMessage(1, 'held after', T0 + 4);
    const entry = replaceInBox(1, 'first and second, edited', T0 + 10, [12])!;
    expect(texts()).toEqual(['first and second, edited', '/compact', 'fourth', 'held after']);
    expect(entry.commentIds).toEqual([7, 8, 12]);
    expect(entry.heldAt).toBe(T0);
    expect(entry.inBox).toBeUndefined();
    expect(inBoxFor(1)).toEqual([]);
    // An ordinary held message now: the release sends it first.
    expect(nextRun(heldFor(1)).map((h) => h.text)).toEqual(['first and second, edited']);
  });

  it('whitespace alone puts them back instead', () => {
    holdMessage(1, 'first', T0);
    const before = structuredClone(heldFor(1));
    takeIntoBox(1);
    expect(replaceInBox(1, '  \n', T0 + 10)).toBeNull();
    expect(heldFor(1)).toEqual(before);
  });

  it('does nothing when none are in the box', () => {
    holdMessage(1, 'first', T0);
    expect(replaceInBox(1, 'other', T0 + 10)).toBeNull();
    expect(texts()).toEqual(['first']);
  });
});

describe('heldAsDraft: what the box shows', () => {
  it('joins them oldest first with a blank line', () => {
    expect(heldAsDraft([{ text: 'a' }, { text: 'b\nc' }, { text: 'd' }]).text).toBe('a\n\nb\nc\n\nd');
  });

  it('shows pastes, references and quotes as tokens, and they go back whole', () => {
    const log = 'line one\nline two\nline three\nline four';
    const withPaste = markPastes(`see ${placeholderFor(1, log)} please`, new Map([[1, log]]));
    const file = { kind: 'file' as const, label: '@src/export.ts', path: 'src/export.ts' };
    const withRef = markMentions('look at @src/export.ts first', new Map([['@src/export.ts', file]]));
    const quote: TranscriptComment = {
      id: 'q', messageId: 9, quote: 'The export runs nightly.', code: false, comment: 'Since when?', at: T0, offset: 0, addedAt: T0,
    };
    const withQuote = composeWithComments([quote], 'and the timezone');
    const other = markPastes(`again ${placeholderFor(1, log)}`, new Map([[1, log]]));
    const d = heldAsDraft([{ text: withPaste }, { text: withRef }, { text: withQuote }, { text: other }]);
    expect(d.text).not.toMatch(/<pasted-text|<transcript-quote|-ref/);
    expect(d.text).toContain(placeholderFor(1, log));
    expect(d.text).toContain('[Quote #1: The export runs nightly.]');
    expect(d.text).toContain('look at @src/export.ts first');
    expect(d.mentions.size).toBe(1);
    // The same paste twice is one paste.
    expect(d.pastes.size).toBe(1);
    // Sent unchanged, it is the same message, marker for marker's content.
    const back = markPastes(markQuotes(markMentions(d.text, d.mentions), d.quotes), d.pastes);
    const joined = [withPaste, withRef, withQuote, other].join('\n\n');
    expect(draftOf(back)).toEqual(draftOf(joined));
    expect(back).toContain('<transcript-quote');
    expect(back).toContain('Since when?');
  });

  it('an image path comes along where it was', () => {
    const d = heldAsDraft([{ text: 'look /Users/me/.albedo/paste/shot.png' }, { text: 'then this' }]);
    expect(d.text).toBe('look /Users/me/.albedo/paste/shot.png\n\nthen this');
  });

  it('the same messages give the same quote numbers again', () => {
    const quote: TranscriptComment = {
      id: 'q', messageId: 9, quote: 'A passage.', code: false, comment: '', at: T0, offset: 0, addedAt: T0,
    };
    const held = [{ text: composeWithComments([quote], 'x') }, { text: composeWithComments([quote], 'y') }];
    expect(heldAsDraft(held).quotes).toEqual(heldAsDraft(held).quotes);
    expect(heldAsDraft(held).quotes.size).toBe(2);
  });
});

describe('putBackWhereNoDraft: a box with no draft to show them', () => {
  it('puts back the messages of a task whose draft is gone or blank, and keeps those with one', () => {
    holdMessage(1, 'no draft for these', T0);
    holdMessage(2, 'a draft shows these', T0);
    holdMessage(3, 'a blank draft', T0);
    takeIntoBox(1);
    takeIntoBox(2);
    takeIntoBox(3);
    saveDraft(2, 'a draft shows these, edited', new Map());
    saveDraft(3, '   ', new Map());
    putBackWhereNoDraft();
    expect(inBoxFor(1)).toEqual([]);
    expect(inBoxFor(2).map((h) => h.text)).toEqual(['a draft shows these']);
    expect(inBoxFor(3)).toEqual([]);
  });
});
