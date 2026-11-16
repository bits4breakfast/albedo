// @vitest-environment jsdom
/**
 * The editor's window-level keys and the ⋯ that lists them: ⇧⌘C copies the
 * full path, ⌥⇧⌘C the worktree-relative one, the old ⌥⌘C does nothing, and
 * none of them acts while the editor is not on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../types';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => 'const a = 1;\n'),
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
vi.mock('../../lsp/phpantom', () => ({
  isPhpPath: () => false,
  warmPhpantom: vi.fn(),
  phpantomFailure: () => null,
  phpantomAvailability: () => null,
  subscribePhpantom: () => () => {},
  dismissPhpantomFailure: vi.fn(),
}));
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
const copyText = vi.fn(async (_text: string) => true);
vi.mock('../../lib/clipboard', () => ({ copyText }));

// jsdom has no layout; CodeMirror measures selections with these.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

const { default: FileEditor } = await import('./FileEditor');
const { setTouchedOrder } = await import('../touchedOrder');

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
  copyText.mockClear();
  document.body.innerHTML = '';
});

/** The editor inside `host`, with its controls in a slot, as EditorTabs draws it. */
async function open(host: HTMLElement = document.body) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} controlsSlot={slot} />, {
    container: host.appendChild(document.createElement('div')),
  });
  await waitFor(() => {
    if (!document.querySelector('.cm-content')) throw new Error('editor not mounted yet');
  });
}

describe('FileEditor keys', () => {
  it('⇧⌘C copies the full path, ⌥⇧⌘C the path in the worktree', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('/wt/src/a.ts'));
    expect(await screen.findByText('Full Path Copied')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Ç', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true });
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('src/a.ts'));
  });

  it('the old ⌥⌘C copies nothing', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
    expect(copyText).not.toHaveBeenCalled();
  });

  it('takes no key while it is not on screen', async () => {
    const hidden = document.createElement('div');
    hidden.hidden = true;
    document.body.appendChild(hidden);
    await open(hidden);
    fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    expect(copyText).not.toHaveBeenCalled();
  });

  it('lists Diff, Find, both copies and Reveal in ⋯, with their keys', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'File Actions' }));
    const items = Array.from(document.querySelectorAll('[role^="menuitem"]'), (i) => i.textContent);
    // jsdom's user agent is not a Mac's, so Reveal goes by its portable name.
    expect(items).toEqual(['Diff⇧⌘D', 'Find⌘F', 'Copy Path⌥⇧⌘C', 'Copy Full Path⇧⌘C', 'Show in Folder']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy Full Path/ }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('/wt/src/a.ts'));
  });

  it('names its toolbar after the file, and ⋯ repeats the status a narrow column hides', async () => {
    await open();
    expect(screen.getByRole('toolbar', { name: 'a.ts Actions' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    await screen.findByText('Full Path Copied');
    fireEvent.click(screen.getByRole('button', { name: 'File Actions' }));
    expect(document.querySelector('.row-menu-head')?.textContent).toBe('Full Path Copied');
  });
});

describe('⌥⌘↑ / ⌥⌘↓, the changed files, beside the transcript’s ⌥⌘↓ (#398)', () => {
  const DOWN = { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true };
  const UP = { ...DOWN, key: 'ArrowUp', code: 'ArrowUp' };

  /** The editor, hidden or not, and a transcript scroller as TranscriptPane draws it. */
  async function setup(transcriptOnScreen: boolean) {
    setTouchedOrder(task.id, ['src/0.ts', 'src/a.ts', 'src/b.ts']);
    const onStep = vi.fn();
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const transcript = document.createElement('div');
    transcript.setAttribute('data-jump-latest', '');
    transcript.innerHTML = '<button type="button">tool</button>';
    if (transcriptOnScreen) Object.defineProperty(transcript, 'offsetParent', { get: () => document.body });
    document.body.appendChild(transcript);
    const field = document.body.appendChild(document.createElement('textarea'));
    render(<FileEditor task={task} request={{ path: 'src/a.ts' }} onClose={() => {}} controlsSlot={slot} onStep={onStep} />);
    await waitFor(() => {
      if (!document.querySelector('.cm-content')) throw new Error('editor not mounted yet');
    });
    return { onStep, transcript, field };
  }

  it('steps through the changed files while no transcript is on screen', async () => {
    const { onStep } = await setup(false);
    fireEvent.keyDown(window, DOWN);
    fireEvent.keyDown(window, UP);
    expect(onStep.mock.calls.map((c) => c[0])).toEqual(['src/b.ts', 'src/0.ts']);
  });

  it('lets ⌥⌘↓ through to a transcript on screen with the keyboard free there; keeps ⌥⌘↑', async () => {
    const { onStep, transcript } = await setup(true);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, DOWN);
    transcript.querySelector('button')!.focus();
    fireEvent.keyDown(window, DOWN);
    expect(onStep).not.toHaveBeenCalled();
    fireEvent.keyDown(window, UP);
    expect(onStep.mock.calls.map((c) => c[0])).toEqual(['src/0.ts']);
  });

  it('keeps ⌥⌘↓ when focus is outside the transcript, in a field', async () => {
    const { onStep, field } = await setup(true);
    field.focus();
    fireEvent.keyDown(field, DOWN);
    expect(onStep.mock.calls.map((c) => c[0])).toEqual(['src/b.ts']);
  });
});
