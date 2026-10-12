/**
 * The keymap, in one place.
 *
 * It used to be two `window.addEventListener('keydown')` blocks in two files
 * (App owned the pane cycle, TaskList owned new-task and the number jumps),
 * each re-deriving "is the modifier held" slightly differently and neither
 * knowing what the other bound. Two handlers cannot tell you whether a key is
 * already taken, which is how a keymap acquires a conflict nobody notices.
 *
 * `SHORTCUTS` below is the documentation, and it is exported so a help surface
 * can render it rather than a second hand-written list drifting from this one.
 *
 * ## `mod`
 *
 * Meta OR Control, matching what both call sites already accepted. Alt is
 * always excluded: on macOS it composes characters, so `⌥[` is a legitimate
 * keystroke that must reach the terminal.
 *
 * ## Why text fields are exempt
 *
 * `mod+ArrowLeft` / `mod+ArrowRight` are "start of line" and "end of line" in
 * every macOS text field, and this app has a composer textarea, a task-title
 * input and a CodeMirror editor. Stealing them there would break editing to
 * move a tab the user cannot see. So a binding may declare `whenTyping:
 * 'ignore'` and it will not fire while focus is in an editable element.
 *
 * The others deliberately stay live while typing: `⌘N` and `⌘1..9` mean the
 * same thing wherever you are, and nothing in a text field claims them.
 */

import { useEffect, useRef } from 'react';

/** A combo, in the syntax `mod+<key>`; `mod+digit` matches 1 through 9. */
export type Combo =
  | 'mod+n'
  | 'mod+\\'
  | 'mod+['
  | 'mod+]'
  | 'mod+arrowleft'
  | 'mod+arrowright'
  | 'mod+/'
  | 'mod+digit';

export interface ShortcutDoc {
  combo: Combo;
  /** How the key is written for a person: ⌘N, ⌘], ⌘←. */
  keys: string;
  description: string;
}

/**
 * Every binding the app defines. Keep this in sync with the call sites -- it is
 * the only list, and a shortcut missing from it is a shortcut nobody can find.
 */
export const SHORTCUTS: readonly ShortcutDoc[] = [
  { combo: 'mod+n', keys: '⌘N', description: 'New task' },
  { combo: 'mod+digit', keys: '⌘1…9', description: 'Jump to the nth task' },
  { combo: 'mod+[', keys: '⌘[', description: 'Previous task' },
  { combo: 'mod+]', keys: '⌘]', description: 'Next task' },
  { combo: 'mod+arrowleft', keys: '⌘←', description: 'Previous reading tab' },
  { combo: 'mod+arrowright', keys: '⌘→', description: 'Next reading tab' },
  { combo: 'mod+\\', keys: '⌘\\', description: 'Cycle terminal / split / transcript' },
  { combo: 'mod+/', keys: '⌘/', description: 'Show this list' },
] as const;

export interface Handler {
  run: (event: KeyboardEvent, digit: number | null) => void;
  /**
   * `'ignore'` skips the binding while focus is in an editable element.
   * Defaults to firing regardless.
   */
  whenTyping?: 'ignore';
}

export type Bindings = Partial<Record<Combo, Handler | ((e: KeyboardEvent, digit: number | null) => void)>>;

/** True for the elements where a bare arrow or letter is the user's text. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The combo a keyboard event represents, or null when it is not one of ours. */
export function comboOf(e: KeyboardEvent): { combo: Combo; digit: number | null } | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key >= '1' && key <= '9') return { combo: 'mod+digit', digit: Number(key) };
  switch (key) {
    case 'n':
      return { combo: 'mod+n', digit: null };
    case '\\':
      return { combo: 'mod+\\', digit: null };
    case '/':
      return { combo: 'mod+/', digit: null };
    case '[':
      return { combo: 'mod+[', digit: null };
    case ']':
      return { combo: 'mod+]', digit: null };
    case 'arrowleft':
      return { combo: 'mod+arrowleft', digit: null };
    case 'arrowright':
      return { combo: 'mod+arrowright', digit: null };
    default:
      return null;
  }
}

/**
 * Register shortcut handlers for the lifetime of the component.
 *
 * Bindings are read through a ref, so a handler closing over fresh state does
 * not re-subscribe the listener on every render -- the same pattern both call
 * sites were already using by hand.
 */
export function useShortcuts(bindings: Bindings): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hit = comboOf(e);
      if (!hit) return;
      const entry = ref.current[hit.combo];
      if (!entry) return;
      const handler = typeof entry === 'function' ? { run: entry } : entry;
      if (handler.whenTyping === 'ignore' && isTyping(e.target)) return;
      e.preventDefault();
      handler.run(e, hit.digit);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
