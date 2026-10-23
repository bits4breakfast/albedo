/**
 * The editor's window-level keys: the ones that work wherever focus is, as
 * long as an editor is on screen. (Keys that act on the text -- ⌘S, ⌘B, ⌥F7,
 * the comment key -- are in CodeMirror's keymap in FileEditor.tsx.)
 *
 * All Command only and matched on the physical key: Shift turns `key` into
 * "C" or "D" and Option into "ç", while `code` stays `KeyC` / `KeyD` on every
 * layout. Control is refused, as for the O family in shortcuts.ts: Ctrl+Shift+C
 * is the terminal's copy off a Mac, and Ctrl+D is EOF.
 *
 *  - ⇧⌘D, File / Diff. Not PhpStorm's ⌘D: CodeMirror binds Mod-d to "select
 *    next occurrence", and an editor where that stopped working would be worse
 *    than a different chord.
 *  - ⇧⌘C, Copy Full Path, and ⌥⇧⌘C, Copy Path from the worktree: PhpStorm's
 *    Copy Absolute Path and Copy Reference. Neither is bound by CodeMirror,
 *    the app keymap, the native menu or a macOS text field.
 */

export type EditorKey = 'toggle-diff' | 'copy-full-path' | 'copy-path';

export type EditorKeyProbe = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** The editor action a keydown asks for, or null when it is not one. */
export function editorKeyOf(e: EditorKeyProbe): EditorKey | null {
  if (!e.metaKey || e.ctrlKey || !e.shiftKey) return null;
  if (e.code === 'KeyD') return e.altKey ? null : 'toggle-diff';
  if (e.code === 'KeyC') return e.altKey ? 'copy-path' : 'copy-full-path';
  return null;
}
