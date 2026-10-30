// @vitest-environment jsdom
/**
 * ⌥⌘B through the real editor: the keystroke CodeMirror receives, the
 * engine choice in symbolNav, git grep over a real repository, and the
 * results dialog. PHPantom is a stand-in whose answer each test sets, since
 * the binary is optional and not here; its absence is the grep path.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import type { Task } from '../../types';
import type { Location } from '../../lsp/phpantom';
import { setGitRunner, type GitRunner } from '../../git/worktree';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async (path: string) => readFileSync(path, 'utf8')),
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

/** What the stand-in server answers; null is "not installed". */
const lsp = vi.hoisted(() => ({
  answer: null as Location[] | null,
  asked: [] as Array<{ path: string; line0: number; character: number }>,
}));
vi.mock('../../lsp/phpantom', async (actual) => ({
  ...(await actual<typeof import('../../lsp/phpantom')>()),
  warmPhpantom: vi.fn(),
  phpantomFor: vi.fn(async () =>
    lsp.answer === null
      ? null
      : {
          whenReady: async () => true,
          implementation: async (path: string, _text: string, line0: number, character: number) => {
            lsp.asked.push({ path, line0, character });
            return lsp.answer;
          },
        },
  ),
}));

// jsdom has no layout; CodeMirror measures selections with these.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });
configure({ asyncUtilTimeout: 5_000 });

const { default: FileEditor } = await import('./FileEditor');
const { FileOpenContext } = await import('./openFile');

const files: Record<string, string> = {
  'src/Model/Shape.php': '<?php\nnamespace App\\Model;\n\ninterface Shape {}\n',
  'src/Model/Loggable.php': '<?php\nnamespace App\\Model;\n\ntrait Loggable {}\n',
  'src/Model/Polygon.php': '<?php\nnamespace App\\Model;\n\nabstract class Polygon implements Shape {}\n',
  'src/Model/Square.php': '<?php\nnamespace App\\Model;\n\nclass Square extends Polygon implements Shape {}\n',
  'src/Other/Circle.php': '<?php\nnamespace App\\Other;\n\nuse App\\Model\\Shape;\n\nfinal class Circle implements Shape {}\n',
  // Implements Shape only through Square: PHPantom finds it, grep cannot.
  'src/Other/Tiny.php': '<?php\nnamespace App\\Other;\n\nclass Tiny extends \\App\\Model\\Square {}\n',
  // Vendor\Kit\Widget is declared nowhere here, like a type under vendor/.
  'src/Other/Panel.php':
    '<?php\nnamespace App\\Other;\n\nuse Vendor\\Kit\\Widget;\n\nclass Panel extends Widget\n{\n    public function draw(Canvas $c) {}\n}\n',
  'src/Other/Sheet.php': '<?php\nnamespace App\\Other;\n\nfinal class Sheet implements \\Vendor\\Kit\\Widget {}\n',
};

let root = '';
let restore: GitRunner | null = null;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'goto-impl-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  restore = setGitRunner(async (args, cwd) => {
    try {
      const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  });
});

afterAll(() => {
  if (restore) setGitRunner(restore);
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  cleanup();
  lsp.answer = null;
  lsp.asked = [];
  document.body.innerHTML = '';
});

const task = (): Task => ({
  id: 4, title: 't', projectId: 1, repoPath: root, baseBranch: 'main', branch: 'b',
  worktreePath: root, sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 0, lastActivityAt: null, seenAt: null,
});

/** Open `path`, put the cursor inside `name` on its declaration, and press ⌥⌘B. */
async function pressOn(path: string, name: string, openFile = vi.fn()) {
  render(
    <FileOpenContext.Provider value={openFile}>
      <FileEditor task={task()} request={{ path }} onClose={() => {}} />
    </FileOpenContext.Provider>,
  );
  const content = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.cm-content');
    if (!el) throw new Error('editor not mounted yet');
    return el;
  });
  const view = EditorView.findFromDOM(content)!;
  view.dispatch({ selection: { anchor: view.state.doc.toString().lastIndexOf(name) + 1 } });
  // ⌘ with ⌥ on macOS: `key` is "∫", so only `code` says B.
  fireEvent.keyDown(content, { key: '∫', code: 'KeyB', keyCode: 66, metaKey: true, altKey: true });
  return openFile;
}

const CAVEAT = 'Text search: may include false matches';

