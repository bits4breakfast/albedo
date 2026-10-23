// @vitest-environment jsdom
/**
 * When PHPantom couldn't start (#73), a PHP file says so once: navigation
 * still answers, by text search, and the notice is the only sign of that.
 * The pool is the real one, with the config write refused the way the fs
 * scope refused it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../types';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => '<?php\nclass A {}\n'),
  writeTextFile: vi.fn(async (path: string) => {
    if (path.endsWith('/.phpantom.toml')) throw new Error(`forbidden path: ${path}`);
  }),
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => {}),
  watch: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: {} }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/me' }));
vi.mock('../../lib/paths', () => ({
  resolveInWorktree: vi.fn(async (root: string, path: string) => ({ absolute: `${root}/${path}`, relative: path })),
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
  relocate: vi.fn(),
}));

// jsdom has no layout; CodeMirror measures selections with these.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { default: FileEditor } = await import('./FileEditor');

const task: Task = {
  id: 4, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null,
};

const NOTICE = /using text search: PHPantom couldn’t start/;

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

async function open(path: string) {
  render(<FileEditor task={task} request={{ path }} onClose={() => {}} />);
  await waitFor(() => {
    if (!document.querySelector('.cm-content')) throw new Error('editor not mounted yet');
  });
}

describe('FileEditor when PHPantom couldn’t start', () => {
  it('says so once on a PHP file, with the reason in the tooltip, until OK', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await open('src/A.php');
    const notice = await screen.findByText(NOTICE);
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    expect(notice.getAttribute('title')).toMatch(/forbidden path: .*\.phpantom\.toml/);

    // Not on anything else: nothing else ever starts it.
    cleanup();
    await open('src/a.ts');
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    await open('src/A.php');
    await screen.findByText(NOTICE);

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText(NOTICE)).toBeNull();

    // Another PHP file, and another failed start: said once means once.
    cleanup();
    await open('src/B.php');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
