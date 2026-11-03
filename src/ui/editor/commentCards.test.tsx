// @vitest-environment jsdom
/**
 * The comment card and the bar above a file (#222): a state chip that is
 * never a ✓, one main action with the rest behind ⋯, the File mode's widget
 * drawing the same card as the Diff mode's, and a sent comment whose lines
 * changed resolving itself with a trace and Reopen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ReviewComment } from '../../db/comments';

const db = vi.hoisted(() => ({ rows: [] as ReviewComment[], resolved: [] as number[][], reopened: [] as number[] }));
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => db.rows),
    onCommentsChanged: vi.fn(() => () => {}),
    resolveComments: vi.fn(async (_t: number, ids: number[]) => void db.resolved.push(ids)),
    reopenComment: vi.fn(async (_t: number, id: number) => void db.reopened.push(id)),
    resolveComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
});

const { CommentCardView } = await import('./CommentViews');
const { commentsExtension, setPlacedComments } = await import('./comments');
const { useDiffComments } = await import('./diffComments');
const { ago, cardState } = await import('./commentLabels');

afterEach(() => {
  cleanup();
  db.rows = [];
  db.resolved = [];
  db.reopened = [];
});

const base: ReviewComment = {
  id: 1, taskId: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'two', body: 'Rename this.',
  createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null,
};
const noop = () => {};

describe('the card', () => {
  it('a waiting comment: its chip says where it goes, Edit is the action, Resolve and Delete behind ⋯', () => {
    render(<CommentCardView comment={base} onEdit={noop} onResolve={noop} onDelete={noop} />);
    expect(screen.getByText('Waiting · goes with your next message').getAttribute('data-state')).toBe('waiting');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '✓ Resolve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: '✓ Resolve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('a sent one: ↗ Sent with when, never a ✓ on the chip, and Resolve is the action', () => {
    const now = Date.now();
    render(<CommentCardView comment={{ ...base, sentAt: now - 4 * 60_000 }} onEdit={noop} onResolve={noop} onDelete={noop} />);
    const chip = screen.getByText(/^↗ Sent/);
    expect(chip.textContent).toBe('↗ Sent 4 min ago');
    expect(chip.textContent).not.toContain('✓');
    expect(chip.closest('.ed-cmt')?.getAttribute('data-state')).toBe('sent');
    expect(screen.getByRole('button', { name: '✓ Resolve' }).className).toContain('ed-cmt-primary');
  });

  it('the File mode widget draws the same card from the same state', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: 'one\ntwo\nthree', extensions: [commentsExtension(() => null)] }),
    });
    try {
      const sent = { ...base, sentAt: Date.now() - 4 * 60_000 };
      view.dispatch({ effects: setPlacedComments.of([{ comment: sent, from: view.state.doc.line(2).from, to: view.state.doc.line(2).to }]) });
      const card = host.querySelector('.ed-cmt')!;
      expect(card.getAttribute('data-state')).toBe('sent');
      expect(card.querySelector('.ed-cmt-chip')?.textContent).toBe(cardState(sent).chip);
      const visible = [...card.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent);
      expect(visible).toEqual(['✓ Resolve', '⋯']);
      fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'More actions' }));
      expect([...card.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent)).toEqual([
        '✓ Resolve',
        'Edit',
        'Delete',
        '⋯',
      ]);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('says how long ago in plain words', () => {
    expect(ago(0, 30_000)).toBe('just now');
    expect(ago(0, 4 * 60_000)).toBe('4 min ago');
    expect(ago(0, 3 * 3_600_000)).toBe('3 h ago');
  });
});

describe('the bar above a diff (Diff mode and the guide)', () => {
  it('a sent comment whose lines changed resolves itself and leaves a trace with Reopen', async () => {
    db.rows = [{ ...base, sentAt: 5 }];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', 'one\nTWO\nthree\n', false));
    await waitFor(() => expect(db.resolved).toEqual([[1]]));
    render(<>{result.current.bar}</>);
    expect(screen.getByText(/Resolved: Line 2 changed after it was sent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(db.reopened).toEqual([1]);
  });

  it('an unsent one whose lines are gone is listed as outdated, never resolved', async () => {
    db.rows = [base];
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', 'one\nTWO\nthree\n', false));
    await waitFor(() => {
      render(<>{result.current.bar}</>);
      expect(screen.getByText(/no longer match its code/)).toBeTruthy();
    });
    expect(db.resolved).toEqual([]);
  });

  it('nothing resolves while the editor holds unsaved typing', async () => {
    db.rows = [{ ...base, sentAt: 5 }];
    renderHook(() => useDiffComments(1, 'src/a.ts', 'one\nTWO\nthree\n', true));
    await new Promise((r) => setTimeout(r, 20));
    expect(db.resolved).toEqual([]);
  });
});
