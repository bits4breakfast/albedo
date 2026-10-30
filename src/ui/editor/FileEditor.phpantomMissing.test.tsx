// @vitest-environment jsdom
/**
 * The editor's notice for each of PHPantom's three states (#172): running says
 * nothing, couldn't start keeps its notice (#73), and not installed says so
 * with both install routes, a Copy Command, and an OK remembered on this
 * machine. The pool is faked here; `src/lsp/pool.test.ts` checks that the real
 * one reports these states, and `FileEditor.phpantom.test.tsx` runs the real
 * pool through a failed start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../types';

const pool = vi.hoisted(() => ({
  availability: null as 'running' | 'failed' | 'not-installed' | null,
  failure: null as string | null,
  listeners: new Set<() => void>(),
  set(availability: 'running' | 'failed' | 'not-installed', failure: string | null = null) {
    pool.availability = availability;
    pool.failure = failure;
    for (const l of pool.listeners) l();
  },
}));
const copied = vi.hoisted(() => ({ texts: [] as string[], ok: true }));

vi.mock('../../lsp/phpantom', () => ({
  isPhpPath: (p: string) => /\.php$/i.test(p),
  warmPhpantom: vi.fn(),
  phpantomAvailability: () => pool.availability,
  phpantomFailure: () => pool.failure,
  subscribePhpantom: (l: () => void) => {
    pool.listeners.add(l);
    return () => pool.listeners.delete(l);
  },
  dismissPhpantomFailure: () => pool.set('failed', null),
}));
vi.mock('../../lib/clipboard', () => ({
  copyText: vi.fn(async (text: string) => {
    copied.texts.push(text);
    return copied.ok;
  }),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => '<?php\nclass A {}\n'),
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
const { __resetPhpantomNotice } = await import('./phpantomNotice');

const task: Task = {
  id: 4, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null,
};

const MISSING = /using text search: PHPantom isn’t installed/;
const FAILED = /using text search: PHPantom couldn’t start/;
const KEY = 'albedo.editor.phpantomMissingDismissed';

let stored: Map<string, string>;
beforeEach(() => {
  // A fresh store per test: this environment's own localStorage is not one to rely on.
  stored = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
  });
  __resetPhpantomNotice();
  pool.availability = null;
  pool.failure = null;
  copied.texts = [];
  copied.ok = true;
});

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

describe('FileEditor: what it says about PHPantom', () => {
  it('running: nothing', async () => {
    pool.set('running');
    await open('src/A.php');
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(document.querySelector('.ed-notice')).toBeNull();
  });

  it('couldn’t start: its own notice, with the reason, and no install offer', async () => {
    pool.set('failed', 'phpantom exited');
    await open('src/A.php');
    expect(screen.getByText(FAILED).getAttribute('title')).toBe('phpantom exited');
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Command' })).toBeNull();
  });

  it('not installed: one line naming both install routes, on PHP files only', async () => {
    await open('src/A.php');
    expect(screen.queryByText(MISSING)).toBeNull();
    // Known only once a start has looked: the notice arrives then.
    act(() => pool.set('not-installed'));
    const notice = await screen.findByText(MISSING);
    expect(screen.getAllByText(MISSING)).toHaveLength(1);
    const help = notice.getAttribute('title') ?? '';
    expect(help).toContain('./build.sh --install --with-phpantom');
    expect(help).toContain('scripts/install-phpantom.sh');

    cleanup();
    await open('src/a.ts');
    expect(screen.queryByText(MISSING)).toBeNull();
  });

  it('Copy Command copies the build command and says it did', async () => {
    pool.set('not-installed');
    await open('src/A.php');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Command' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(copied.texts).toEqual(['./build.sh --install --with-phpantom']);
    // Copying is not dismissing.
    expect(screen.getByText(MISSING)).toBeTruthy();
  });

  it('a failed copy says so', async () => {
    copied.ok = false;
    pool.set('not-installed');
    await open('src/A.php');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Command' }));
    expect(await screen.findByRole('button', { name: 'Copy Failed' })).toBeTruthy();
  });

  it('OK is remembered on this machine: not on the next PHP file, nor the next launch', async () => {
    pool.set('not-installed');
    await open('src/A.php');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(stored.get(KEY)).toBe('1');

    cleanup();
    await open('src/B.php');
    expect(screen.queryByText(MISSING)).toBeNull();

    // A new launch reads the store afresh.
    cleanup();
    __resetPhpantomNotice();
    await open('src/B.php');
    expect(screen.queryByText(MISSING)).toBeNull();
  });

  it('not dismissed: said again on the next launch', async () => {
    pool.set('not-installed');
    await open('src/A.php');
    expect(screen.getByText(MISSING)).toBeTruthy();
    cleanup();
    __resetPhpantomNotice();
    await open('src/A.php');
    expect(screen.getByText(MISSING)).toBeTruthy();
  });
});
