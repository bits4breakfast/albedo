/**
 * @vitest-environment jsdom
 *
 * What triggers keep per task (#448): the cards waiting on you and the watch,
 * kept across a restart, gone with their task; and what a card says.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTriggerStore,
  addTriggerCard,
  editTriggerCard,
  forgetTriggers,
  keepTriggersFor,
  markTriggerInBox,
  noteTriggerTextSent,
  resolveTriggerCard,
  setTriggerWatch,
  triggerCardsOf,
  triggerWatchOf,
  triggersCodec,
  type TriggerCard,
} from './store';
import { cardFor, draftText, liveFacts, mergedFacts, reviewFacts, rowWord } from './facts';
import { triggerStep, type TriggerFire } from './detect';
import { MERGE_SHA, SHA_A, fail, pending, prOf } from './fixtures';
import { KEYS } from '../ui/persisted';
import type { ReviewThread } from '../gh/reviewThreads';

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
  __resetTriggerStore();
});

const base = { prNumber: 412, prTitle: 'Send the confirmation once per order', prUrl: 'https://github.com/example/shop/pull/412' };
const merged: TriggerFire = { ...base, event: 'merged', mergeCommit: MERGE_SHA };
const TEMPLATE = '/after-merge — watch the deploy for two hours and tell me about new errors.';

function ciFire(): TriggerFire {
  const a = triggerStep(undefined, prOf({ lines: [pending('build')] }), 'me', 1);
  return triggerStep(a.watch, prOf({ lines: [fail('build')] }), 'me', 2).fires[0]!;
}

describe('what a card says', () => {
  it('a merge: the template, a blank line, then the PR number, title and merge commit', () => {
    const card = cardFor(merged, 'draft', TEMPLATE, 1);
    expect(mergedFacts(merged as Extract<TriggerFire, { event: 'merged' }>)).toBe('PR #412 "Send the confirmation once per order", merged as 3f9c2e1.');
    expect(draftText(card, null)).toBe(`${TEMPLATE}\n\nPR #412 "Send the confirmation once per order", merged as 3f9c2e1.`);
    expect(card.subject).toBe('PR #412 was merged');
    expect(rowWord(card)).toBe('PR merged · draft ready');
  });

  it('an empty template is the facts alone; an edit replaces both', () => {
    const card = cardFor(merged, 'draft', '  ', 1);
    expect(draftText(card, null)).toBe('PR #412 "Send the confirmation once per order", merged as 3f9c2e1.');
    expect(draftText({ ...card, text: 'my words' }, null)).toBe('my words');
  });

  it('a CI failure: the failure as CI Details gathers it, the queue’s copy for the same commit preferred', () => {
    const card = cardFor(ciFire(), 'draft', 'Fix the failing checks.', 1);
    expect(card.facts).toBe(`CI failed on PR #412 (${SHA_A.slice(0, 7)}):\n- build: failed — https://ci.example.com/build`);
    const queued = {
      prNumber: 412,
      sha: SHA_A,
      checks: [{ name: 'build', conclusion: 'failed', url: 'https://ci.example.com/build' }],
      queuedAt: 1,
      details: { state: 'ready' as const, checks: [{ name: 'build', step: 'Run tests', log: ['FAIL src/a.test.ts'], more: 0 }] },
    };
    expect(liveFacts(card, queued)).toContain('Run tests');
    expect(liveFacts(card, queued)).toContain('FAIL src/a.test.ts');
    // Another commit's queue is not this card's failure.
    expect(liveFacts(card, { ...queued, sha: 'other' })).toBe(card.facts);
    expect(rowWord(card)).toBe('CI failed · draft ready');
  });

  it('a review: what was said, then each thread with something new, whole', () => {
    const fire = { ...base, event: 'review' as const, changesBy: ['bob'], newThreads: 1, since: 100 };
    const thread: ReviewThread = {
      id: 't1',
      path: 'src/order.ts',
      line: 42,
      startLine: null,
      originalLine: 42,
      side: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      replyTo: 1,
      anchor: null,
      comments: [
        { author: 'bob', body: 'Send it once per order, not per item.', createdAt: 200 },
        { author: 'me', body: 'Will do.', createdAt: 300 },
      ],
    };
    expect(reviewFacts(fire, [thread])).toBe(
      'Review on PR #412 "Send the confirmation once per order": Changes requested by bob · 1 review thread with new comments.\n\n- src/order.ts:42\n  bob: Send it once per order, not per item.\n  me: Will do.',
    );
    // Could not read them: said, with where they are, never "none".
    expect(reviewFacts(fire, null)).toContain("couldn't read the threads; they are on https://github.com/example/shop/pull/412");
  });

  it('the approval as a Suggest: why, and the row word', () => {
    const card = cardFor({ ...base, event: 'approved', sha: SHA_A, approvers: ['alice'], checks: 6 }, 'suggest', 'ignored', 1);
    expect(card.why).toBe('Approved by alice, 6 of 6 checks passed, no conflicts.');
    expect(card.template).toBe('');
    expect(rowWord(card)).toBe('Approved · ready to merge');
  });
});

describe('the store', () => {
  const card = (over: Partial<TriggerCard> = {}): TriggerCard => ({ ...cardFor(merged, 'draft', TEMPLATE, 1), ...over });

  it('keeps cards and the watch across a restart', () => {
    addTriggerCard(7, card());
    const w = triggerStep(undefined, prOf(), 'me', 1).watch!;
    setTriggerWatch(7, w);
    __resetTriggerStore();
    expect(triggerCardsOf(7)).toHaveLength(1);
    expect(triggerWatchOf(7)).toEqual(w);
    expect(window.localStorage.getItem(KEYS.triggers)).not.toBeNull();
  });

  it('a newer card for the same event replaces one as it fired, never one you edited', () => {
    addTriggerCard(7, card({ id: 'a' }));
    addTriggerCard(7, card({ id: 'b' }));
    expect(triggerCardsOf(7).map((c) => c.id)).toEqual(['b']);
    editTriggerCard(7, 'b', 'mine');
    addTriggerCard(7, card({ id: 'c' }));
    expect(triggerCardsOf(7).map((c) => c.id)).toEqual(['b', 'c']);
    // The same card twice is one.
    addTriggerCard(7, card({ id: 'c' }));
    expect(triggerCardsOf(7)).toHaveLength(2);
  });

  it('a card moved to the box goes when a message carrying its line, whole, is sent', () => {
    addTriggerCard(7, card({ id: 'a' }));
    markTriggerInBox(7, 'a', 'Run the deploy check');
    noteTriggerTextSent(7, 'Please Run the deploy checks now');
    expect(triggerCardsOf(7)).toHaveLength(1);
    noteTriggerTextSent(8, 'Run the deploy check');
    expect(triggerCardsOf(7)).toHaveLength(1);
    noteTriggerTextSent(7, 'Hello\n  Run the deploy check  \nmore');
    expect(triggerCardsOf(7)).toHaveLength(0);
  });

  it('a card not in the box is never taken by a send', () => {
    addTriggerCard(7, card({ id: 'a' }));
    noteTriggerTextSent(7, TEMPLATE);
    expect(triggerCardsOf(7)).toHaveLength(1);
    resolveTriggerCard(7, 'a');
    expect(triggerCardsOf(7)).toHaveLength(0);
  });

  it('goes with its task', () => {
    addTriggerCard(7, card());
    addTriggerCard(8, card());
    keepTriggersFor([8]);
    expect(triggerCardsOf(7)).toHaveLength(0);
    forgetTriggers(8);
    expect(triggerCardsOf(8)).toHaveLength(0);
    expect(window.localStorage.getItem(KEYS.triggers)).toBeNull();
  });

  it('drops a malformed card or watch rather than guessing', () => {
    const raw = JSON.stringify({ 7: { watch: { pr: 'x' }, cards: [{ id: 'a' }, card({ id: 'ok' })] }, x: {} });
    const map = triggersCodec.decode(raw)!;
    expect([...map.keys()]).toEqual([7]);
    expect(map.get(7)!.watch).toBeUndefined();
    expect(map.get(7)!.cards.map((c) => c.id)).toEqual(['ok']);
  });
});

describe('typing in a card (#448 review)', () => {
  it('is held in memory at once, written once soon after, and tells no one -- the list does not regroup per keystroke', async () => {
    const { EDIT_WRITE_MS, onTriggerChange } = await import('./store');
    vi.useFakeTimers();
    try {
      addTriggerCard(7, cardFor(merged, 'draft', TEMPLATE, 1));
      const id = triggerCardsOf(7)[0]!.id;
      const stored = window.localStorage.getItem(KEYS.triggers);
      let told = 0;
      const off = onTriggerChange(() => (told += 1));
      const writes = vi.spyOn(window.localStorage, 'setItem');
      for (const t of ['m', 'my', 'my w', 'my words']) editTriggerCard(7, id, t);
      expect(told).toBe(0);
      expect(writes).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(KEYS.triggers)).toBe(stored);
      // Already the card's, for a newer card that would replace an untouched one.
      expect(triggerCardsOf(7)[0]!.text).toBe('my words');
      vi.advanceTimersByTime(EDIT_WRITE_MS);
      expect(writes).toHaveBeenCalledTimes(1);
      __resetTriggerStore();
      expect(triggerCardsOf(7)[0]!.text).toBe('my words');
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pruning (#448 review)', () => {
  it('keeps what was written since the task list read began', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      addTriggerCard(7, cardFor(merged, 'draft', TEMPLATE, 1));
      const readStartedAt = 1_000_010; // the read of the task list began
      vi.setSystemTime(1_000_020);
      addTriggerCard(9, cardFor(merged, 'draft', TEMPLATE, 1)); // a task the read cannot know
      keepTriggersFor([], readStartedAt);
      expect(triggerCardsOf(7)).toHaveLength(0);
      expect(triggerCardsOf(9)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
