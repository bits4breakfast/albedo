/**
 * @vitest-environment jsdom
 *
 * A trigger's card (#448), driven through its rendered buttons: Send goes the
 * usual way (now, or held -- never typed into a prompt or a dead session);
 * Edit in Message Box moves the draft to the box and the card waits, folded,
 * for that message; a CI draft carries CI Details' failure and handles the
 * queued copy so Claude is not told twice; Skip only removes the card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));

const { submitPty, hasLivePty } = await import('../Terminal');
const { __resetOutbox, heldFor } = await import('../transcript/outbox');
const { __resetQueuedCi, observeCiQueue, queuedCiOf, setQueuedCiDetails, detailsKey } = await import('../transcript/ciFailure');
const { onComposerInsert } = await import('../transcript/composerBridge');
const { __resetTriggerStore, addTriggerCard, triggerCardsOf } = await import('../../triggers/store');
const { cardFor } = await import('../../triggers/facts');
const { triggerStep } = await import('../../triggers/detect');
const { TriggerCards } = await import('./TriggerCard');
const { useTriggerBoxWatch } = await import('./useTriggerBoxWatch');
const { sendToSession } = await import('../transcript/send');
const { MERGE_SHA, SHA_A, fail, pending, prOf } = await import('../../triggers/fixtures');

const base = { prNumber: 412, prTitle: 'Send the confirmation once per order', prUrl: 'https://github.com/example/shop/pull/412' };
const MERGED = cardFor({ ...base, event: 'merged', mergeCommit: MERGE_SHA }, 'draft', '/after-merge — watch the deploy.', Date.now());
const BODY = '/after-merge — watch the deploy.\n\nPR #412 "Send the confirmation once per order", merged as 3f9c2e1.';

const inserts: string[] = [];
let off: () => void = () => {};

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
  vi.mocked(submitPty).mockClear();
  vi.mocked(hasLivePty).mockReturnValue(true);
  inserts.length = 0;
  off = onComposerInsert((i) => {
    inserts.push(i.text);
    return true;
  });
});
afterEach(() => {
  cleanup();
  off();
});

describe('the draft', () => {
  it('shows the head, the time, the message, and says it is not sent', () => {
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="idle" />);
    const card = screen.getByRole('group', { name: 'Waiting on You: PR #412 was merged' });
    expect(card.textContent).toContain('Trigger · Draft ·');
    expect((screen.getByRole('textbox', { name: 'The drafted message' }) as HTMLTextAreaElement).value).toBe(BODY);
    expect(screen.getByText('Not sent. Edit it here or Send as is.')).toBeTruthy();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('an edit is kept (across a restart too), and is what Send sends', async () => {
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="idle" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'The drafted message' }), { target: { value: 'my own words' } });
    // Closing the app right after typing: written on the way out.
    window.dispatchEvent(new Event('pagehide'));
    __resetTriggerStore();
    expect(triggerCardsOf(7)[0]!.text).toBe('my own words');
    cleanup();
    render(<TriggerCards taskId={7} status="idle" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(vi.mocked(submitPty).mock.calls).toEqual([[7, 'my own words']]);
    expect(triggerCardsOf(7)).toEqual([]);
  });

  it('⌘↩ in the message sends it', async () => {
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="idle" />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'The drafted message' }), { key: 'Enter', metaKey: true });
    });
    expect(vi.mocked(submitPty).mock.calls).toEqual([[7, BODY]]);
  });

  it('while Claude waits on you, or with no session running, it is held -- never typed into a prompt', async () => {
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="blocked" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(7).map((h) => h.text)).toEqual([BODY]);
    expect(triggerCardsOf(7)).toEqual([]);

    __resetOutbox();
    cleanup();
    vi.mocked(hasLivePty).mockReturnValue(false);
    addTriggerCard(8, MERGED);
    render(<TriggerCards taskId={8} status="idle" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(8).map((h) => h.text)).toEqual([BODY]);
  });

  it('Skip removes the card, and nothing else', () => {
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(triggerCardsOf(7)).toEqual([]);
    expect(submitPty).not.toHaveBeenCalled();
    expect(heldFor(7)).toEqual([]);
    expect(inserts).toEqual([]);
  });
});

describe('Edit in Message Box', () => {
  it('moves the text to the box; the card folds and goes once a message carrying it is sent', async () => {
    renderHook(() => useTriggerBoxWatch());
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Message Box' }));
    expect(inserts).toEqual([BODY]);
    expect(submitPty).not.toHaveBeenCalled();
    // Not shown twice: the card folds to a line and Skip.
    expect(screen.queryByRole('textbox', { name: 'The drafted message' })).toBeNull();
    expect(screen.getByText(/Your draft is in the message box/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();

    // Another message, without it: the card stays.
    await act(async () => {
      await sendToSession(7, 'something else');
    });
    expect(triggerCardsOf(7)).toHaveLength(1);
    // The box's message, edited around it: gone.
    await act(async () => {
      await sendToSession(7, `Before that:\n${BODY}\nThanks`);
    });
    expect(triggerCardsOf(7)).toEqual([]);
  });

  it('with no message box open for the task, says so and keeps the card as it was', () => {
    off();
    addTriggerCard(7, MERGED);
    render(<TriggerCards taskId={7} status="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Message Box' }));
    expect(screen.getByText('The message box is not open for this task.')).toBeTruthy();
    expect(triggerCardsOf(7)[0]!.inBox).toBeUndefined();
  });
});

describe('a CI draft', () => {
  function ciCard() {
    const a = triggerStep(undefined, prOf({ lines: [pending('build')] }), 'me', 1);
    const fire = triggerStep(a.watch, prOf({ lines: [fail('build')] }), 'me', 2).fires[0]!;
    return cardFor(fire, 'draft', 'Fix the failing checks.', Date.now());
  }

  it('carries CI Details’ failure for the same commit, live; sending it handles the queued copy', async () => {
    const pr = prOf({ lines: [fail('build')] });
    observeCiQueue(7, pr);
    const queued = queuedCiOf(7)!;
    setQueuedCiDetails(7, detailsKey(queued), { state: 'fetching' });
    addTriggerCard(7, ciCard());
    render(<TriggerCards taskId={7} status="idle" />);
    expect(screen.getByText(/CI Details is still fetching/)).toBeTruthy();
    act(() => {
      setQueuedCiDetails(7, detailsKey(queued), {
        state: 'ready',
        checks: [{ name: 'build', step: 'Run tests', log: ['FAIL src/order.test.ts'], more: 0 }],
      });
    });
    const text = (screen.getByRole('textbox', { name: 'The drafted message' }) as HTMLTextAreaElement).value;
    expect(text.startsWith(`Fix the failing checks.\n\nCI failed on PR #412 (${SHA_A.slice(0, 7)}):\n- build: failed`)).toBe(true);
    expect(text).toContain('FAIL src/order.test.ts');
    expect(screen.queryByText(/CI Details is still fetching/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(vi.mocked(submitPty).mock.calls).toEqual([[7, text]]);
    // Not again with the next message: that commit's failure is handled.
    expect(queuedCiOf(7)).toBeNull();
    observeCiQueue(7, pr);
    expect(queuedCiOf(7)).toBeNull();
  });

  it('moved to the box, handles the queued copy too, as Ask Claude to Fix does', () => {
    observeCiQueue(7, prOf({ lines: [fail('build')] }));
    addTriggerCard(7, ciCard());
    render(<TriggerCards taskId={7} status="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Message Box' }));
    expect(inserts).toHaveLength(1);
    expect(queuedCiOf(7)).toBeNull();
  });
});

describe('a CI failure reaches Claude once (#448 review)', () => {
  function ciCardFor() {
    const a = triggerStep(undefined, prOf({ lines: [pending('build')] }), 'me', 1);
    const fire = triggerStep(a.watch, prOf({ lines: [fail('build')] }), 'me', 2).fires[0]!;
    return cardFor(fire, 'draft', 'Fix the failing checks.', Date.now());
  }

  it('the queued copy went with an ordinary message: the card for that commit goes', async () => {
    const { takeQueuedCi } = await import('../transcript/ciFailure');
    renderHook(() => useTriggerBoxWatch());
    observeCiQueue(7, prOf({ lines: [fail('build')] }));
    addTriggerCard(7, ciCardFor());
    // Another commit's failure leaves it.
    act(() => takeQueuedCi(7, 'another-commit'));
    expect(triggerCardsOf(7)).toHaveLength(1);
    act(() => takeQueuedCi(7, SHA_A));
    expect(triggerCardsOf(7)).toEqual([]);
  });

  it('the card sent it: the queued copy goes, and does not come back', async () => {
    renderHook(() => useTriggerBoxWatch());
    observeCiQueue(7, prOf({ lines: [fail('build')] }));
    addTriggerCard(7, ciCardFor());
    render(<TriggerCards taskId={7} status="idle" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    });
    expect(submitPty).toHaveBeenCalledTimes(1);
    expect(queuedCiOf(7)).toBeNull();
  });
});
