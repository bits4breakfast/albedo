/**
 * @vitest-environment jsdom
 *
 * `useShortcuts` in a real DOM: ⇧⌘R (#128) has to work wherever focus is --
 * a text field, the message box, the code editor, a component that stops the
 * key's propagation -- because it is heard in the capture phase. The editor
 * here is a real CodeMirror view with the keymaps FileEditor loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';

import { Terminal as XTerm } from '@xterm/xterm';
import OverflowMenu from './OverflowMenu';
import {
  GUIDE_KEY_EXCEPT,
  TASK_ARROW_TERMS,
  TASK_TERMINAL_ATTR,
  TASK_TERMINAL_INPUT,
  taskTerminalTakesKey,
  terminalTakesKey,
  useShortcuts,
} from './shortcuts';

afterEach(cleanup);

const R = { key: 'R', code: 'KeyR', metaKey: true, shiftKey: true, bubbles: true, cancelable: true };

function Harness({ onRemote, onPush }: { onRemote: () => void; onPush: () => void }) {
  useShortcuts({
    'mod+shift+r': { phase: 'capture', run: onRemote },
    'mod+shift+p': onPush,
  });
  return (
    <div>
      <input aria-label="title" />
      <textarea aria-label="message" />
      {/* A component that keeps every key to itself, as a dialog's field may. */}
      <div onKeyDown={(e) => e.stopPropagation()}>
        <textarea aria-label="greedy" />
      </div>
    </div>
  );
}

function press(target: EventTarget, init: KeyboardEventInit = R): KeyboardEvent {
  const e = new KeyboardEvent('keydown', init);
  target.dispatchEvent(e);
  return e;
}

describe('⇧⌘R, heard from anywhere', () => {
  it('fires from a text field and the message box, and takes the key', () => {
    let n = 0;
    const { getByLabelText } = render(<Harness onRemote={() => n++} onPush={() => {}} />);
    for (const label of ['title', 'message']) {
      const field = getByLabelText(label);
      field.focus();
      expect(press(field).defaultPrevented).toBe(true);
    }
    press(document.body);
    expect(n).toBe(3);
  });

  it('fires through a component that stops the key, where a bubble binding does not', () => {
    let remote = 0;
    let push = 0;
    const { getByLabelText } = render(<Harness onRemote={() => remote++} onPush={() => push++} />);
    const greedy = getByLabelText('greedy');
    greedy.focus();
    press(greedy);
    press(greedy, { ...R, key: 'P', code: 'KeyP' });
    expect(remote).toBe(1);
    // The contrast that makes the capture phase the point: ⇧⌘P stays bubble.
    expect(push).toBe(0);
  });

  it('fires from inside the code editor, once, and leaves its text alone', () => {
    let n = 0;
    render(<Harness onRemote={() => n++} onPush={() => {}} />);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'hello',
        extensions: [history(), search({ top: true }), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab])],
      }),
    });
    try {
      view.focus();
      press(view.contentDOM);
      expect(n).toBe(1);
      expect(view.state.doc.toString()).toBe('hello');
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('is gone with the component', () => {
    let n = 0;
    const { unmount } = render(<Harness onRemote={() => n++} onPush={() => {}} />);
    unmount();
    press(document.body);
    expect(n).toBe(0);
  });
});

