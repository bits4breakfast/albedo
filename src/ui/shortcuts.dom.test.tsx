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

import { useShortcuts } from './shortcuts';

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
