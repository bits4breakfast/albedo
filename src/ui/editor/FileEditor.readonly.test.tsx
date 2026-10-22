// @vitest-environment jsdom
/**
 * The editor opened on a project's main checkout (no task selected) is the
 * user's real repo: it must show the file and never write it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../types';

const writeTextFile = vi.fn(async () => {});
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => 'const a = 1;\n'),
  writeTextFile,
  exists: vi.fn(async () => true),
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

// jsdom has no layout; CodeMirror measures selections with these.
const rects = { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() };
Object.assign(Range.prototype, rects);

const { default: FileEditor } = await import('./FileEditor');

const checkout: Task = {
  id: -3, title: 'app', projectId: 3, repoPath: '/repo', baseBranch: '', branch: '',
  worktreePath: '/repo', sessionId: null, ownsWorktree: false, createdBranch: false, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null,
};

afterEach(() => {
  cleanup();
  writeTextFile.mockClear();
});

function open(readOnly: boolean) {
  render(<FileEditor task={checkout} request={{ path: 'src/a.ts' }} onClose={() => {}} readOnly={readOnly} />);
}

describe('FileEditor, read-only', () => {
  it('says it is the main checkout, and offers neither Save nor Diff', async () => {
    open(true);
    await screen.findByText(/Read-Only · Main Checkout/);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull();
  });

  it('is not editable, and Cmd+S never writes', async () => {
    open(true);
    await screen.findByText(/Read-Only · Main Checkout/);
    const content = await waitFor(() => {
      const el = document.querySelector('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el as HTMLElement;
    });
    expect(content.getAttribute('contenteditable')).toBe('false');
    fireEvent.keyDown(content, { key: 's', metaKey: true });
    fireEvent.keyDown(content, { key: 's', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('a normal task still gets Save and Diff', async () => {
    open(false);
    await screen.findByRole('button', { name: 'Save' });
    expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
    expect(screen.queryByText(/Read-Only · Main Checkout/)).toBeNull();
  });
});