describe('⇧F6 / F2, Rename (#152): the task terminal and the page, nowhere else that takes typing', () => {
  const F6 = { key: 'F6', code: 'F6', keyCode: 117, shiftKey: true, bubbles: true, cancelable: true };
  const F2 = { key: 'F2', code: 'F2', keyCode: 113, bubbles: true, cancelable: true };

  // As App binds them.
  function RenameHarness({ onRename }: { onRename: () => void }) {
    useShortcuts({
      'shift+f6': { run: onRename, whenTyping: 'ignore', typingExcept: TASK_TERMINAL_INPUT },
      f2: { run: onRename, whenTyping: 'ignore', typingExcept: TASK_TERMINAL_INPUT },
    });
    return (
      <div>
        <input aria-label="title" />
        <textarea aria-label="message" />
        <div role="option" aria-selected="true" tabIndex={-1} aria-label="row">
          row
        </div>
      </div>
    );
  }

  /** A real xterm, wired as Terminal.tsx (task) or ShellTerminal.tsx (shell) wires it. */
  function xterm(kind: 'task' | 'shell') {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new XTerm();
    const pty: string[] = [];
    term.onData((d) => void pty.push(d));
    term.attachCustomKeyEventHandler(kind === 'task' ? taskTerminalTakesKey : terminalTakesKey);
    term.open(host);
    if (kind === 'task') term.textarea?.setAttribute(TASK_TERMINAL_ATTR, '');
    return {
      input: term.textarea as HTMLTextAreaElement,
      pty,
      dispose: () => {
        term.dispose();
        host.remove();
      },
    };
  }

  // xterm asks for it; jsdom has none.
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });
  }

  it('fires from the page and a task row, and takes the key', () => {
    let n = 0;
    const { getByLabelText } = render(<RenameHarness onRename={() => n++} />);
    expect(press(document.body, F6).defaultPrevented).toBe(true);
    const row = getByLabelText('row');
    row.focus();
    press(row, F2);
    expect(n).toBe(2);
  });

  it('fires from the task terminal (focus right after selecting a task), and the pty gets nothing', () => {
    let n = 0;
    render(<RenameHarness onRename={() => n++} />);
    const task = xterm('task');
    try {
      task.input.focus();
      press(task.input, F6);
      press(task.input, F2);
      expect(n).toBe(2);
      expect(task.pty).toEqual([]);
      // The terminal still types everything else.
      press(task.input, { key: 'F6', code: 'F6', keyCode: 117, bubbles: true, cancelable: true });
      expect(task.pty).toEqual(['\u001b[17~']);
    } finally {
      task.dispose();
    }
  });

  it('leaves both to the shell drawer: its shell gets them, nothing renames', () => {
    let n = 0;
    render(<RenameHarness onRename={() => n++} />);
    const shell = xterm('shell');
    try {
      shell.input.focus();
      press(shell.input, F6);
      press(shell.input, F2);
      expect(n).toBe(0);
      expect(shell.pty).toEqual(['\u001b[17;2~', '\u001bOQ']);
    } finally {
      shell.dispose();
    }
  });

  it('does nothing in a text field, the message box or the code editor', () => {
    let n = 0;
    const { getByLabelText } = render(<RenameHarness onRename={() => n++} />);
    for (const label of ['title', 'message']) {
      const field = getByLabelText(label);
      field.focus();
      expect(press(field, F6).defaultPrevented).toBe(false);
      press(field, F2);
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'hello',
        extensions: [history(), search({ top: true }), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab])],
      }),
    });
    try {
      view.focus();
      press(view.contentDOM, F6);
      press(view.contentDOM, F2);
      expect(view.state.doc.toString()).toBe('hello');
    } finally {
      view.destroy();
      host.remove();
    }
    expect(n).toBe(0);
  });
});

