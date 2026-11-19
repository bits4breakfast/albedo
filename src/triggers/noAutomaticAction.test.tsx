/**
 * @vitest-environment jsdom
 *
 * Nothing is automatic (#448, the owner's rule). Every trigger turned on --
 * each Draft and the approval's Suggest -- and every event happening, through
 * the real PR store, the real watch and the cards on screen: nothing is typed
 * into a session, held for one, put in a message box, or merged. Then one
 * click does exactly one thing: Send sends that one draft; Squash and Merge…
 * asks the task bar to open its dialog, and nothing merges.
 *
 * And by construction: no module behind the watch can reach a way to send or
 * merge -- they are only imported by the card, behind its buttons.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('../ui/Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../gh/gh', async () => ({
  ...(await vi.importActual<typeof import('../gh/gh')>('../gh/gh')),
  mergePr: vi.fn(async () => ({ ok: true })),
}));

const { submitPty } = await import('../ui/Terminal');
const { mergePr, resetViewerLoginForTests } = await import('../gh/gh');
const { refreshPrStatus, setPrFetcherForTests } = await import('../gh/prStore');
const { setThreadsFetcherForTests } = await import('../gh/reviewThreads');
const { __resetOutbox, heldFor } = await import('../ui/transcript/outbox');
const { __resetQueuedCi } = await import('../ui/transcript/ciFailure');
const { onComposerInsert } = await import('../ui/transcript/composerBridge');
const { DEFAULT_TRIGGERS, setTriggerFiles } = await import('./settings');
const { __resetTriggerStore, onTriggerMergeRequest, triggerCardsOf } = await import('./store');
const { useTriggers } = await import('./useTriggers');
const { TriggerCards } = await import('../ui/triggers/TriggerCard');
const { changesBy, fail, pending, prOf, readyPr } = await import('./fixtures');
type PrStatus = import('../gh/prStatus').PrStatus;

const TASK = {
  id: 7,
  projectId: 3,
  status: 'idle' as const,
  kind: 'work' as const,
  reviewUrl: null,
  worktreePath: '/tmp/sample/wt',
  repoPath: '/tmp/sample/repo',
  branch: 'checkout-retry',
  baseBranch: 'main',
};

/** Every trigger on. */
const ALL_ON = JSON.stringify({
  version: 1,
  merged: { mode: 'draft', template: '/after-merge — watch the deploy.' },
  ciFailed: { mode: 'draft', template: 'Fix the failing checks.' },
  review: { mode: 'draft', template: 'Address these review threads.' },
  approved: { mode: 'suggest', template: '' },
});

let answer: PrStatus | null = null;
const inserts: string[] = [];
const merges: number[] = [];
let offs: Array<() => void> = [];

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
  __resetOutbox();
  __resetQueuedCi();
  resetViewerLoginForTests('me');
  setTriggerFiles({ read: async () => ALL_ON, write: async () => {} });
  setPrFetcherForTests(async () => answer, () => Date.now());
  setThreadsFetcherForTests(async () => []);
  vi.mocked(submitPty).mockClear();
  vi.mocked(mergePr).mockClear();
  inserts.length = 0;
  merges.length = 0;
  offs = [
    // A message box and a task bar that only record what reaches them.
    onComposerInsert((i) => {
      inserts.push(i.text);
      return true;
    }),
    onTriggerMergeRequest((id) => {
      merges.push(id);
      return true;
    }),
  ];
});

afterEach(() => {
  cleanup();
  for (const off of offs) off();
  setTriggerFiles({ read: async () => null, write: async () => {} });
  resetViewerLoginForTests(null);
});

/** One PR answer through the real store, and every listener after it. */
async function answerWith(pr: PrStatus): Promise<void> {
  answer = pr;
  await act(async () => {
    await refreshPrStatus(TASK, { force: true });
  });
  // The review's threads arrive on their own promise.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function nothingActed(): void {
  expect(submitPty).not.toHaveBeenCalled();
  expect(heldFor(TASK.id)).toEqual([]);
  expect(inserts).toEqual([]);
  expect(merges).toEqual([]);
  expect(mergePr).not.toHaveBeenCalled();
}

