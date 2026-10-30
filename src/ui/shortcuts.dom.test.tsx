/**
 * @vitest-environment jsdom
 *
 * `useShortcuts` in a real DOM: ⇧⌘R (#128) has to work wherever focus is --
 * a text field, the message box, the code editor, a component that stops the
 * key's propagation -- because it is heard in the capture phase. The editor
 * here is a real CodeMirror view with the keymaps FileEditor loads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';

import { Terminal as XTerm } from '@xterm/xterm';
import { TASK_TERMINAL_ATTR, TASK_TERMINAL_INPUT, taskTerminalTakesKey, terminalTakesKey, useShortcuts } from './shortcuts';

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
