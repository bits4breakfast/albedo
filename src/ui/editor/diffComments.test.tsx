// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

const addComment = vi.fn(async () => 1);
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => []),
    onCommentsChanged: vi.fn(() => () => {}),
    addComment,
    editComment: vi.fn(async () => {}),
    resolveComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
});

const { useDiffComments } = await import('./diffComments');

afterEach(() => {
  cleanup();
  addComment.mockClear();
});

const NOW = 'one\ntwo\nthree\nfour\n';

describe('useDiffComments', () => {
  it('refuses to start a comment while the editor has unsaved edits, and says why', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, true));
    act(() => result.current.annotations!.pick(2, 3, true));
    expect(result.current.notice).toMatch(/Save your edits first/);
    expect(result.current.annotations!.after(3)).toBeNull();
  });

  it('opens a draft under the last picked line and stores the current file’s lines', async () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false));
    act(() => result.current.annotations!.pick(2, 3, false));
    expect(result.current.annotations!.picking).toEqual({ from: 2, to: 3 });
    act(() => result.current.annotations!.pick(2, 3, true));
    expect(result.current.annotations!.picking).toBeNull();
    expect(result.current.annotations!.after(2)).toBeNull();

    render(<>{result.current.annotations!.after(3)}</>);
    const box = screen.getByPlaceholderText(/Leave a comment/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'First line.\nSecond line.' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({
      taskId: 1,
      path: 'src/a.ts',
      lineStart: 2,
      lineEnd: 3,
      anchorText: 'two\nthree',
      body: 'First line.\nSecond line.',
    });
  });

  it('offers nothing without a current file (a deleted one)', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', null, false));
    expect(result.current.annotations).toBeNull();
  });
});
