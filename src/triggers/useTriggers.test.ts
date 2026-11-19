/**
 * @vitest-environment jsdom
 *
 * The trigger watch (#448): only what a project turned on becomes a card;
 * nothing is decided before its settings are read; review tasks, chats and
 * archived tasks are not watched; a review's card carries the threads with
 * something new from someone else, fetched once.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeTriggers, type TriggerDeps, type TriggerTask } from './useTriggers';
import { __resetTriggerStore, editTriggerCard, triggerCardsOf, triggerWatchOf } from './store';
import { loadTriggerSettings, setTriggerFiles } from './settings';
import { changesBy, fail, pending, prOf, readyPr } from './fixtures';
import type { ReviewThread } from '../gh/reviewThreads';

const TASK: TriggerTask = { id: 7, projectId: 3, status: 'idle', kind: 'work', reviewUrl: null, worktreePath: '/w', repoPath: '/r' };

let settings: string | null = null;
let threads: ReviewThread[] | null = [];
let asked = 0;
let clock = 1_000;
const deps: TriggerDeps = {
  threads: async () => {
    asked += 1;
    return threads;
  },
  now: () => (clock += 1_000),
};

beforeEach(async () => {
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
  settings = JSON.stringify({ ciFailed: { mode: 'draft', template: 'Fix it.' }, review: { mode: 'draft', template: 'Address these.' } });
  setTriggerFiles({ read: async () => settings, write: async () => {} });
  await loadTriggerSettings(3);
  threads = [];
  asked = 0;
});
afterEach(() => setTriggerFiles({ read: async () => null, write: async () => {} }));

const flush = () => new Promise((r) => setTimeout(r, 0));

function thread(id: string, comments: Array<[string, number, string]>): ReviewThread {
  return {
    id,
    path: 'src/order.ts',
    line: 42,
    startLine: null,
    originalLine: 42,
    side: 'RIGHT',
    isResolved: false,
    isOutdated: false,
    replyTo: 1,
    anchor: null,
    comments: comments.map(([author, createdAt, body]) => ({ author, createdAt, body })),
  };
}

describe('the watch', () => {
  it('fires only what the project turned on', () => {
    observeTriggers(TASK, prOf({ lines: [pending('build')] }), 'me', deps);
    observeTriggers(TASK, prOf({ lines: [fail('build')] }), 'me', deps);
    expect(triggerCardsOf(7).map((c) => c.event)).toEqual(['ciFailed']);
    // Merged: no card (Off), and the CI card no longer applies.
    observeTriggers(TASK, prOf({ state: 'merged' }), 'me', deps);
    expect(triggerCardsOf(7)).toEqual([]);
  });

  it('decides nothing for a project whose settings are not read yet: the answer waits', async () => {
    const other = { ...TASK, id: 8, projectId: 99 };
    expect(observeTriggers(other, prOf(), 'me', deps)).toEqual([]);
    expect(triggerWatchOf(8)).toBeUndefined();
  });

  it('does not watch review tasks, chats or archived tasks', () => {
    for (const t of [
      { ...TASK, reviewUrl: 'https://github.com/example/shop/pull/9' },
      { ...TASK, kind: 'chat' as const },
      { ...TASK, status: 'archived' as const },
    ]) {
      observeTriggers(t, prOf({ lines: [pending('build')] }), 'me', deps);
      observeTriggers(t, prOf({ lines: [fail('build')] }), 'me', deps);
    }
    expect(triggerCardsOf(7)).toEqual([]);
    expect(triggerWatchOf(7)).toBeUndefined();
  });
});

describe('a review', () => {
  it('carries the threads with something new from someone else, fetched once', async () => {
    observeTriggers(TASK, prOf({ threads: 0 }), 'me', deps);
    const since = triggerWatchOf(7)!.reviewSince;
    threads = [
      thread('old', [['bob', since - 10, 'An old remark.']]),
      thread('new', [['bob', since + 10, 'Send it once per order.']]),
    ];
    observeTriggers(TASK, prOf({ threads: 2 }), 'me', deps);
    await flush();
    expect(asked).toBe(1);
    const [card] = triggerCardsOf(7);
    expect(card!.why).toBe('1 review thread with new comments');
    expect(card!.facts).toContain('Send it once per order.');
    expect(card!.facts).not.toContain('An old remark.');
  });

  it('a thread you opened yourself is no card', async () => {
    observeTriggers(TASK, prOf({ threads: 0 }), 'me', deps);
    threads = [thread('mine', [['me', Date.now() + 10_000_000, 'A note to self.']])];
    observeTriggers(TASK, prOf({ threads: 1 }), 'me', deps);
    await flush();
    expect(triggerCardsOf(7)).toEqual([]);
  });

  it('threads that cannot be read still make a card, saying so', async () => {
    observeTriggers(TASK, prOf(), 'me', deps);
    threads = null;
    observeTriggers(TASK, prOf({ reviews: [changesBy('bob')] }), 'me', deps);
    await flush();
    expect(triggerCardsOf(7)[0]!.facts).toContain("couldn't read the threads");
  });

  it('a second review while the first card waits as it fired: one card, covering both', async () => {
    observeTriggers(TASK, prOf({ threads: 0 }), 'me', deps);
    const since = triggerWatchOf(7)!.reviewSince;
    threads = [thread('a', [['bob', since + 10, 'First.']])];
    observeTriggers(TASK, prOf({ threads: 1 }), 'me', deps);
    await flush();
    threads = [thread('a', [['bob', since + 10, 'First.']]), thread('b', [['carol', clock + 10_000, 'Second.']])];
    observeTriggers(TASK, prOf({ threads: 2, reviews: [changesBy('carol')] }), 'me', deps);
    await flush();
    const cards = triggerCardsOf(7);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.facts).toContain('First.');
    expect(cards[0]!.facts).toContain('Second.');
    expect(cards[0]!.why).toBe('Changes requested by carol · 2 review threads with new comments');
  });

  it('…but one you edited is yours: the next review is a card of its own', async () => {
    observeTriggers(TASK, prOf({ threads: 0 }), 'me', deps);
    const since = triggerWatchOf(7)!.reviewSince;
    threads = [thread('a', [['bob', since + 10, 'First.']])];
    observeTriggers(TASK, prOf({ threads: 1 }), 'me', deps);
    await flush();
    editTriggerCard(7, triggerCardsOf(7)[0]!.id, 'my words');
    threads = [thread('b', [['carol', clock + 10_000, 'Second.']])];
    observeTriggers(TASK, prOf({ threads: 2 }), 'me', deps);
    await flush();
    expect(triggerCardsOf(7).map((c) => c.text ?? c.facts.includes('Second.'))).toEqual(['my words', true]);
  });
});

describe('stale cards go by themselves (#448 review)', () => {
  it('merged or closed outside Albedo: the approval, CI and review cards for that PR go; the merge’s draft stays', async () => {
    settings = JSON.stringify({
      merged: { mode: 'draft', template: '' },
      ciFailed: { mode: 'draft', template: '' },
      review: { mode: 'draft', template: '' },
      approved: { mode: 'suggest', template: '' },
    });
    setTriggerFiles({ read: async () => settings, write: async () => {} });
    await loadTriggerSettings(3);
    observeTriggers(TASK, prOf({ lines: [pending('build')] }), 'me', deps);
    observeTriggers(TASK, prOf({ lines: [fail('build')], reviews: [changesBy('bob')] }), 'me', deps);
    await flush();
    observeTriggers(TASK, readyPr(), 'me', deps);
    expect(triggerCardsOf(7).map((c) => c.event).sort()).toEqual(['approved', 'ciFailed', 'review']);
    // Not pinned in Needs You by cards that no longer apply.
    observeTriggers(TASK, readyPr({ state: 'merged' }), 'me', deps);
    expect(triggerCardsOf(7).map((c) => c.event)).toEqual(['merged']);
  });

  it('a closed PR leaves no card at all; a card for another PR is not touched', async () => {
    observeTriggers(TASK, prOf({ lines: [pending('build')] }), 'me', deps);
    observeTriggers(TASK, prOf({ lines: [fail('build')] }), 'me', deps);
    expect(triggerCardsOf(7)).toHaveLength(1);
    observeTriggers(TASK, prOf({ number: 999, state: 'closed' }), 'me', deps);
    expect(triggerCardsOf(7)).toHaveLength(1);
    observeTriggers(TASK, prOf({ state: 'closed' }), 'me', deps);
    expect(triggerCardsOf(7)).toEqual([]);
  });

  it('a review’s threads landing after the task was archived add no card', async () => {
    const { forgetTriggers } = await import('./store');
    observeTriggers(TASK, prOf(), 'me', deps);
    observeTriggers(TASK, prOf({ reviews: [changesBy('bob')] }), 'me', deps);
    forgetTriggers(7);
    await flush();
    expect(triggerCardsOf(7)).toEqual([]);
  });
});