describe('⇧⌘G, the Review Guide (#207): everywhere but the code editor', () => {
  const G = { key: 'G', code: 'KeyG', metaKey: true, shiftKey: true, bubbles: true, cancelable: true };

  // As App binds it.
  function GuideHarness({ onGuide }: { onGuide: () => void }) {
    useShortcuts({ 'mod+shift+g': { run: onGuide, whenTyping: 'ignore', typingExcept: GUIDE_KEY_EXCEPT } });
    return (
      <div>
        <input aria-label="title" />
        <textarea aria-label="message" />
      </div>
    );
  }

  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });
  }

  it('fires from the page, a text field, the message box and the task terminal; the pty gets nothing', () => {
    let n = 0;
    const { getByLabelText } = render(<GuideHarness onGuide={() => n++} />);
    expect(press(document.body, G).defaultPrevented).toBe(true);
    for (const label of ['title', 'message']) {
      const field = getByLabelText(label);
      field.focus();
      press(field, G);
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new XTerm();
    const pty: string[] = [];
    term.onData((d) => void pty.push(d));
    term.attachCustomKeyEventHandler(taskTerminalTakesKey);
    term.open(host);
    try {
      const input = term.textarea as HTMLTextAreaElement;
      input.focus();
      press(input, G);
      expect(pty).toEqual([]);
    } finally {
      term.dispose();
      host.remove();
    }
    expect(n).toBe(4);
  });

  it('leaves it to the code editor, as Find Previous, and to its search field', () => {
    let n = 0;
    render(<GuideHarness onGuide={() => n++} />);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'hello hello',
        extensions: [history(), search({ top: true }), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab])],
      }),
    });
    try {
      view.focus();
      press(view.contentDOM, G);
      expect(n).toBe(0);
      // Its search field too. (jsdom is no Mac, so CodeMirror reads Mod as
      // Ctrl here and the panel is opened directly.)
      openSearchPanel(view);
      const field = host.querySelector<HTMLInputElement>('.cm-search input');
      expect(field).not.toBeNull();
      field!.focus();
      press(field!, G);
      expect(n).toBe(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe('⌘↑ / ⌘↓, previous / next task (#398): the page, a row, the task terminal; not where typing', () => {
  const DOWN = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, metaKey: true, bubbles: true, cancelable: true };
  const UP = { ...DOWN, key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 };

  // macOS only: the webview's user agent says which platform this is.
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
  });
  afterEach(() => vi.restoreAllMocks());

  // As TaskList binds them.
  function StepHarness({ onStep }: { onStep: (d: number) => void }) {
    useShortcuts({
      'mod+arrowup': { run: () => onStep(-1), ...TASK_ARROW_TERMS },
      'mod+arrowdown': { run: () => onStep(1), ...TASK_ARROW_TERMS },
    });
    return (
      <div>
        <input aria-label="title" defaultValue="a title" />
        <textarea aria-label="message" defaultValue={'one\ntwo'} />
        <div role="option" aria-selected="true" tabIndex={-1} aria-label="row">
          row
        </div>
        <OverflowMenu label="Task Actions" items={[{ id: 'a', label: 'First', onSelect: () => {} }, { id: 'b', label: 'Second', onSelect: () => {} }]} />
      </div>
    );
  }

  function xterm(kind: 'task' | 'shell') {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new XTerm();
    const pty: string[] = [];
    term.onData((d) => void pty.push(d));
    term.attachCustomKeyEventHandler(kind === 'task' ? taskTerminalTakesKey : terminalTakesKey);
    term.open(host);
    if (kind === 'task') term.textarea?.setAttribute(TASK_TERMINAL_ATTR, '');
    return {
      input: term.textarea as HTMLTextAreaElement,
      pty,
      dispose: () => {
        term.dispose();
        host.remove();
      },
    };
  }

  function editor(readOnly: boolean) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'one\ntwo',
        extensions: [
          history(),
          search({ top: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          // As FileEditor makes a read-only file: not contenteditable.
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ],
      }),
    });
    return { view, dispose: () => (view.destroy(), host.remove()) };
  }

  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });
  }

  it('steps from the page and a task row, and takes the key', () => {
    const steps: number[] = [];
    const { getByLabelText } = render(<StepHarness onStep={(d) => steps.push(d)} />);
    expect(press(document.body, DOWN).defaultPrevented).toBe(true);
    const row = getByLabelText('row');
    row.focus();
    press(row, UP);
    expect(steps).toEqual([1, -1]);
  });

  it('steps from the task terminal (focus right after selecting a task), and the pty gets nothing', () => {
    const steps: number[] = [];
    render(<StepHarness onStep={(d) => steps.push(d)} />);
    const task = xterm('task');
    try {
      task.input.focus();
      press(task.input, DOWN);
      press(task.input, UP);
      expect(steps).toEqual([1, -1]);
      expect(task.pty).toEqual([]);
      // Claude Code keeps the arrows and Ctrl+↑/↓.
      press(task.input, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true });
      press(task.input, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, ctrlKey: true, bubbles: true, cancelable: true });
      expect(task.pty).toEqual(['\u001b[B', '\u001b[1;5A']);
      expect(steps).toEqual([1, -1]);
    } finally {
      task.dispose();
    }
  });

  it('leaves them to the shell drawer, a text field, the message box and the code editor', () => {
    const steps: number[] = [];
    const { getByLabelText } = render(<StepHarness onStep={(d) => steps.push(d)} />);
    const shell = xterm('shell');
    try {
      shell.input.focus();
      press(shell.input, DOWN);
      expect(shell.pty).toEqual([]);
    } finally {
      shell.dispose();
    }
    for (const label of ['title', 'message']) {
      const field = getByLabelText(label);
      field.focus();
      expect(press(field, DOWN).defaultPrevented).toBe(false);
      expect(press(field, UP).defaultPrevented).toBe(false);
    }
    const { view, dispose } = editor(false);
    try {
      view.focus();
      press(view.contentDOM, DOWN);
      press(view.contentDOM, UP);
    } finally {
      dispose();
    }
    expect(steps).toEqual([]);
  });

  it('do nothing after a click in a read-only editor (the project view’s file), which holds no focus', () => {
    const steps: number[] = [];
    render(<StepHarness onStep={(d) => steps.push(d)} />);
    const { view, dispose } = editor(true);
    try {
      expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
      // The real path: a click there leaves focus on the body.
      const line = view.contentDOM.querySelector('.cm-line')!;
      fireEvent.pointerDown(line);
      fireEvent.mouseDown(line);
      fireEvent.mouseUp(line);
      fireEvent.click(line);
      // CodeMirror's mousedown focuses its content. WebKit refuses: with
      // contenteditable="false" and no tabindex it is not focusable, and focus
      // stays on the body. jsdom counts any contenteditable attribute as
      // focusable, so put it where WebKit leaves it.
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      expect(press(document.activeElement!, DOWN).defaultPrevented).toBe(false);
      press(document.activeElement!, UP);
      expect(steps).toEqual([]);
      // A click anywhere else gives the keys back.
      fireEvent.pointerDown(document.body);
      press(document.activeElement!, DOWN);
      expect(steps).toEqual([1]);
    } finally {
      dispose();
    }
  });

  it('step again once that editor is hidden behind another tab', () => {
    const steps: number[] = [];
    render(<StepHarness onStep={(d) => steps.push(d)} />);
    const { view, dispose } = editor(true);
    try {
      const line = view.contentDOM.querySelector('.cm-line')!;
      fireEvent.pointerDown(line);
      fireEvent.mouseDown(line);
      (document.activeElement as HTMLElement).blur(); // where WebKit leaves focus; see above
      press(document.activeElement!, DOWN);
      expect(steps).toEqual([]);
      view.dom.parentElement!.hidden = true;
      press(document.activeElement!, DOWN);
      expect(steps).toEqual([1]);
    } finally {
      dispose();
    }
  });

  it('leaves them to an open ⋯ menu, which moves on the arrow', () => {
    const steps: number[] = [];
    const { getByRole } = render(<StepHarness onStep={(d) => steps.push(d)} />);
    fireEvent.click(getByRole('button', { name: 'Task Actions' }));
    const first = getByRole('menuitem', { name: 'First' });
    expect(document.activeElement).toBe(first);
    press(first, DOWN);
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Second' }));
    expect(steps).toEqual([]);
  });

  it('stand down under a modal dialog, and leave the key alone', () => {
    const steps: number[] = [];
    render(<StepHarness onStep={(d) => steps.push(d)} />);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const button = dialog.appendChild(document.createElement('button'));
    button.textContent = 'Close';
    button.focus();
    expect(press(button, DOWN).defaultPrevented).toBe(false);
    press(document.body, UP);
    expect(steps).toEqual([]);
    dialog.remove();
    press(document.body, DOWN);
    expect(steps).toEqual([1]);
  });

  it('step once per press: not on auto-repeat, not while an input method composes', () => {
    const steps: number[] = [];
    render(<StepHarness onStep={(d) => steps.push(d)} />);
    press(document.body, DOWN);
    press(document.body, { ...DOWN, repeat: true });
    press(document.body, { ...DOWN, repeat: true });
    press(document.body, { ...DOWN, isComposing: true });
    press(document.body, { ...DOWN, keyCode: 229 });
    expect(steps).toEqual([1]);
  });

  it('is nothing off a Mac', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const steps: number[] = [];
    render(<StepHarness onStep={(d) => steps.push(d)} />);
    expect(press(document.body, DOWN).defaultPrevented).toBe(false);
    expect(steps).toEqual([]);
  });
});
