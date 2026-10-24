/**
 * Who has the keyboard when the editor opens a file.
 *
 * Opening a file focuses the editor: a transcript link, Quick Open, a ⌘B jump
 * all mean "I want to read this now". The Files pane is the exception. Its
 * rows open the file they select, and ↑/↓ must keep reaching the list after
 * each one (#86), so such a row carries `data-keeps-focus`, and an editor
 * opening a file leaves it focused. Enter is how the list hands the keyboard
 * over: `focusEditor`.
 */

/**
 * False while the focus is on a `data-keeps-focus` row that is on screen. A
 * row in a `hidden` panel (the Files tab, which gives way to the Editor tab
 * on a click) has stranded its focus, and the editor takes it.
 * `hidden`, not layout: jsdom has none, and the panels hide that way.
 */
export function editorMayTakeFocus(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.closest('[data-keeps-focus]') === null) return true;
  return el.closest('[hidden]') !== null;
}

const listeners = new Set<() => void>();

/** Ask the editor on screen to take the keyboard. */
export function focusEditor(): void {
  for (const l of listeners) l();
}

/** Subscribe the active editor to `focusEditor`; returns the unsubscribe. */
export function onFocusEditor(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