describe('nothing is automatic', () => {
  it('every event with every trigger on: cards appear, and nothing is sent, held, put in the box or merged', async () => {
    renderHook(() => useTriggers([TASK]));
    render(<TriggerCards taskId={TASK.id} status="idle" />);

    await answerWith(prOf({ lines: [pending('build')] })); // history
    await answerWith(prOf({ lines: [fail('build')] })); // CI failed
    await answerWith(prOf({ lines: [pending('build')], reviews: [changesBy('bob')], threads: 1 })); // review
    await answerWith(readyPr({ reviews: [changesBy('bob', '2026-11-19T09:00:00Z')] })); // approved
    await answerWith(readyPr({ state: 'merged' })); // merged

    // The review's card lands once its threads are read, so after the approval's.
    expect(triggerCardsOf(TASK.id).map((c) => c.event).sort()).toEqual(['approved', 'ciFailed', 'merged', 'review']);
    expect(screen.getAllByRole('group', { name: /^Waiting on You:/ })).toHaveLength(4);
    nothingActed();

    // Waiting a while changes nothing: no timer acts either.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    nothingActed();
  });

  it('Send sends that one draft, once; Squash and Merge… only asks the task bar to open its dialog', async () => {
    renderHook(() => useTriggers([TASK]));
    render(<TriggerCards taskId={TASK.id} status="idle" />);
    await answerWith(prOf({ lines: [pending('build')] }));
    await answerWith(readyPr());
    await answerWith(readyPr({ state: 'merged' }));
    nothingActed();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(submitPty).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitPty).mock.calls[0]![1]).toBe(
      '/after-merge — watch the deploy.\n\nPR #412 "Send the confirmation once per order", merged as 3f9c2e1.',
    );
    expect(triggerCardsOf(TASK.id).map((c) => c.event)).toEqual(['approved']);

    // The approval was offered before the merge; the PR is merged now, so
    // its button is gone and only Skip is left.
    expect(screen.queryByRole('button', { name: 'Squash and Merge…' })).toBeNull();
    expect(merges).toEqual([]);
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('Squash and Merge… on a ready PR opens the dialog, and nothing merges by itself', async () => {
    renderHook(() => useTriggers([TASK]));
    render(<TriggerCards taskId={TASK.id} status="idle" />);
    await answerWith(prOf({ lines: [pending('build')] }));
    await answerWith(readyPr());
    nothingActed();
    fireEvent.click(screen.getByRole('button', { name: 'Squash and Merge…' }));
    expect(merges).toEqual([TASK.id]);
    expect(mergePr).not.toHaveBeenCalled();
    expect(submitPty).not.toHaveBeenCalled();
    // The card stays until the merge is done (or Skip).
    expect(triggerCardsOf(TASK.id)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(triggerCardsOf(TASK.id)).toHaveLength(0);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('with every trigger Off, events leave no card at all', async () => {
    setTriggerFiles({ read: async () => JSON.stringify(DEFAULT_TRIGGERS), write: async () => {} });
    renderHook(() => useTriggers([TASK]));
    await answerWith(prOf({ lines: [pending('build')] }));
    await answerWith(prOf({ lines: [fail('build')] }));
    await answerWith(readyPr({ state: 'merged' }));
    expect(triggerCardsOf(TASK.id)).toEqual([]);
    nothingActed();
  });
});

describe('by construction', () => {
  it('nothing behind the watch can reach a way to send, hold, insert or merge', () => {
    const dir = join(process.cwd(), 'src/triggers');
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'fixtures.ts');
    expect(sources.sort()).toEqual(['detect.ts', 'facts.ts', 'settings.ts', 'store.ts', 'useTriggers.ts']);
    const forbidden = /\b(submitPty|submitLocked|sendToSession|holdMessage|sendReminderText|insertIntoComposer|mergePr|startPty)\b|transcript\/send'|transcript\/outbox'|\/Terminal'|composerBridge'/;
    for (const f of sources) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(forbidden);
    }
  });
});
