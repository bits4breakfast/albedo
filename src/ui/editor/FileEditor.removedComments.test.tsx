// @vitest-environment jsdom
/**
 * Comments on removed lines (#402) through the real editor: in Diff mode a +
 * on a deleted row saves the base's line and text; in File mode a stored one
 * shows at the gap where its lines were, with a red mark, and resolves itself
 * once sent when they are back. A file with no such comment never reads its
 * base.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../types';
import type { ReviewComment } from '../../db/comments';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => 'alpha\nbeta\ngamma\n'),
  writeTextFile: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
}));
vi.mock('../../lib/paths', () => ({
  resolveInWorktree: vi.fn(async (root: string, path: string) => ({ absolute: `${root}/${path}`, relative: path })),
}));
vi.mock('../../lib/highlight', async () => {
  const actual = await vi.importActual<typeof import('../../lib/highlight')>('../../lib/highlight');
  return {
    ...actual,
    highlightToTokens: vi.fn(async () => []),
    peekTokens: vi.fn(() => null),
    styleToCss: vi.fn(() => ''),
  };
});
// Diff mode: the base had "old", the file now has "beta" in its place.
const fileDiff = vi.hoisted(() => ({ change: 'modified' as 'modified' | 'unchanged', fromMergeBase: true }));
vi.mock('../../git/fileDiff', async () => {
  const { diffStrings } = await vi.importActual<typeof import('../../lib/diff')>('../../lib/diff');
  const actual = await vi.importActual<typeof import('../../git/fileDiff')>('../../git/fileDiff');
  return {
    ...actual,
    loadTaskFileDiff: vi.fn(async () => {
      const oldText = fileDiff.change === 'unchanged' ? 'alpha\nbeta\ngamma\n' : 'alpha\nold\ngamma\n';
      const newText = 'alpha\nbeta\ngamma\n';
      return {
        result: { kind: 'diff', change: fileDiff.change, diff: diffStrings(oldText, newText, 'src/a.ts'), oldText, newText },
        base: 'abc1234',
        fromMergeBase: fileDiff.fromMergeBase,
      };
    }),
  };
});
vi.mock('../Terminal', () => ({ notePty: vi.fn() }));
vi.mock('../../lsp/phpantom', () => ({
  isPhpPath: () => false,
  warmPhpantom: vi.fn(),
  phpantomFailure: () => null,
  phpantomAvailability: () => null,
  subscribePhpantom: () => () => {},
  dismissPhpantomFailure: vi.fn(),
}));

const stored: ReviewComment[] = [];
const addComment = vi.fn(async () => 1);
const listComments = vi.fn(async () => stored);
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments,
    onCommentsChanged: vi.fn(() => () => {}),
    addComment,
    editComment: vi.fn(async () => {}),
    moveComment: vi.fn(async () => {}),
    resolveComment: vi.fn(async () => {}),
    resolveComments: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
});

// The base, as the File mode reads it for a file with a removed comment.
const base = vi.hoisted(() => ({ text: 'alpha\nold\ngamma\n' as string | null, settled: true }));
const useBaseText = vi.fn((_task: unknown, _path: string | null, needed: boolean) =>
  needed ? { text: base.text, settled: base.settled } : undefined,
);
vi.mock('./removedBase', () => ({ useBaseText, baseTextOf: vi.fn(async () => base.text) }));

// jsdom has no layout; CodeMirror measures selections with these.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { default: FileEditor } = await import('./FileEditor');

const task: Task = {
  id: 4, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
  reviewUrl: null,
  apiError: null,
  apiErrorText: null,
  spunFromTaskId: null,
};

afterEach(() => {
  cleanup();
  stored.length = 0;
  addComment.mockClear();
  listComments.mockClear();
  useBaseText.mockClear();
  base.text = 'alpha\nold\ngamma\n';
  base.settled = true;
  fileDiff.change = 'modified';
  fileDiff.fromMergeBase = true;
});

async function editorContent(): Promise<HTMLElement> {
  render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} />);
  return waitFor(() => {
    const el = document.querySelector('.cm-content');
    if (!el || !el.textContent?.includes('gamma')) throw new Error('editor not ready');
    return el as HTMLElement;
  });
}

configure({ asyncUtilTimeout: 5_000 });

function removed(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 11, taskId: 4, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'old', body: 'Why drop old?',
    createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: null, replyTo: null, side: 'old', ...over,
  };
}

describe('comments on removed lines (#402)', { timeout: 15_000 }, () => {
  it('in Diff mode, a + on a deleted row saves the base’s line and text, as removed', async () => {
    render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} initialMode="diff" />);
    const plus = await screen.findByRole('button', { name: 'Comment on removed line 2' });
    fireEvent.mouseDown(plus, { button: 0 });
    fireEvent.mouseUp(window);
    expect(await screen.findByText('On removed line 2')).toBeTruthy();
    const box = await screen.findByPlaceholderText(/Leave a comment/);
    fireEvent.change(box, { target: { value: 'Why drop old?' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({
      taskId: 4, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'old', body: 'Why drop old?', side: 'old',
    });
  });

  it('in File mode, shows at the gap where its lines were: a red mark, and the card under the line that took their place', async () => {
    stored.push(removed());
    await editorContent();
    expect(await screen.findByText('Why drop old?')).toBeTruthy();
    expect(screen.getByText('On removed line 2 · was above this line')).toBeTruthy();
    expect(document.querySelectorAll('.ed-cmt-gap')).toHaveLength(1);
    const card = screen.getByText('Why drop old?').closest('.ed-cmt')!;
    expect(card.getAttribute('data-side')).toBe('old');
    // Not this line's comment: no dot in the gutter, no edge on the line.
    expect(document.querySelector('.ed-cmt-dot')).toBeNull();
    expect(document.querySelector('.cm-line.ed-cmt-line')).toBeNull();
  });

  it('in File mode, a sent one stays while its lines are missing, and resolves when they are back', async () => {
    const db = await import('../../db/comments');
    stored.push(removed({ sentAt: 5 }));
    await editorContent();
    expect(await screen.findByText('Why drop old?')).toBeTruthy();
    expect(db.resolveComments).not.toHaveBeenCalled();
    cleanup();
    // A comment on "beta", which the change had removed from this base; the
    // file has it again, unchanged.
    stored.length = 0;
    stored.push(removed({ sentAt: 5, lineStart: 2, anchorText: 'beta' }));
    base.text = 'alpha\nbeta\ngamma\n';
    await editorContent();
    await waitFor(() => expect(db.resolveComments).toHaveBeenCalledWith(4, [11]));
    expect(await screen.findByText(/Removed line 2 is back in the file/)).toBeTruthy();
  });

  it('in File mode, one whose text the base no longer has is in the bar, not on a line', async () => {
    stored.push(removed({ anchorText: 'never there' }));
    await editorContent();
    expect(await screen.findByText(/On removed line 2: Why drop old\?/)).toBeTruthy();
    expect(document.querySelector('.ed-cmt-gap')).toBeNull();
  });

  it('a file with no comment on removed lines never asks for its base', async () => {
    stored.push({ ...removed({ side: undefined, anchorText: 'beta', body: 'Why beta?' }) });
    await editorContent();
    expect(await screen.findByText('Why beta?')).toBeTruthy();
    expect(useBaseText).toHaveBeenCalled();
    for (const call of useBaseText.mock.calls) expect(call[2]).toBe(false);
  });

  it('in File mode, a base read before the PR status settled neither moves nor resolves a comment', async () => {
    const db = await import('../../db/comments');
    vi.mocked(db.moveComment).mockClear();
    vi.mocked(db.resolveComments).mockClear();
    base.settled = false;
    // Stored at line 5; this base has its text at 2, and a second one is back in the file.
    stored.push(removed({ lineStart: 5, lineEnd: 5 }), removed({ id: 12, sentAt: 5, anchorText: 'beta', body: 'Sent one.' }));
    base.text = 'alpha\nold\nbeta\ngamma\n';
    await editorContent();
    expect(await screen.findByText('Why drop old?')).toBeTruthy();
    expect(await screen.findByText(/On removed line 2 · its lines are back: Sent one\./)).toBeTruthy();
    expect(db.moveComment).not.toHaveBeenCalled();
    expect(db.resolveComments).not.toHaveBeenCalled();
  });

  it('in Diff mode against HEAD (no merge base), deleted rows take no comment', async () => {
    fileDiff.fromMergeBase = false;
    render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} initialMode="diff" />);
    expect(await screen.findByRole('button', { name: 'Comment on line 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Comment on removed line/ })).toBeNull();
  });

  it('in File mode, editing a removed comment offers no Suggest Change; a comment on the file still does', async () => {
    stored.push(removed());
    await editorContent();
    expect(await screen.findByText('Why drop old?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('On removed line 2 · was above this line')).toBeTruthy();
    expect(screen.getByDisplayValue('Why drop old?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Suggest Change/ })).toBeNull();
    cleanup();
    stored.length = 0;
    const content = await editorContent();
    fireEvent.keyDown(content, { key: 'µ', code: 'KeyM', keyCode: 77, ctrlKey: true, altKey: true });
    await screen.findByPlaceholderText(/Leave a comment/);
    expect(screen.getByRole('button', { name: /Suggest Change/ })).toBeTruthy();
  });
});
