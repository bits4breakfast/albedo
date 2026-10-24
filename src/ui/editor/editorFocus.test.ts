// @vitest-environment jsdom
/** When an editor opening a file may take the keyboard (#86). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorMayTakeFocus, focusEditor, onFocusEditor } from './editorFocus';

afterEach(() => {
  document.body.innerHTML = '';
});

function focusIn(html: string): void {
  document.body.innerHTML = html;
  document.querySelector<HTMLElement>('#target')!.focus();
}

describe('editorMayTakeFocus', () => {
  it('leaves a focused Files row on screen alone', () => {
    focusIn('<div><div id="target" tabindex="0" data-keeps-focus=""></div></div>');
    expect(editorMayTakeFocus()).toBe(false);
  });

  it('takes the keyboard from a Files row in a hidden panel: its focus is stranded', () => {
    focusIn('<div hidden><div id="target" tabindex="0" data-keeps-focus=""></div></div>');
    expect(editorMayTakeFocus()).toBe(true);
  });

  it('takes it from anything else, and when nothing has it', () => {
    focusIn('<span id="target" role="link" tabindex="0"></span>');
    expect(editorMayTakeFocus()).toBe(true);
    (document.activeElement as HTMLElement).blur();
    expect(editorMayTakeFocus()).toBe(true);
  });
});

describe('focusEditor', () => {
  it('reaches the subscribed editor until it unsubscribes', () => {
    const fn = vi.fn();
    const off = onFocusEditor(fn);
    focusEditor();
    off();
    focusEditor();
    expect(fn).toHaveBeenCalledOnce();
  });
});