const rows = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('⌥⌘B in the editor', { timeout: 15_000 }, () => {
  it('on an interface, without PHPantom: its direct implementers by git grep, and the limits under the title', async () => {
    await pressOn('src/Model/Shape.php', 'Shape');
    expect(await screen.findByRole('dialog', { name: 'Classes Implementing Shape' })).toBeTruthy();
    expect(rows()).toEqual([
      '4abstract class Polygon implements Shape {}',
      '4class Square extends Polygon implements Shape {}',
      '6final class Circle implements Shape {}',
    ]);
    // The full name leads the note, the title keeps the short one. Text
    // search is said once, in the header (#172), not again in the note.
    expect(screen.getByText(/^App\\Model\\Shape · Direct implementers and extending interfaces · an implements list split across lines is missed$/)).toBeTruthy();
    expect(screen.getByText(CAVEAT)).toBeTruthy();
    expect(screen.getAllByText(/text search/i)).toHaveLength(1);
  });

  it('on a class with one subclass: opens it, with no list', async () => {
    const openFile = await pressOn('src/Model/Polygon.php', 'Polygon');
    await waitFor(() => expect(openFile).toHaveBeenCalledWith({ path: 'src/Model/Square.php', line: 4 }));
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('on a trait nobody uses: says so, and still says what the search could not see', async () => {
    await pressOn('src/Model/Loggable.php', 'Loggable');
    expect(await screen.findByText('No classes use Loggable')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Go to Implementation' })).toBeTruthy();
    expect(screen.getByText(/Direct users, by text search/)).toBeTruthy();
    // No list, so nothing for "may include false matches" to be about.
    expect(screen.queryByText(CAVEAT)).toBeNull();
  });

  it('with PHPantom running: its answer and grep’s as one list, abstract implementers included', async () => {
    // What PHPantom 0.11.1 answers here: concrete classes only, at any depth.
    lsp.answer = [
      { path: 'src/Other/Circle.php', line: 6 },
      { path: 'src/Model/Square.php', line: 4 },
      { path: 'src/Other/Tiny.php', line: 4 },
    ];
    await pressOn('src/Model/Shape.php', 'Shape');
    expect(await screen.findByRole('dialog', { name: 'Classes Implementing Shape' })).toBeTruthy();
    expect(lsp.asked).toEqual([{ path: 'src/Model/Shape.php', line0: 3, character: 11 }]);
    // Polygon from grep, Tiny from PHPantom, Square and Circle from both and listed once.
    expect(rows()).toEqual([
      '4abstract class Polygon implements Shape {}',
      '4class Square extends Polygon implements Shape {}',
      '6final class Circle implements Shape {}',
      '4class Tiny extends \\App\\Model\\Square {}',
    ]);
    // The declared name is the one marked, whichever engine found the row.
    expect([...document.querySelectorAll('.ff-row mark')].map((m) => m.textContent)).toEqual(['Polygon', 'Square', 'Circle', 'Tiny']);
    expect(screen.getByText(/Classes implementing it at any depth, and the abstract classes and interfaces that name it directly/)).toBeTruthy();
    // PHPantom resolved this list: not a text search.
    expect(screen.queryByText(CAVEAT)).toBeNull();
  });

  it('with PHPantom answering nothing: grep’s list, with grep’s limits', async () => {
    lsp.answer = [];
    await pressOn('src/Model/Shape.php', 'Shape');
    expect(await screen.findByRole('dialog', { name: 'Classes Implementing Shape' })).toBeTruthy();
    expect(rows()).toHaveLength(3);
    expect(screen.getByText(CAVEAT)).toBeTruthy();
  });

  it('on a type this worktree does not declare: what extends or implements it', async () => {
    await pressOn('src/Other/Panel.php', 'Widget;');
    expect(await screen.findByRole('dialog', { name: 'Implementations of Widget' })).toBeTruthy();
    expect(rows()).toEqual(['6class Panel extends Widget', '4final class Sheet implements \\Vendor\\Kit\\Widget {}']);
    expect(screen.getByText(/^Vendor\\Kit\\Widget · Not declared in this worktree · direct extends and implements · a list split/)).toBeTruthy();
    expect(screen.getByText(CAVEAT)).toBeTruthy();
  });

  it('on an undeclared type PHPantom resolves: still asked, and its answer joins the list', async () => {
    lsp.answer = [{ path: 'src/Other/Sheet.php', line: 4 }];
    await pressOn('src/Other/Panel.php', 'Widget;');
    expect(await screen.findByRole('dialog', { name: 'Implementations of Widget' })).toBeTruthy();
    expect(lsp.asked).toHaveLength(1);
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(/what PHPantom resolves, and declarations naming it/)).toBeTruthy();
  });

  it('on an undeclared type nothing names: says so only once both engines found nothing', async () => {
    lsp.answer = [];
    await pressOn('src/Other/Panel.php', 'Canvas');
    expect(await screen.findByText('No implementations of Canvas')).toBeTruthy();
    expect(lsp.asked).toHaveLength(1);
  });

  it('⌥F7 without PHPantom: usages by git grep, and the header says it is text search (#172)', async () => {
    render(<FileEditor task={task()} request={{ path: 'src/Model/Shape.php' }} onClose={() => {}} />);
    const content = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el;
    });
    const view = EditorView.findFromDOM(content)!;
    view.dispatch({ selection: { anchor: view.state.doc.toString().lastIndexOf('Shape') + 1 } });
    fireEvent.keyDown(content, { key: 'F7', code: 'F7', keyCode: 118, altKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Usages of App\\Model\\Shape' });
    expect(dialog.querySelector('.ff-head')?.textContent).toContain(CAVEAT);
  });

  it('off a type name: says where to put the cursor', async () => {
    await pressOn('src/Model/Shape.php', '{}');
    expect(await screen.findByText('Put the cursor on a class, interface or trait name')).toBeTruthy();
  });
});
