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
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';

vi.mock('../ui/Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../git/worktree', async () => ({
  ...(await vi.importActual<typeof import('../git/worktree')>('../git/worktree')),
  commitsOnBranch: vi.fn(async () => 3),
}));
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));
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
const { useTriggerBoxWatch } = await import('../ui/triggers/useTriggerBoxWatch');
const { PrBadge } = await import('../ui/PrBadge');
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
/** The same task as the task bar is handed it. */
const BAR_TASK = {
  ...TASK,
  title: 'checkout-retry',
  sessionId: null,
  createdAt: 1,
  lastActivityAt: null,
  ownsWorktree: true,
  createdBranch: true,
  seenAt: null,
  summary: null,
  apiError: null,
  apiErrorText: null,
  spunFromTaskId: null,
} as unknown as import('../types').Task;

/**
 * Everything the app mounts that could act on a card without a click: the
 * watch, the box watch, the cards, and the task bar's PR badge with its real
 * merge dialog (and `mergePr` mocked).
 */
async function mountApp(): Promise<void> {
  renderHook(() => {
    useTriggers([TASK]);
    useTriggerBoxWatch();
  });
  render(
    <>
      <PrBadge task={BAR_TASK} />
      <TriggerCards taskId={TASK.id} status="idle" />
    </>,
  );
  // The badge asks for its PR on mount: let that settle before the answers.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

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
    offs.pop()?.(); // the real task bar answers merge requests here
    await mountApp();

    await answerWith(prOf({ lines: [pending('build')] })); // history
    await answerWith(prOf({ lines: [fail('build')] })); // CI failed
    await answerWith(prOf({ lines: [pending('build')], reviews: [changesBy('bob')], threads: 1 })); // review
    await answerWith(readyPr({ reviews: [changesBy('bob', '2026-11-19T09:00:00Z')] })); // approved
    // The review's card lands once its threads are read, so after the approval's.
    expect(triggerCardsOf(TASK.id).map((c) => c.event).sort()).toEqual(['approved', 'ciFailed', 'review']);
    expect(screen.getAllByRole('group', { name: /^Waiting on You:/ })).toHaveLength(3);
    nothingActed();
    await answerWith(readyPr({ state: 'merged' })); // merged
    expect(screen.getAllByRole('group', { name: /^Waiting on You:/ })).toHaveLength(1);
    // The PR merged on GitHub: the approval, CI and review cards are moot and
    // went by themselves; the merge's own draft is the point and stays.
    expect(triggerCardsOf(TASK.id).map((c) => c.event)).toEqual(['merged']);
    expect(screen.queryByRole('dialog')).toBeNull();
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
    // Merged on GitHub: the approval's card went by itself; the merge's draft waits.
    expect(triggerCardsOf(TASK.id).map((c) => c.event)).toEqual(['merged']);
    nothingActed();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(submitPty).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitPty).mock.calls[0]![1]).toBe(
      '/after-merge — watch the deploy.\n\nPR #412 "Send the confirmation once per order", merged as 3f9c2e1.',
    );
    expect(triggerCardsOf(TASK.id)).toEqual([]);
    expect(merges).toEqual([]);
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('Squash and Merge… on a ready PR opens the task bar’s dialog; only its own confirm merges', async () => {
    offs.pop()?.(); // the real task bar answers
    await mountApp();
    await answerWith(prOf({ lines: [pending('build')] }));
    await answerWith(readyPr());
    nothingActed();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Two Squash and Merge… buttons now: the task bar's and the card's.
    const card = screen.getByRole('group', { name: /^Waiting on You:/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Squash and Merge…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Squash and Merge PR #412?' });
    expect(mergePr).not.toHaveBeenCalled();
    expect(submitPty).not.toHaveBeenCalled();
    // The card stays until the merge is done.
    expect(triggerCardsOf(TASK.id)).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Squash and Merge' }));
    });
    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(triggerCardsOf(TASK.id)).toHaveLength(0);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('Skip only removes the card', async () => {
    renderHook(() => useTriggers([TASK]));
    render(<TriggerCards taskId={TASK.id} status="idle" />);
    await answerWith(prOf({ lines: [pending('build')] }));
    await answerWith(readyPr());
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(triggerCardsOf(TASK.id)).toHaveLength(0);
    nothingActed();
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
  it('nothing behind the watch, the store or the box watch can reach a way to send, hold, release, insert or merge', async () => {
    // Every runtime export of the modules that send, hold, release or insert,
    // read from the modules themselves -- not a list kept by hand.
    const modules = await Promise.all([
      vi.importActual<Record<string, unknown>>('../ui/transcript/send'),
      vi.importActual<Record<string, unknown>>('../ui/transcript/outbox'),
      vi.importActual<Record<string, unknown>>('../ui/transcript/outboxRelease'),
      vi.importActual<Record<string, unknown>>('../ui/sendPrompt'),
      vi.importActual<Record<string, unknown>>('../ui/reminders/send'),
      vi.importActual<Record<string, unknown>>('../ui/transcript/composerBridge'),
    ]);
    // Listening is not acting: the box watch hears what was delivered, to remove a card.
    const listening = new Set(['onSessionSubmit']);
    const names = new Set(modules.flatMap((m) => Object.keys(m)).filter((n) => !listening.has(n)));
    // And what reaches the pty or GitHub directly.
    for (const n of ['submitPty', 'startPty', 'mergePr', 'MergeDialog']) names.add(n);
    expect(names.has('sendToSession') && names.has('sendPrompt') && names.has('sendNow') && names.has('holdMessage')).toBe(true);
    const forbidden = new RegExp(`\\b(${[...names].join('|')})\\b|/Terminal'|reminders/send'|sendPrompt'|composerBridge'|outboxRelease'|transcript/outbox'`);

    const dirs = [join(process.cwd(), 'src/triggers'), join(process.cwd(), 'src/ui/triggers')];
    const files = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'fixtures.ts')
        .map((f) => join(d, f)),
    );
    const checked = files.filter((f) => !f.endsWith('/TriggerCard.tsx')).map((f) => f.slice(process.cwd().length + 1));
    // Only the card -- its buttons are the click path -- is let through.
    expect(checked.sort()).toEqual([
      'src/triggers/detect.ts',
      'src/triggers/facts.ts',
      'src/triggers/settings.ts',
      'src/triggers/store.ts',
      'src/triggers/useTriggers.ts',
      'src/ui/triggers/TriggersSheet.tsx',
      'src/ui/triggers/useTriggerBoxWatch.ts',
    ]);
    for (const f of checked) {
      expect(readFileSync(join(process.cwd(), f), 'utf8'), f).not.toMatch(forbidden);
    }
  });
});
