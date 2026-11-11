/**
 * @vitest-environment jsdom
 *
 * #348: a mockup waiting for approval. The card shows the page sandboxed,
 * collects comments (pinned or not), and answers only on a click; it goes
 * when the call stops waiting -- a cancel, or the transcript's error result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Preview } from '../../types';

const gate = vi.hoisted(() => ({
  waiting: new Map<number, unknown>(),
  listeners: new Set<(t: number) => void>(),
  answer: vi.fn(async () => 'taken' as const),
}));

vi.mock('../../capture/previewGate', () => ({
  pendingPreview: (t: number) => gate.waiting.get(t) ?? null,
  tasksWaitingOnPreview: () => new Set(gate.waiting.keys()),
  isPreviewWaiting: (id: string) => [...gate.waiting.values()].some((p) => (p as Preview).requestId === id),
  onPreviewChange: (cb: (t: number) => void) => {
    gate.listeners.add(cb);
    return () => gate.listeners.delete(cb);
  },
  answerPreview: gate.answer,
  outcomeOfResult: () => 'approved',
}));
vi.mock('../../db/previews', () => ({
  onPreviewsChanged: () => () => {},
  previewVersions: async () => [V1],
  previewByToolUse: async () => null,
}));
vi.mock('../theme', () => ({ resolvedTheme: () => 'light' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { PreviewCard } = await import('./PreviewCard');
const { __resetPreviewComments } = await import('./previewComments');

const V1: Preview = {
  id: 1,
  taskId: 3,
  requestId: 'r-1',
  toolUseId: 'toolu_1',
  title: 'Proposed row',
  version: 1,
  html: '<p>first</p>',
  question: null,
  note: null,
  createdAt: Date.now() - 60_000,
  outcome: 'changes',
  answer: 'changes requested on v1:\n1. x',
  answeredAt: Date.now() - 30_000,
};
const V2: Preview = {
  ...V1,
  id: 2,
  requestId: 'r-2',
  toolUseId: 'toolu_2',
  version: 2,
  html: '<!doctype html><button>Approve…</button>',
  question: 'Does the popover read as attached to the row?',
  note: 'buttons moved onto the row',
  createdAt: Date.now() - 42_000,
  outcome: 'pending',
  answer: null,
  answeredAt: null,
};

function waitOn(p: Preview | null): void {
  act(() => {
    if (p) gate.waiting.set(p.taskId, p);
    else gate.waiting.delete(3);
    for (const cb of [...gate.listeners]) cb(3);
  });
}

const terminal = vi.fn();

beforeEach(() => {
  __resetPreviewComments();
  gate.waiting.clear();
  gate.answer.mockClear();
  terminal.mockClear();
});
afterEach(() => cleanup());

describe('the waiting card', () => {
  it('shows nothing while no preview waits', () => {
    const { container } = render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the head, the question, the note, the versions and the three answers', async () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    const card = screen.getByRole('group', { name: 'Waiting on You: preview' });
    expect(within(card).getByText('Waiting on You')).toBeTruthy();
    expect(within(card).getByText('· Preview')).toBeTruthy();
    expect(within(card).getByText('Proposed row')).toBeTruthy();
    expect(within(card).getByText(': Does the popover read as attached to the row?')).toBeTruthy();
    expect(within(card).getByText('Changed since v1: buttons moved onto the row')).toBeTruthy();
    // v1 arrives from the store; v2 is the one shown.
    expect((await within(card).findByRole('button', { name: 'v1' })).getAttribute('aria-pressed')).toBe('false');
    expect(within(card).getByRole('button', { name: 'v2' }).getAttribute('aria-pressed')).toBe('true');
    const answers = within(card).getByRole('group', { name: 'Answers to the preview' });
    expect(within(answers).getAllByRole('button').map((b) => b.querySelector('.pc-option-label')?.textContent)).toEqual([
      'Approve',
      'Answer in Terminal',
    ]);
    expect(within(card).queryByRole('button', { name: /deny/i })).toBeNull();
  });

  it('sandboxes the page: scripts only, never same-origin, from the stored copy', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    const frame = screen.getByTitle('Preview: Proposed row, v2') as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    expect(frame.hasAttribute('src')).toBe(false);
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'')).toBe(true);
    expect(doc).toContain('<button>Approve…</button>');
  });

  it('Approve answers "approved" for the version waiting', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(gate.answer).toHaveBeenCalledWith(V2, 'approved', 'approved');
    // One click, one answer.
    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(gate.answer).toHaveBeenCalledTimes(1);
  });

  it('Answer in Terminal shows the terminal and answers nothing', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    fireEvent.click(screen.getByRole('button', { name: /Answer in Terminal/ }));
    expect(terminal).toHaveBeenCalledWith(3);
    expect(gate.answer).not.toHaveBeenCalled();
  });

  it('collects a pinned and a plain comment, and sends them as one answer on a click', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on a Spot' }));
    const layer = screen.getByRole('button', { name: 'Click the page to drop a pin' });
    // jsdom has no layout: give the layer a box, 400 x 200, at the origin.
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    Object.defineProperty(layer, 'clientWidth', { value: 400 });
    Object.defineProperty(layer, 'clientHeight', { value: 200 });
    fireEvent.click(layer, { clientX: 248, clientY: 36 });
    const field = screen.getByRole('textbox', { name: 'Comment on pin 1' });
    fireEvent.change(field, { target: { value: 'Approve… should be the primary button, filled.' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const plain = screen.getByRole('textbox', { name: 'Comment on version 2' });
    fireEvent.change(plain, { target: { value: 'Otherwise good.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByRole('list', { name: 'Your comments, not sent yet' }).children).toHaveLength(2);
    expect(gate.answer).not.toHaveBeenCalled(); // nothing goes on its own
    fireEvent.click(screen.getByRole('button', { name: /Send 2 Comments/ }));
    expect(gate.answer).toHaveBeenCalledWith(
      V2,
      'changes',
      [
        'changes requested on v2:',
        '1. (pin 1, about 62% across and 18% down the page) Approve… should be the primary button, filled.',
        '2. Otherwise good.',
      ].join('\n'),
    );
  });

  it('retires when the call stops waiting: a cancel, or the transcript’s error result', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    expect(screen.getByRole('group', { name: 'Waiting on You: preview' })).toBeTruthy();
    // previewGate retires the call on either (previewGate.test.ts); the card follows.
    waitOn(null);
    expect(screen.queryByRole('group', { name: 'Waiting on You: preview' })).toBeNull();
  });

  it('opens large in the reading pane with the same answers, and Esc closes it', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Large' }));
    const card = screen.getByRole('group', { name: 'Waiting on You: preview' });
    expect(card.classList.contains('pv-card-large')).toBe(true);
    expect(within(card).getByRole('button', { name: /^Approve/ })).toBeTruthy();
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(card.classList.contains('pv-card-large')).toBe(false);
  });

  it('Light / Dark sets the page’s scheme, not the app’s', () => {
    waitOn(V2);
    render(<PreviewCard taskId={3} onAnswerInTerminal={terminal} />);
    const frame = () => screen.getByTitle('Preview: Proposed row, v2');
    expect(frame().getAttribute('srcdoc')).toContain('var dark=false;');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(frame().getAttribute('srcdoc')).toContain('var dark=true;');
    expect(frame().style.colorScheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });
});
