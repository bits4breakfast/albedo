// @vitest-environment jsdom
/**
 * Comments on removed lines in a diff (#402), as the editor's Diff mode and
 * the guide provide them: offered only with a base, written on the base's
 * lines and text, shown under their deleted rows, never resolved for being
 * missing, and resolved once sent when their lines are back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReviewComment } from '../../db/comments';

const addComment = vi.fn(async () => 1);
const addCommentsTogether = vi.fn(async () => {});
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => []),
    onCommentsChanged: vi.fn(() => () => {}),
    addComment,
    addCommentsTogether,
    editComment: vi.fn(async () => {}),
    resolveComment: vi.fn(async () => {}),
    resolveComments: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
});

const db = await import('../../db/comments');
const { useDiffComments } = await import('./diffComments');

afterEach(() => {
  cleanup();
  addComment.mockClear();
  addCommentsTogether.mockClear();
  vi.mocked(db.listComments).mockResolvedValue([]);
  vi.mocked(db.resolveComments).mockClear();
});

// A made-up change: one guard dropped, one line rewritten.
const BASE = 'start\nif (!ready) return;\nrun(1);\nend\n';
const NOW = 'start\nrun(2);\nend\n';

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 7, taskId: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'if (!ready) return;', body: 'Why drop the guard?',
    createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null, side: 'old', ...over,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('offering comments on deleted rows', () => {
  it('only with a base: without one, deleted rows take none', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false));
    expect(result.current.annotations?.removed).toBeUndefined();
    expect(result.current.annotations?.pickBoth).toBeUndefined();
    const { result: withBase } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    expect(withBase.current.annotations?.removed).toBeDefined();
  });
});

describe('writing one', () => {
  it('a + on a deleted row opens a box under it, and stores the base’s lines and text', async () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    const removed = result.current.annotations!.removed!;
    act(() => removed.pick(2, 3, false));
    expect(result.current.annotations!.removed!.picking).toEqual({ from: 2, to: 3 });
    act(() => result.current.annotations!.removed!.pick(2, 3, true));
    // Under the deleted row, not under the file's line 3.
    expect(result.current.annotations!.after(3)).toBeNull();
    render(<>{result.current.annotations!.removed!.after(3)}</>);
    expect(screen.getByText('On removed lines 2–3')).toBeTruthy();
    const box = screen.getByPlaceholderText(/Leave a comment/);
    fireEvent.change(box, { target: { value: 'Why drop these?' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({
      taskId: 1,
      path: 'src/a.ts',
      lineStart: 2,
      lineEnd: 3,
      anchorText: 'if (!ready) return;\nrun(1);',
      body: 'Why drop these?',
      side: 'old',
    });
  });

  it('refused, and said why, while the editor has unsaved edits', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, true, true, null, BASE));
    act(() => result.current.annotations!.removed!.pick(2, 2, true));
    expect(result.current.notice).toMatch(/Save your edits first/);
    expect(result.current.annotations!.removed!.after(2)).toBeNull();
  });

  it('a selection over both sides: one box, saved as one comment per side, in one write', async () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    act(() => result.current.annotations!.pickBoth!({ from: 2, to: 2 }, { from: 2, to: 3 }));
    render(<>{result.current.annotations!.after(2)}</>);
    expect(screen.getByText('On removed lines 2–3 and line 2')).toBeTruthy();
    const box = screen.getByPlaceholderText(/Leave a comment/);
    fireEvent.change(box, { target: { value: 'Same question.' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addCommentsTogether).toHaveBeenCalledOnce());
    expect(addCommentsTogether).toHaveBeenCalledWith([
      { taskId: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 3, anchorText: 'if (!ready) return;\nrun(1);', body: 'Same question.', side: 'old' },
      { taskId: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'run(2);', body: 'Same question.' },
    ]);
    expect(addComment).not.toHaveBeenCalled();
  });

  it('a failed write of both sides keeps the box, and stores neither', async () => {
    addCommentsTogether.mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    act(() => result.current.annotations!.pickBoth!({ from: 2, to: 2 }, { from: 2, to: 3 }));
    render(<>{result.current.annotations!.after(2)}</>);
    const box = screen.getByPlaceholderText(/Leave a comment/);
    fireEvent.change(box, { target: { value: 'Same question.' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(result.current.notice).toMatch(/Could not save the comment.*disk full/));
    expect(addComment).not.toHaveBeenCalled();
  });

  it('a base read before the PR status settled places a removed comment but never resolves it', async () => {
    vi.mocked(db.listComments).mockResolvedValue([comment({ sentAt: 5 })]);
    const back = 'start\nif (!ready) return;\nrun(2);\nend\n';
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', back, false, true, null, BASE, false));
    await waitFor(() => expect(vi.mocked(db.listComments)).toHaveBeenCalled());
    await settle();
    expect(db.resolveComments).not.toHaveBeenCalled();
    render(<>{result.current.bar}</>);
    expect(screen.getByText(/its lines are back/)).toBeTruthy();
  });
});

describe('placing one', () => {
  it('shows its card under its deleted row, marked as on removed lines', async () => {
    vi.mocked(db.listComments).mockResolvedValue([comment()]);
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    await waitFor(() => expect(result.current.annotations!.removed!.after(2)).not.toBeNull());
    expect(result.current.annotations!.removed!.commented!(2)).toBe(true);
    // Never on the file's line 2, which holds other code.
    expect(result.current.annotations!.after(2)).toBeNull();
    const { container } = render(<>{result.current.annotations!.removed!.after(2)}</>);
    expect(screen.getByText('On removed line 2')).toBeTruthy();
    expect(container.querySelector('.ed-cmt')!.getAttribute('data-side')).toBe('old');
  });

  it('a sent one never resolves because its lines are missing from the file', async () => {
    vi.mocked(db.listComments).mockResolvedValue([comment({ sentAt: 5 })]);
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    await waitFor(() => expect(result.current.annotations!.removed!.after(2)).not.toBeNull());
    await settle();
    expect(db.resolveComments).not.toHaveBeenCalled();
  });

  it('a sent one resolves itself when its lines are back, and leaves a trace saying so', async () => {
    vi.mocked(db.listComments).mockResolvedValue([comment({ sentAt: 5 })]);
    const back = 'start\nif (!ready) return;\nrun(2);\nend\n';
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', back, false, true, null, BASE));
    await waitFor(() => expect(db.resolveComments).toHaveBeenCalledWith(1, [7]));
    render(<>{result.current.bar}</>);
    expect(screen.getByText(/Removed line 2 is back in the file/)).toBeTruthy();
  });

  it('not against a remembered read, nor while unsent: then it is in the bar', async () => {
    vi.mocked(db.listComments).mockResolvedValue([comment({ sentAt: 5 }), comment({ id: 8, body: 'Unsent one.' })]);
    const back = 'start\nif (!ready) return;\nrun(2);\nend\n';
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', back, false, false, null, BASE));
    await waitFor(() => expect(vi.mocked(db.listComments)).toHaveBeenCalled());
    await settle();
    expect(db.resolveComments).not.toHaveBeenCalled();
    render(<>{result.current.bar}</>);
    expect(screen.getByText(/Unsent one\./)).toBeTruthy();
    expect(screen.getAllByText(/On removed line 2/)).toHaveLength(2);
  });

  it('when the base no longer has its text, it is in the bar and stays open', async () => {
    vi.mocked(db.listComments).mockResolvedValue([comment({ sentAt: 5 })]);
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, 'other\nbase\n'));
    await waitFor(() => expect(vi.mocked(db.listComments)).toHaveBeenCalled());
    await settle();
    expect(db.resolveComments).not.toHaveBeenCalled();
    render(<>{result.current.bar}</>);
    expect(screen.getByText(/Why drop the guard\?/)).toBeTruthy();
  });
});
