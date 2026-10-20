// @vitest-environment jsdom
/**
 * Review comments through the real editor: ⇧⌘C on a line opens a draft, a
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
vi.mock('../../lib/highlight', () => ({
  highlightToTokens: vi.fn(async () => []),
  peekTokens: vi.fn(() => null),
  styleToCss: vi.fn(() => ''),
}));
vi.mock('../Terminal', () => ({ notePty: vi.fn() }));
vi.mock('../../lsp/phpantom', () => ({ isPhpPath: () => false, warmPhpantom: vi.fn() }));

const stored: ReviewComment[] = [];
const addComment = vi.fn(async () => 1);
vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return {
    ...actual,
    listComments: vi.fn(async () => stored),
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
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true,
  status: 'idle', createdAt: 0, lastActivityAt: null,
};

afterEach(() => {
  cleanup();
  stored.length = 0;
  addComment.mockClear();
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
  it('⇧⌘C opens a draft on the cursor line; ⌘↵ saves a multi-line comment with that line', async () => {
    const content = await editorContent();
    // jsdom is not a Mac, so CodeMirror's Mod is Ctrl here (⌘ in the app).
    fireEvent.keyDown(content, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true });
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

  it('a comment that fails to save stays in its box, with the reason', async () => {
    addComment.mockRejectedValueOnce(new Error('disk full'));
    const content = await editorContent();
    fireEvent.keyDown(content, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true });
    const box = (await screen.findByPlaceholderText(/Leave a comment/)) as HTMLTextAreaElement;
    box.value = 'Do not lose me.';
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(await screen.findByText(/Could not save the comment, which is still in its box: disk full/)).toBeTruthy();
    const still = screen.getByPlaceholderText(/Leave a comment/) as HTMLTextAreaElement;
    expect(still.value).toBe('Do not lose me.');
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
