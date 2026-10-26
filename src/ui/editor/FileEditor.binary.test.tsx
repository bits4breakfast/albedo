// @vitest-environment jsdom
/**
 * A file that is not text never reaches CodeMirror: a picture is shown as one,
 * anything else binary is described, and neither can be saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../../types';

const readTextFile = vi.fn(async (_path: string) => 'const a = 1;\n');
const readFile = vi.fn(async (_path: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile,
  readFile,
  writeTextFile: vi.fn(),
  exists: vi.fn(async () => true),
  stat: vi.fn(async () => ({ size: 2048 })),
}));
vi.mock('../../lib/paths', () => ({
  resolveInWorktree: vi.fn(async (root: string, path: string) => ({
    absolute: `${root}/${path}`,
    relative: path,
  })),
}));
vi.mock('../../lib/highlight', () => ({
  highlightToTokens: vi.fn(async () => []),
  peekTokens: vi.fn(() => null),
  styleToCss: vi.fn(() => ''),
}));
vi.mock('../Terminal', () => ({ notePty: vi.fn() }));
vi.mock('../../db/comments', () => ({
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  editComment: vi.fn(),
  moveComment: vi.fn(),
  resolveComment: vi.fn(),
  relocate: vi.fn(() => null),
}));

// jsdom has neither object URLs nor layout.
URL.createObjectURL = vi.fn(() => 'blob:picture');
URL.revokeObjectURL = vi.fn();
const rects = { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() };
Object.assign(Range.prototype, rects);

const { default: FileEditor } = await import('./FileEditor');

const task: Task = {
  id: 7, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileEditor, files that are not text', () => {
  it('shows a picture as a picture, read as bytes', async () => {
    render(<FileEditor task={task} request={{ path: 'docs/shot.png' }} onClose={() => {}} />);
    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img.getAttribute('src')).toBe('blob:picture');
    expect(readFile).toHaveBeenCalledWith('/wt/docs/shot.png');
    expect(readTextFile).not.toHaveBeenCalled();
    expect(document.querySelector('.cm-content')).toBeNull();
    // Save shows only for unsaved edits, and a picture never has any.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('releases the picture when the editor closes', async () => {
    render(<FileEditor task={task} request={{ path: 'docs/shot.png' }} onClose={() => {}} />);
    await screen.findByRole('img');
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:picture');
  });

  it('describes any other binary instead of decoding it', async () => {
    readTextFile.mockResolvedValueOnce('\u0000\u0001garbage');
    render(<FileEditor task={task} request={{ path: 'bin/tool' }} onClose={() => {}} />);
    await screen.findByText(/is a binary file · 2.0 KB/);
    expect(document.querySelector('.cm-content')).toBeNull();
  });
});
