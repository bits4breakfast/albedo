// @vitest-environment jsdom
/**
 * The Files pane from the keyboard (#86): a click opens a file and keeps the
 * keyboard on its row, ↑/↓ move to the neighbouring row and open it, Enter
 * hands the keyboard to the editor. Drives the mounted pane, in both the
 * Changes and the Project view. The "editor" is the open-file context: it
 * records each request and marks the file current, as App does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { OpenFileRequest, Task, TouchedFile } from '../types';
import type { OpenFileOptions } from './editor/openFile';

const stored = new Map<string, string>();
vi.mock('./persisted', async (importActual) => {
  const actual = await importActual<typeof import('./persisted')>();
  return {
    ...actual,
    readPersisted: <T, F>(key: string, codec: { decode: (raw: string) => T | null }, fallback: F) => {
      const raw = stored.get(key);
      return raw === undefined ? fallback : (codec.decode(raw) ?? fallback);
    },
    writePersisted: () => {},
  };
});

const file = (path: string, at: number, gitStatus: string | null): TouchedFile => ({
  path,
  editCount: 1,
  lastTouchedAt: at,
  source: 'transcript',
  gitStatus,
  handEdited: false,
});
vi.mock('../db/touched', async (importActual) => ({
  ...(await importActual<typeof import('../db/touched')>()),
  touchedFilesDetailed: async () => ({
    files: [file('src/a.ts', 300, ' M'), file('src/b.ts', 200, ' M')],
    gitError: null,
  }),
}));
vi.mock('../git/worktree', async (importActual) => ({
  ...(await importActual<typeof import('../git/worktree')>()),
  loadChangeSet: async () => ({
    merge: 'abc1234',
    lines: new Map([
      ['src/a.ts', { added: 1, deleted: 0 }],
      ['src/b.ts', { added: 1, deleted: 0 }],
      ['src/c.ts', { added: 2, deleted: 1 }],
    ]),
    kinds: new Map(),
    commits: [],
    committedAt: new Map([['src/c.ts', 100]]),
  }),
  unmergedCommits: async () => null,
  git: async () => ({ code: 0, stdout: 'a.ts\0b.ts\0lib/c.ts\0', stderr: '' }),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: async () => Promise.reject(new Error('no fs')) }));
vi.mock('../capture', () => ({ onCaptureUpdate: () => () => {} }));
vi.mock('./CommentsSection', () => ({ default: () => null }));
// Only the view toggle, as GitBar draws it: the tree is a visit away (#335).
vi.mock('./GitBar', () => ({
  default: ({ view, onView }: { view: 'changes' | 'project'; onView: (v: 'changes' | 'project') => void }) =>
    view === 'changes' ? (
      <button type="button" onClick={() => onView('project')}>
        Show All Files
      </button>
    ) : null,
}));

const { default: TouchedFiles } = await import('./TouchedFiles');
const { FileOpenContext } = await import('./editor/openFile');
const { onFocusEditor } = await import('./editor/editorFocus');
const { KEYS } = await import('./persisted');
const { resetFilesViews } = await import('./filesView');

const task: Task = {
  id: 3, title: 't', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
  worktreePath: '/wt', sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null, summary: null,
  reviewUrl: null,
  apiError: null,
  apiErrorText: null,
  spunFromTaskId: null,
};

let opened: [OpenFileRequest, OpenFileOptions | undefined][] = [];

function Harness({ t = task }: { t?: Task } = {}) {
  const [active, setActive] = useState<string | null>(null);
  const open = (req: OpenFileRequest, options?: OpenFileOptions) => {
    opened.push([req, options]);
    setActive(req.path);
  };
  return (
    <FileOpenContext.Provider value={open}>
      <TouchedFiles task={t} activePath={active} />
    </FileOpenContext.Provider>
  );
}

beforeEach(() => {
  opened = [];
  stored.clear();
});
afterEach(() => {
  resetFilesViews();
  cleanup();
  vi.useRealTimers();
});

const current = () => document.querySelector<HTMLElement>('[aria-current="true"]')?.dataset.path ?? null;
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.path ?? null;
const paths = () => opened.map(([r, o]) => `${r.path}${o?.step ? ' (step)' : ''}`);

describe('Changes view', () => {
  async function setup() {
    render(<Harness />);
    await waitFor(() => expect(document.querySelectorAll('.tf-row')).toHaveLength(3));
    const row = (path: string) => document.querySelector<HTMLElement>(`.tf-row[data-path="${path}"]`)!;
    return { row };
  }

  it('a click opens the file and keeps the keyboard on its row', async () => {
    const { row } = await setup();
    fireEvent.click(row('src/a.ts'));
    expect(paths()).toEqual(['src/a.ts']);
    expect(focused()).toBe('src/a.ts');
    expect(current()).toBe('src/a.ts');
  });

  it('↓ after a click opens the next file, across sections, and the row and highlight follow', async () => {
    const { row } = await setup();
    fireEvent.click(row('src/a.ts'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(paths()).toEqual(['src/a.ts', 'src/b.ts (step)']);
    expect(focused()).toBe('src/b.ts');
    expect(current()).toBe('src/b.ts');
    // The last uncommitted row steps into the committed section.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(focused()).toBe('src/c.ts');
    expect(current()).toBe('src/c.ts');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(focused()).toBe('src/b.ts');
    expect(current()).toBe('src/b.ts');
  });

  it('↑ on the first row and ↓ on the last do nothing', async () => {
    const { row } = await setup();
    fireEvent.click(row('src/a.ts'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(paths()).toEqual(['src/a.ts']);
    expect(focused()).toBe('src/a.ts');
    fireEvent.click(row('src/c.ts'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(paths()).toEqual(['src/a.ts', 'src/c.ts']);
    expect(focused()).toBe('src/c.ts');
  });

  it('Enter opens the file and hands the keyboard to the editor', async () => {
    const { row } = await setup();
    const editorFocus = vi.fn();
    const off = onFocusEditor(editorFocus);
    try {
      row('src/b.ts').focus();
      fireEvent.keyDown(row('src/b.ts'), { key: 'Enter' });
      expect(paths()).toEqual(['src/b.ts']);
      expect(document.activeElement?.closest('.tf-scroll')).toBeNull();
      await waitFor(() => expect(editorFocus).toHaveBeenCalled());
    } finally {
      off();
    }
  });

  it('Space opens the file like a click, keeping the keyboard on the row', async () => {
    const { row } = await setup();
    row('src/b.ts').focus();
    fireEvent.keyDown(row('src/b.ts'), { key: ' ' });
    expect(paths()).toEqual(['src/b.ts']);
    expect(focused()).toBe('src/b.ts');
  });

  it('a held arrow opens only the row it settles on', async () => {
    const { row } = await setup();
    fireEvent.click(row('src/a.ts'));
    vi.useFakeTimers();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', repeat: true });
    expect(focused()).toBe('src/c.ts');
    expect(paths()).toEqual(['src/a.ts', 'src/b.ts (step)']);
    act(() => vi.advanceTimersByTime(100));
    expect(paths()).toEqual(['src/a.ts', 'src/b.ts (step)', 'src/c.ts (step)']);
  });

  it('leaves ⌥⌘↓ to the editor, which walks the change set itself', async () => {
    const { row } = await setup();
    fireEvent.click(row('src/a.ts'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', metaKey: true, altKey: true });
    expect(paths()).toEqual(['src/a.ts']);
    expect(focused()).toBe('src/a.ts');
  });
});

describe('Project view', () => {
  async function setup() {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show All Files' }));
    await waitFor(() => expect(document.querySelectorAll('.tf-tree-row')).toHaveLength(3));
    const row = (path: string) => document.querySelector<HTMLElement>(`.tf-tree-row[data-path="${path}"]`)!;
    return { row };
  }

  it('a click opens the file and ↓ opens the next one, the row and highlight following', async () => {
    const { row } = await setup();
    fireEvent.click(row('a.ts'));
    expect(focused()).toBe('a.ts');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(paths()).toEqual(['a.ts', 'b.ts (step)']);
    expect(focused()).toBe('b.ts');
    expect(current()).toBe('b.ts');
  });

  it('↑ onto a folder moves there and opens nothing; ↑ on the first row does nothing', async () => {
    const { row } = await setup();
    fireEvent.click(row('a.ts'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(focused()).toBe('lib');
    expect(paths()).toEqual(['a.ts']);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(focused()).toBe('lib');
    expect(current()).toBe('a.ts');
  });

  it('Enter on a file hands the keyboard to the editor; on a folder it still toggles', async () => {
    const { row } = await setup();
    row('lib').focus();
    fireEvent.keyDown(row('lib'), { key: 'Enter' });
    await waitFor(() => expect(row('lib/c.ts')).not.toBeNull());
    expect(paths()).toEqual([]);
    row('b.ts').focus();
    fireEvent.keyDown(row('b.ts'), { key: 'Enter' });
    expect(paths()).toEqual(['b.ts']);
    expect(document.activeElement?.closest('.tf-tree')).toBeNull();
  });

  it('a folder carries the shared caret, open with the folder; a file carries none', async () => {
    // Not setup(): which folders are open outlives a render, so the test
    // before this one may have left `lib` open.
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show All Files' }));
    const row = (path: string) => document.querySelector<HTMLElement>(`.tf-tree-row[data-path="${path}"]`);
    await waitFor(() => expect(row('lib')).not.toBeNull());
    const caret = (path: string) => row(path)!.querySelector('.tf-tree-caret .disc');
    const expected = (open: boolean) => (open ? 'disc disc-open disc-inline' : 'disc disc-inline');
    const wasOpen = row('lib')!.getAttribute('aria-expanded') === 'true';
    expect(caret('lib')?.className).toBe(expected(wasOpen));
    expect(caret('a.ts')).toBeNull();
    fireEvent.click(row('lib')!);
    await waitFor(() => expect(caret('lib')?.className).toBe(expected(!wasOpen)));
  });
});

describe('the view, per task and shared (#335)', () => {
  const treeRows = () => document.querySelectorAll('.tf-tree-row').length;

  it('a task opens on Changes, ignoring a view stored by an older build', async () => {
    stored.set(KEYS.touchedView, 'project');
    render(<Harness />);
    expect(await screen.findByRole('button', { name: 'Show All Files' })).toBeTruthy();
    expect(treeRows()).toBe(0);
  });

  it('comes back on the view it was left on; another task still opens on Changes', async () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show All Files' }));
    await waitFor(() => expect(treeRows()).toBeGreaterThan(0));
    unmount();

    const other = render(<Harness t={{ ...task, id: 4 }} />);
    expect(await screen.findByRole('button', { name: 'Show All Files' })).toBeTruthy();
    other.unmount();

    render(<Harness />);
    await waitFor(() => expect(treeRows()).toBeGreaterThan(0));
  });

  it('the tab and the pinned column show the same view', async () => {
    render(
      <>
        <Harness />
        <Harness />
      </>,
    );
    const buttons = await screen.findAllByRole('button', { name: 'Show All Files' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Show All Files' })).toHaveLength(0));
  });
});
