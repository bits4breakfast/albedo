// @vitest-environment jsdom
/**
 * A file outside the task's worktree (#143): a clicked path opens like any
 * file, under a marker that names it as not the task's; a tab nobody clicked
 * (restored) asks first; a refusal says so; and nothing that belongs to the
 * task's branch -- Diff, comments, PHPantom, navigation -- applies to it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OpenFileRequest, Task } from '../../types';

const OUTSIDE = '/Users/me/code/other-repo/config.tf';

const readTextFile = vi.fn(async (_path: string) => 'variable "a" {}\n');
const writeTextFile = vi.fn(async (_path: string, _text: string) => {});
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile,
  writeTextFile,
  readFile: vi.fn(),
  exists: vi.fn(async () => true),
  stat: vi.fn(async () => ({ size: 1 })),
}));
const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => OUTSIDE);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
// Nothing resolves inside: every request here is outside the worktree.
vi.mock('../../lib/paths', () => ({ resolveInWorktree: vi.fn(async () => null) }));
vi.mock('../../lib/highlight', () => ({
  highlightToTokens: vi.fn(async () => []),
  peekTokens: vi.fn(() => null),
  styleToCss: vi.fn(() => ''),
}));
const notePty = vi.fn(async () => true);
vi.mock('../Terminal', () => ({ notePty }));
const markHandEdited = vi.fn();
vi.mock('../../lib/handEdited', () => ({ markHandEdited }));
const warmPhpantom = vi.fn();
vi.mock('../../lsp/phpantom', () => ({
  isPhpPath: (p: string) => p.endsWith('.php'),
  warmPhpantom,
  phpantomFailure: () => null,
  phpantomAvailability: () => null,
  subscribePhpantom: () => () => {},
  dismissPhpantomFailure: vi.fn(),
}));
const listComments = vi.fn(async () => []);
vi.mock('../../db/comments', () => ({
  listComments,
  onCommentsChanged: vi.fn(() => () => {}),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  editComment: vi.fn(),
  moveComment: vi.fn(),
  resolveComment: vi.fn(),
  relocate: vi.fn(),
}));

Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { default: FileEditor } = await import('./FileEditor');
const { markUserActivated, resetOutsideGrants } = await import('./outsideFile');

const task: Task = {
  id: 9, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetOutsideGrants();
  document.body.innerHTML = '';
});

function clicked(path: string): OpenFileRequest {
  const req = { path };
  markUserActivated(req);
  return req;
}

function renderEditor(request: OpenFileRequest) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  return { ...render(<FileEditor task={task} request={request} onClose={() => {}} controlsSlot={slot} />), slot };
}

const editorMounted = () =>
  waitFor(() => {
    if (!document.querySelector('.cm-content')) throw new Error('editor not mounted yet');
  });

describe('FileEditor, a file outside the worktree', () => {
  it('opens a clicked path, granting that one file, under the marker and its full path', async () => {
    renderEditor(clicked('../code/other-repo/config.tf'));
    await editorMounted();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('allow_outside_file', { path: '../code/other-repo/config.tf', base: '/wt' });
    // Read at the canonical path Rust granted, not the one asked with.
    expect(readTextFile).toHaveBeenCalledWith(OUTSIDE);
    expect(document.querySelector('.cm-content')?.textContent).toContain('variable "a" {}');
    const marker = screen.getByRole('note');
    expect(marker.textContent).toContain('Outside this worktree: not part of the task’s branch');
    expect(marker.textContent).toContain(OUTSIDE);
    // The old refusal is gone.
    expect(screen.queryByText(/is outside this worktree/)).toBeNull();
  });

  it('turns off what belongs to the task: Diff, the relative copy, comments, PHPantom', async () => {
    invoke.mockResolvedValueOnce('/Users/me/code/other-repo/src/A.php');
    renderEditor(clicked('/Users/me/code/other-repo/src/A.php'));
    await editorMounted();
    fireEvent.click(screen.getByRole('button', { name: 'File Actions' }));
    const items = Array.from(document.querySelectorAll('[role^="menuitem"]'), (i) => i.textContent);
    expect(items).toEqual(['Find⌘F', 'Copy Full Path⇧⌘C', 'Show in Folder']);
    expect(warmPhpantom).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    expect(document.querySelector('.ed-cmt-gutter')).toBeNull();
    // ⌥⌘B says it does not apply, rather than doing nothing.
    const content = document.querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(content, { key: '∫', code: 'KeyB', keyCode: 66, metaKey: true, altKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Go to Implementation' });
    expect(dialog.textContent).toContain('Not available for a file outside this worktree');
  });

  it('saves to the granted file and does not mark it as one of the task’s files', async () => {
    const view = renderEditor(clicked(OUTSIDE));
    await editorMounted();
    const { EditorView } = await import('@codemirror/view');
    const cm = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement);
    cm!.dispatch({ changes: { from: 0, insert: '# edited\n' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writeTextFile).toHaveBeenCalledWith(OUTSIDE, '# edited\nvariable "a" {}\n'));
    expect(markHandEdited).not.toHaveBeenCalled();
    await waitFor(() => expect(notePty).toHaveBeenCalledWith(9, expect.stringContaining(OUTSIDE)));
  });

  it('asks before granting a request nobody clicked (a restored tab), then opens on Open File', async () => {
    renderEditor({ path: OUTSIDE });
    const button = await screen.findByRole('button', { name: 'Open File' });
    expect(screen.getByText(/is outside this worktree/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
    fireEvent.click(button);
    await editorMounted();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('note').textContent).toContain(OUTSIDE);
  });

  it('grants a tab that is asking when the same path is clicked again in the transcript', async () => {
    const view = renderEditor({ path: OUTSIDE });
    await screen.findByRole('button', { name: 'Open File' });
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(<FileEditor task={task} request={clicked(OUTSIDE)} onClose={() => {}} controlsSlot={view.slot} />);
    await editorMounted();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'missing', path: OUTSIDE, message: 'does not exist' }, `${OUTSIDE} does not exist.`],
    [{ kind: 'unreadable', path: OUTSIDE, message: 'permission denied' }, `${OUTSIDE} can’t be read: permission denied.`],
    [
      { kind: 'denied', path: '/Users/me/.ssh/id_ed25519', message: 'Albedo does not open files under /Users/me/.ssh: it holds keys or credentials' },
      'Albedo does not open files under /Users/me/.ssh: it holds keys or credentials.',
    ],
  ])('says plainly when Rust refuses: %o', async (refusal, text) => {
    invoke.mockRejectedValueOnce(refusal);
    renderEditor(clicked(refusal.path));
    await screen.findByText(text);
    expect(readTextFile).not.toHaveBeenCalled();
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.querySelector('.cm-content')).toBeNull();
  });
});
