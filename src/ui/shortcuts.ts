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
 *
 * ## The O family: Command only, and read from `code`
 *
 * `⌘O`, `⇧⌘O` and `⌥⌘O` are PhpStorm's Go to Class / File / Symbol, and they
 * break both rules above on purpose:
 *
 *  - They accept Alt. `⌥⌘O` has no character to compose (Command suppresses
 *    composition), so the reason for excluding Alt does not apply. But Option
 *    DOES rewrite `e.key` on macOS (`⌥O` is `ø`), so these match the physical
 *    key, `e.code === 'KeyO'`, and every other combo keeps matching on `key`
 *    and keeps refusing Alt exactly as before.
 *  - They refuse Control. `mod` elsewhere is Meta OR Control, but Ctrl+O is a
 *    live key in the terminal -- Claude Code's own transcript toggle -- and
 *    stealing it would break the thing this app wraps.
 *
 * `⇧⌘F` (Find in Files) follows the same two rules for the same reasons.
 *
 * Double-Shift (Search Everywhere) is a gesture, not a combo: see
 * `createDoubleShift`.
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
  | 'mod+='
  | 'mod+-'
  | 'mod+0'
  | 'mod+digit'
  | 'mod+o'
  | 'mod+shift+o'
  | 'mod+alt+o'
  | 'mod+shift+f';

/** Bindings that are not one keystroke. Documented alongside the combos. */
export type Gesture = 'shift shift';

export interface ShortcutDoc {
  combo: Combo | Gesture;
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
  { combo: 'mod+shift+o', keys: '⇧⌘O', description: 'Go to file' },
  { combo: 'mod+o', keys: '⌘O', description: 'Go to class' },
  { combo: 'mod+alt+o', keys: '⌥⌘O', description: 'Go to symbol' },
  { combo: 'shift shift', keys: '⇧⇧', description: 'Search everywhere' },
  { combo: 'mod+shift+f', keys: '⇧⌘F', description: 'Find in files' },
  { combo: 'mod+=', keys: '⌘+', description: 'Bigger text' },
  { combo: 'mod+-', keys: '⌘−', description: 'Smaller text' },
  { combo: 'mod+0', keys: '⌘0', description: 'Actual size' },
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
  // Before the Alt check, which would otherwise reject ⌥⌘O. See the module
  // comment for why this family is Command-only and keyed on `code`.
  if (e.code === 'KeyO' && e.metaKey && !e.ctrlKey) {
    if (e.altKey && e.shiftKey) return null;
    if (e.altKey) return { combo: 'mod+alt+o', digit: null };
    if (e.shiftKey) return { combo: 'mod+shift+o', digit: null };
    return { combo: 'mod+o', digit: null };
  }
  // PhpStorm's Find in Files, on the same terms as the O family: Command only
  // (Ctrl+Shift+F belongs to the terminal) and read from `code`.
  if (e.code === 'KeyF' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+f', digit: null };
  }
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
    // `+` is Shift+`=` on most layouts, so both are bigger; numpad sends `+`.
    case '=':
    case '+':
      return { combo: 'mod+=', digit: null };
    case '-':
    case '_':
      return { combo: 'mod+-', digit: null };
    case '0':
      return { combo: 'mod+0', digit: null };
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

// ---------------------------------------------------------------------------
// Double-Shift
// ---------------------------------------------------------------------------

/** The most two Shift presses can be apart and still count as one gesture. */
export const DOUBLE_SHIFT_MS = 350;

type ShiftProbe = Pick<KeyboardEvent, 'key' | 'repeat' | 'timeStamp' | 'metaKey' | 'ctrlKey' | 'altKey'>;

/**
 * A detector for PhpStorm's Shift-Shift: feed it every keydown, it returns
 * true on the second of two bare Shift presses with nothing in between.
 *
 * "Nothing in between" is the part that matters. Typing `Hello World` presses
 * Shift twice inside a few hundred ms, but with letters between, and any other
 * key resets the count. Auto-repeat from a held Shift is not a second press,
 * and Shift with another modifier held is a chord on its way somewhere else.
 *
 * Pure and clock-free (it reads `timeStamp`), so it is tested without timers.
 */
export function createDoubleShift(windowMs = DOUBLE_SHIFT_MS): (e: ShiftProbe) => boolean {
  let last: number | null = null;
  return (e) => {
    if (e.key !== 'Shift' || e.metaKey || e.ctrlKey || e.altKey) {
      last = null;
      return false;
    }
    if (e.repeat) return false;
    if (last !== null && e.timeStamp - last <= windowMs) {
      last = null;
      return true;
    }
    last = e.timeStamp;
    return false;
  };
}

/**
 * Run `onTrigger` on Shift-Shift, anywhere in the window.
 *
 * Capture phase, because Shift alone is a key the terminal and the editor
 * might consume, and a gesture that works everywhere except where focus
 * usually is would be a gesture nobody trusts. Nothing is prevented: a bare
 * Shift does nothing on its own, so letting it through costs nothing.
 */
export function useDoubleShift(onTrigger: () => void): void {
  const ref = useRef(onTrigger);
  ref.current = onTrigger;

  useEffect(() => {
    const detect = createDoubleShift();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (detect(e)) ref.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
