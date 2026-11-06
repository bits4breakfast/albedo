// @vitest-environment jsdom
/**
 * The editor opened on a project's main checkout (no task selected) is the
 * user's real repo: it must show the file and never write it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import type { OpenFileRequest, Task } from '../../types';
import { markReadOnly } from './openFile';

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
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
};

afterEach(() => {
  cleanup();
  writeTextFile.mockClear();
});

function open(readOnly: boolean) {
  // The tab row's slot for the editor's controls, as EditorTabs gives it.
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  render(
    <FileEditor task={checkout} request={{ path: 'src/a.ts' }} onClose={() => {}} readOnly={readOnly} controlsSlot={slot} />,
  );
}

describe('FileEditor, read-only', () => {
  it('says it is the main checkout, and offers neither Save nor Diff', async () => {
    open(true);
    await screen.findByText(/Read-Only · Main Checkout/);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'File Actions' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: /Diff/ })).toBeNull();
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

  it('a normal task still gets Diff, and Save once there is something to save', async () => {
    open(false);
    const content = await waitFor(() => {
      const el = document.querySelector('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el as HTMLElement;
    });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'File Actions' }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Diff/ })).toBeTruthy();
    expect(screen.queryByText(/Read-Only · Main Checkout/)).toBeNull();
    const view = EditorView.findFromDOM(content)!;
    act(() => view.dispatch({ changes: { from: 0, insert: '// ' } }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

describe('FileEditor, one request opened read-only (#272)', () => {
  const work: Task = { ...checkout, id: 9, kind: 'work', worktreePath: '/wt', ownsWorktree: true };

  it('a request marked read-only opens read-only, in a task that is not', async () => {
    const request: OpenFileRequest = { path: 'src/a.ts' };
    markReadOnly(request);
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(<FileEditor task={work} request={request} onClose={() => {}} controlsSlot={slot} />);
    const badge = await screen.findByText('Read-Only');
    expect(badge.closest('.ed-readonly')?.getAttribute('title')).toMatch(/waiting card/);
    const content = await waitFor(() => {
      const el = document.querySelector('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el as HTMLElement;
    });
    expect(content.getAttribute('contenteditable')).toBe('false');
  });

  it('the same path, unmarked, is editable as before', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(<FileEditor task={work} request={{ path: 'src/a.ts' }} onClose={() => {}} controlsSlot={slot} />);
    const content = await waitFor(() => {
      const el = document.querySelector('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el as HTMLElement;
    });
    expect(content.getAttribute('contenteditable')).toBe('true');
    expect(screen.queryByText(/Read-Only/)).toBeNull();
  });
});
