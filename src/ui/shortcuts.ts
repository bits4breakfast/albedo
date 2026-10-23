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
 * `⇧⌘F` (Find in Files), `⇧⌘P` (Push) and `⌘U` (Attach) follow the same two
 * rules for the same reasons -- Ctrl+P and Ctrl+U are the terminal's
 * previous-command and kill-line keys -- and `⌥F12`
 * (the shell drawer, PhpStorm's Terminal) is read from `code` too.
 *
 * ## Project tabs: ⌥1–9 (⌥⌘1–9 too), and Alt+1–9 off a Mac
 *
 * The task jump is ⌘1–9; the project jump is the same digits on Option, the
 * owner's choice. Read from `code` (`⌥1` is `¡` on macOS). That takes ⌥1–9
 * from text fields and the terminal everywhere: on the ABC layout they compose
 * `¡ ™ £ ¢ ∞ § ¶ • ª`, rare enough to give up. On a layout where an Option
 * digit types something needed (Italian ⌥9 is the backtick), this binding is
 * the one to revisit. ⌥⌘1–9, the earlier binding, still works. Off a Mac the
 * obvious Ctrl+Alt+1–9 is AltGr on most European layouts on Windows, where it
 * types characters (`{`, `²`, `@`), so there it is Alt+1–9 -- what Firefox
 * and many Linux apps use for tab N.
 *
 * ⇧⌘[ / ⇧⌘] step through the same tabs, next to ⌘[ / ⌘] for tasks. Read
 * from `code` (`BracketLeft` / `BracketRight`): Shift turns `[` into `{` on a
 * US layout, and other layouts put the brackets elsewhere. Command only, like
 * the O family: Ctrl+[ is Escape in a terminal. Checked before ⌘[ / ⌘],
 * which keep matching on `key` unchanged: a layout that types `[` with Shift
 * still steps tasks, because its `code` is not `BracketLeft`.
 *
 * Double-Shift (Search Everywhere) is a gesture, not a combo: see
 * `createDoubleShift`.
 */

import { useEffect, useRef } from 'react';
import { detectPlatform, type Platform } from '../lib/platform';

/** A combo, in the syntax `mod+<key>`; `mod+digit` matches 1 through 9. */
export type Combo =
  | 'mod+n'
  | 'mod+\\'
  | 'mod+['
  | 'mod+]'
  | 'mod+shift+['
  | 'mod+shift+]'
  | 'mod+arrowleft'
  | 'mod+arrowright'
  | 'mod+/'
  | 'mod+='
  | 'mod+-'
  | 'mod+0'
  | 'mod+digit'
  | 'mod+alt+digit'
  | 'mod+o'
  | 'mod+shift+o'
  | 'mod+alt+o'
  | 'mod+shift+f'
  | 'mod+shift+p'
  | 'mod+u'
  | 'alt+f12';

/**
 * Bindings that are not one app-wide keystroke, documented alongside the
 * combos: a gesture, or a key that only the editor answers (its CodeMirror
 * keymap, or editorKeys.ts while it is on screen).
 */
export type Gesture =
  | 'shift shift'
  | 'editor mod+b'
  | 'editor alt+f7'
  | 'editor mod+shift+d'
  | 'editor mod+shift+c'
  | 'editor mod+alt+shift+c'
  | 'editor mod+alt+m'
  | 'transcript mod+arrowdown'
  | 'new-task mod+enter';

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
  { combo: 'mod+n', keys: '⌘N', description: 'New Task' },
  { combo: 'mod+digit', keys: '⌘1…9', description: 'Jump to the Nth Task' },
  { combo: 'mod+alt+digit', keys: '⌥1…9', description: 'Jump to the Nth Project (Alt+1…9 on Windows and Linux)' },
  { combo: 'mod+[', keys: '⌘[', description: 'Previous Task' },
  { combo: 'mod+]', keys: '⌘]', description: 'Next Task' },
  { combo: 'mod+shift+[', keys: '⇧⌘[', description: 'Previous Project' },
  { combo: 'mod+shift+]', keys: '⇧⌘]', description: 'Next Project' },
  { combo: 'mod+arrowleft', keys: '⌘←', description: 'Previous Reading Tab' },
  { combo: 'mod+arrowright', keys: '⌘→', description: 'Next Reading Tab' },
  { combo: 'mod+\\', keys: '⌘\\', description: 'Cycle PTY / Split / Transcript (not on the Editor tab)' },
  { combo: 'mod+shift+o', keys: '⇧⌘O', description: 'Go to File' },
  { combo: 'mod+o', keys: '⌘O', description: 'Go to Class' },
  { combo: 'mod+alt+o', keys: '⌥⌘O', description: 'Go to Symbol' },
  { combo: 'shift shift', keys: '⇧⇧', description: 'Search Everywhere' },
  { combo: 'mod+shift+f', keys: '⇧⌘F', description: 'Find in Files' },
  { combo: 'mod+shift+p', keys: '⇧⌘P', description: 'Push the Selected Task (Commits First)' },
  { combo: 'mod+u', keys: '⌘U', description: 'Attach Files to the Message' },
  { combo: 'editor mod+b', keys: '⌘B / ⌘-click', description: 'In the Editor: Go to Declaration (on one: its usages)' },
  { combo: 'editor alt+f7', keys: '⌥F7', description: 'In the Editor: Find Usages' },
  { combo: 'editor mod+shift+d', keys: '⇧⌘D', description: 'In the Editor: Diff / File' },
  { combo: 'editor mod+shift+c', keys: '⇧⌘C', description: 'In the Editor: Copy Full Path' },
  { combo: 'editor mod+alt+shift+c', keys: '⌥⇧⌘C', description: 'In the Editor: Copy Path (from the Worktree)' },
  { combo: 'editor mod+alt+m', keys: '⌥⌘M', description: 'In the Editor: Comment on the Selected Lines' },
  { combo: 'transcript mod+arrowdown', keys: '⌘↓', description: 'Transcript: Jump to the Latest Message (not while typing)' },
  { combo: 'new-task mod+enter', keys: '⌘↩', description: 'In New Task: Create, from any field' },
  { combo: 'alt+f12', keys: '⌥F12', description: 'Shell in the Main Checkout' },
  { combo: 'mod+=', keys: '⌘+', description: 'Bigger Text' },
  { combo: 'mod+-', keys: '⌘−', description: 'Smaller Text' },
  { combo: 'mod+0', keys: '⌘0', description: 'Actual Size' },
  { combo: 'mod+/', keys: '⌘/', description: 'Show This List' },
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
export function comboOf(
  e: KeyboardEvent,
  platform: Platform = detectPlatform(),
): { combo: Combo; digit: number | null } | null {
  // Project jump. Before the Alt check; see the module comment.
  const projectDigit = /^Digit([1-9])$/.exec(e.code ?? '');
  const projectMods = platform === 'macos' ? true : !e.metaKey;
  if (projectDigit && e.altKey && !e.shiftKey && !e.ctrlKey && projectMods) {
    return { combo: 'mod+alt+digit', digit: Number(projectDigit[1]) };
  }
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
  // Push, on the same terms: two modifiers, because it starts a commit and a
  // push, and Command only, because Ctrl+P belongs to the terminal.
  if (e.code === 'KeyP' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+p', digit: null };
  }
  // Project step. Command only and read from `code`; see the module comment.
  if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: e.code === 'BracketLeft' ? 'mod+shift+[' : 'mod+shift+]', digit: null };
  }
  // Attach files. Command only: Ctrl+U is the terminal's kill-line.
  if (e.code === 'KeyU' && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+u', digit: null };
  }
  // PhpStorm's Terminal tool window. Option with a function key composes
  // nothing, so the Alt rule has no reason to apply; matched on `code` like
  // the O family.
  if (e.code === 'F12' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    return { combo: 'alt+f12', digit: null };
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

/** Combos the app takes from a focused terminal rather than sharing them. */
const TAKEN_FROM_TERMINAL: ReadonlySet<Combo> = new Set(['mod+alt+digit', 'mod+shift+[', 'mod+shift+]']);

/**
 * For xterm's `attachCustomKeyEventHandler`: false when the key is one of the
 * app's that the terminal must not also act on. The terminals treat Option as
 * Meta, so without this ⌥1 would switch project AND send `Esc 1` to the pty;
 * ⇧⌘[ / ⇧⌘] switch project too, so the pty does not get them either.
 */
export function terminalTakesKey(e: KeyboardEvent): boolean {
  const hit = comboOf(e);
  return hit === null || !TAKEN_FROM_TERMINAL.has(hit.combo);
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
