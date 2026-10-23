// @vitest-environment jsdom
/**
 * Review comments through the real editor: ⌥⌘M on a line opens a draft, a
 * multi-line comment is saved with the line and its text, and a stored
 * comment shows as a card under its code.
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
const fileDiff = vi.hoisted(() => ({ change: 'modified' as 'modified' | 'unchanged' }));
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
        fromMergeBase: true,
      };
    }),
  };
});
vi.mock('../Terminal', () => ({ notePty: vi.fn() }));
vi.mock('../../lsp/phpantom', () => ({ isPhpPath: () => false, warmPhpantom: vi.fn() }));

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
    deleteComment: vi.fn(async () => {}),
  };
});

// jsdom has no layout; CodeMirror measures selections with these.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { default: FileEditor } = await import('./FileEditor');

const task: Task = {
  id: 4, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null,
};

afterEach(() => {
  cleanup();
  stored.length = 0;
  addComment.mockClear();
  listComments.mockClear();
  fileDiff.change = 'modified';
});

async function editorContent(): Promise<HTMLElement> {
  render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} />);
  return waitFor(() => {
    const el = document.querySelector('.cm-content');
    if (!el || !el.textContent?.includes('gamma')) throw new Error('editor not ready');
    return el as HTMLElement;
  });
}

// CodeMirror mounts slowly when the machine is busy (a full suite alongside a
// build): the default 1s for findBy/waitFor failed this file intermittently.
configure({ asyncUtilTimeout: 5_000 });

describe('FileEditor review comments', { timeout: 15_000 }, () => {
  it('⌥⌘M opens a draft on the cursor line; ⌘↵ saves a multi-line comment with that line', async () => {
    const content = await editorContent();
    // jsdom is not a Mac, so CodeMirror's Mod is Ctrl here (⌘ in the app).
    fireEvent.keyDown(content, { key: 'µ', code: 'KeyM', keyCode: 77, ctrlKey: true, altKey: true });
    const box = (await screen.findByPlaceholderText(/Leave a comment/)) as HTMLTextAreaElement;
    box.value = 'Rename this.\nAnd test it.';
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({
      taskId: 4,
      path: 'src/a.ts',
      lineStart: 1,
      lineEnd: 1,
      anchorText: 'alpha',
      body: 'Rename this.\nAnd test it.',
    });
  });

  // The gutter is how a comment is started with the mouse. CodeMirror draws a
  // gutter cell only for a line with a marker unless told otherwise, so a file
  // with no comments had one cell, on the cursor's line (the active-line
  // class), and the + appeared nowhere else.
  it('the comment gutter has a press target on every line, and a press opens a draft', async () => {
    await editorContent();
    const cells = document.querySelectorAll('.ed-cmt-gutter .cm-gutterElement');
    expect(cells.length).toBeGreaterThanOrEqual(3);
    for (const cell of cells) expect(cell.querySelector('[title]')?.getAttribute('title')).toBe('Add a Comment (⌥⌘M)');
    // jsdom has no layout, so every cell measures as the first line.
    fireEvent.mouseDown(cells[0] as HTMLElement, { button: 0 });
    fireEvent.mouseUp(window);
    const box = (await screen.findByPlaceholderText(/Leave a comment/)) as HTMLTextAreaElement;
    box.value = 'Why alpha?';
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ lineStart: 1, lineEnd: 1, anchorText: 'alpha', body: 'Why alpha?' }));
  });

  it('a comment that fails to save stays in its box, with the reason', async () => {
    addComment.mockRejectedValueOnce(new Error('disk full'));
    const content = await editorContent();
    fireEvent.keyDown(content, { key: 'µ', code: 'KeyM', keyCode: 77, ctrlKey: true, altKey: true });
    const box = (await screen.findByPlaceholderText(/Leave a comment/)) as HTMLTextAreaElement;
    box.value = 'Do not lose me.';
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(await screen.findByText(/Could not save the comment, which is still in its box: disk full/)).toBeTruthy();
    const still = screen.getByPlaceholderText(/Leave a comment/) as HTMLTextAreaElement;
    expect(still.value).toBe('Do not lose me.');
  });

  it('a file whose comments cannot be read opens anyway, and says so', async () => {
    listComments.mockRejectedValueOnce(new Error('no such table: comments'));
    await editorContent();
    expect(await screen.findByText(/Could not read this file’s comments: no such table: comments/)).toBeTruthy();
  });

  it('in Diff mode, a + on a line of the file as it is now starts a comment and saves that line', async () => {
    render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} initialMode="diff" />);
    const plus = await screen.findByRole('button', { name: 'Comment on line 2' });
    fireEvent.mouseDown(plus, { button: 0 });
    fireEvent.mouseUp(window);
    const box = await screen.findByPlaceholderText(/Leave a comment/);
    fireEvent.change(box, { target: { value: 'Why not old?' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledOnce());
    expect(addComment).toHaveBeenCalledWith({
      taskId: 4, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'beta', body: 'Why not old?',
    });
  });

  it('in Diff mode, a file the branch never changed says where to comment on it', async () => {
    fileDiff.change = 'unchanged';
    render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} initialMode="diff" />);
    expect(await screen.findByText(/Switch to File to comment on it/)).toBeTruthy();
  });

  it('shows a stored comment as a card under its code, found by its text', async () => {
    stored.push({
      id: 9, taskId: 4, path: 'src/a.ts', lineStart: 1, lineEnd: 1, anchorText: 'beta',
      body: 'Why beta?', createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null,
    });
    await editorContent();
    expect(await screen.findByText('Why beta?')).toBeTruthy();
    expect(screen.getByText('Line 2')).toBeTruthy(); // moved from 1 to where "beta" is
  });
});
