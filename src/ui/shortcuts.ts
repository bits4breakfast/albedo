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
 * ## ⇧⌘R: Remote Control, from anywhere
 *
 * Asks to make the selected task's session available remotely (#128). Same
 * terms as ⇧⌘P: Command only (Ctrl+R is the terminal's reverse search) and
 * read from `code`. Unlike every other combo it is heard in the capture phase
 * (`phase: 'capture'`), so it works wherever focus is -- the terminal, the
 * message box, the editor, any text field -- and nothing below the window
 * can stop it on the way up. Nothing else binds it: not CodeMirror's default,
 * history or search keymaps, not the editor's own keys, not the native menu
 * (Tauri's default has no Reload), and WKWebView has no hard-reload key.
 *
 * One place takes it back: the Review Guide, where ⇧⌘R marks the group
 * reviewed (#391) beside ⌘R for the file (#390). Capture runs before the
 * guide's own handler can say anything, so the binding is told where to stand
 * aside instead (`standAsideIn`, {@link GUIDE_AREA}): with focus anywhere in
 * a guide on screen (a hidden one claims nothing) it neither runs nor
 * prevents the key, and the guide's handler
 * gets it as if nothing were bound. Everywhere else it is Remote Control, as
 * before. Plain ⌘R binds nothing in the app, in CodeMirror's keymaps or in
 * the native menu, so the guide takes it without a fight.
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
 * ## ⇧F6 / F2: Rename the selected task
 *
 * PhpStorm's Rename is ⇧F6; F2 is the Finder's and Windows Explorer's, and
 * nothing here binds it. Read from `code` (`F6` / `F2`), no other modifier.
 *
 * Live in the TASK terminal, because that is where focus is right after a
 * task is selected (Terminal.tsx focuses it). Claude Code binds neither key,
 * so the task terminal gives both up (`taskTerminalTakesKey`): xterm never
 * sends them to the pty, and the key goes on to the window, where the
 * binding hears it -- its `typingExcept` names the task terminal's input
 * (`[data-task-terminal]`). Everywhere else that takes typing keeps them
 * (`whenTyping: 'ignore'`): a text field, the message box, the editor
 * (CodeMirror is contenteditable) and the shell drawer, whose terminal uses
 * the plain `terminalTakesKey` and still sends them to the shell -- a real
 * shell program may use F-keys. Checked against CodeMirror's default,
 * history and search keymaps, the editor's own keys (FileEditor.tsx,
 * editorKeys.ts), focusAreas.ts and the native menu: none binds F2 or F6
 * with any modifier.
 *
 * ## ⇧⌘G: the Review Guide
 *
 * Opens the selected task's guide, from `code` (`KeyG`), Command only. It is
 * Find Previous in CodeMirror's search keymap (and across macOS, beside ⌘G),
 * so the editor keeps it: its binding passes over the editor's content and
 * its search panel (`GUIDE_KEY_EXCEPT`), and is live in every other field,
 * the terminals included, which take it from the pty. Checked against
 * CodeMirror's default, history and search keymaps, editorKeys.ts,
 * focusAreas.ts, the native menu (only ⌘Q and ⌘W) and GuidePane's own keys:
 * nothing else binds G.
 *
 * ## ⌘F, ⇧⌘F in the Review Guide: search it
 *
 * While focus is in a written guide -- its fields too -- ⌘F searches the
 * file being read and ⇧⌘F every file in the guide (#413). GuidePane hears
 * both in its own keydown, from `code` (`KeyF`), Command only, and stops
 * them there, so the window's ⇧⌘F (Find in Files, bubble phase) never hears
 * the key. Everywhere else -- a guide not yet written, the transcript, the
 * terminals, the editor -- ⇧⌘F is Find in Files, unchanged. ⌘F is bound
 * nowhere app-wide; CodeMirror's search keymap takes it in the editor, where
 * the guide never is. Checked against CodeMirror's default, history and
 * search keymaps, editorKeys.ts, focusAreas.ts, every other keydown
 * listener in src (none reads F) and the native menu (Tauri's default has
 * no Find; its Enter Full Screen is ⌃⌘F, which GuidePane leaves alone, as
 * it refuses Control).
 *
 * ## ⌘T: the shell
 *
 * The same as ⌥F12 (#232): opens or hides the shell drawer, from anywhere,
 * T for Terminal. Command only, from `code` (`KeyT`): Ctrl+T is Claude Code's
 * in the task terminal and transpose-chars in the shell, and both keep it.
 * xterm sends no Command combos to a pty, CodeMirror binds only Ctrl-T, and
 * the native menu has only ⌘Q and ⌘W, so nothing loses ⌘T.
 *
 * ## ⇧⌘T, ⇧⌘E: the Transcript and Files tabs
 *
 * Straight to a reading tab (#256), beside ⇧⌘G for the Guide: T for
 * Transcript, E for Files (VS Code's Explorer). Command only, from `code`, as
 * the rest of the family: Ctrl+Shift+T/E stay the terminals'. Live while
 * typing -- they move between tabs, and no field claims them: checked against
 * CodeMirror's default, history and search keymaps, editorKeys.ts,
 * focusAreas.ts and the native menu (only ⌘Q and ⌘W).
 *
 * ## ⌥⌘T: collapse or expand the task list
 *
 * The list as a rail of group counts, or back (#266), as the ‹ beside New
 * Task, the rail's › and the app ⋯ menu's item. Command and Option, from
 * `code` (`KeyT`): Option turns `key` into `†` on macOS. Live while typing,
 * as ⇧⌘T: it changes the frame, not the text. Taken from the terminals
 * (TAKEN_FROM_TERMINAL), which treat Option as Meta. Checked: CodeMirror's
 * default, history and search keymaps (their only T is Ctrl-T; their
 * Mod-Alt keys are G, the arrows and backslash), the editor's own keys
 * (FileEditor.tsx: Mod-Alt-M and ⌥⌘B; editorKeys.ts), focusAreas.ts, every
 * other keydown listener in src (none reads T), and the native menu (only
 * ⌘Q and ⌘W). Nothing else binds ⌥⌘T.
 *
 * ## ⌘↑ / ⌘↓: previous and next task
 *
 * The same step as ⌘[ / ⌘] (#398), in the list's own order. macOS only
 * (off a Mac there is no Command, and Ctrl+↑/↓ belong to others), Command only,
 * read from `key` (an arrow has no character for Option or the layout to
 * change), and no Shift or Option: ⇧⌘↑/↓ select to the start or end of a
 * field, and ⌥⌘↓ is Jump to the Latest Message in the transcript and Next
 * Changed File in the editor. Not Control either: Ctrl+↑/↓ is Claude Code's
 * own in the task terminal (its diff file list and agent groups, 2.1.325),
 * CodeMirror's page up/down on macOS, and Mission Control outside the app.
 *
 * Not in a text field (`whenTyping: 'ignore'`), where they are start and end
 * of the text, as ⌘←/⌘→ are start and end of the line: the message box, a
 * task title, the editor (contenteditable; CodeMirror's Cmd-ArrowUp/Down are
 * cursorDocStart/End), and the shell drawer, whose terminal input is a
 * textarea. Live in the TASK terminal, where focus lands right after a task
 * is selected, so a held ⌘↓ keeps walking: Claude Code binds neither key
 * (its `cmd`/`super` keys reach it only through a terminal that reports
 * Command, and xterm 5.5 sends nothing for ⌘ with an arrow: no bytes, no
 * scrolling), so the task terminal gives both up (TAKEN_FROM_TASK_TERMINAL)
 * and the binding names its input in `typingExcept`, as Rename does.
 *
 * And not where something focused already answered the arrow
 * (`whenHandled: 'ignore'`): an open menu (⋯, the git menu, closed
 * projects) and the editor's symbol results move on any ↑/↓, Command or
 * not, so there ⌘↓ stays theirs rather than doing two things at once. The
 * lists that care -- the task list's rows, the rail, the Files list and
 * tree, the Review Guide -- already refuse Command and leave it to this.
 *
 * And they stand down entirely (`taskArrowStandsDown`, in TASK_ARROW_TERMS):
 * under a modal dialog, in a code editor on screen (a read-only one can hold
 * no focus, so it counts when it was the last thing clicked), while an input method
 * composes, and on auto-repeat -- a held ⌘↓ would mount every task it passed
 * and spawn `claude --resume` for each. Other reading surfaces that are not
 * fields -- the Review Guide, a diff in Files, a preview -- do step tasks,
 * as the owner decided ("everywhere except text fields").
 *
 * Checked: CodeMirror's default, history and search keymaps (Cmd-ArrowUp/
 * Down, Ctrl-ArrowUp/Down, Mod-Alt-ArrowUp/Down for add cursor -- which the
 * editor's own ⌥⌘↑/↓ preempts, in the capture phase), editorKeys.ts,
 * focusAreas.ts, every other keydown listener in src that reads an arrow,
 * and the native menu (only ⌘Q and ⌘W). Nothing else binds ⌘↑ or ⌘↓.
 *
 * ## ⌥⌘↓: Jump to the Latest Message, in the transcript
 *
 * Was ⌘↓ until #398 gave that to the task step. Not a combo here: the
 * transcript listens for it (TranscriptPane.tsx, jumpKey.ts) only while it is
 * on screen and the keyboard is free there -- nothing focused, or focus in
 * the transcript and not in a field. The editor's ⌥⌘↓ is Next Changed File
 * (FileEditor.tsx), heard on the window in the capture phase even while its
 * tab is hidden; it lets ⌥⌘↓ through exactly when the transcript would take
 * it, and keeps it everywhere else (its own tab, the Files list). ⌥⌘↑ stays
 * the editor's Previous Changed File. Neither terminal takes them from
 * anyone: xterm 5.5 sends nothing for an arrow with ⌘ held.
 *
 * ## ⇧⌘S: send the waiting comments
 *
 * From anywhere (#258), as the Send beside them in Files and the guide: the
 * selected task's waiting comments go, and the transcript shows. Nothing
 * waiting, nothing happens. ⌘S is the editor's Save (exact match, so ⇧⌘S
 * never saves); Ctrl+S stays the terminals'. No CodeMirror keymap binds it.
 *
 * Double-Shift (Search Everywhere) is a gesture, not a combo: see
 * `createDoubleShift`.
 */

import { useEffect, useRef } from 'react';
import { detectPlatform, type Platform } from '../lib/platform';
import { modalOpen, terminalYieldsKey } from './focusAreas';

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
  | 'mod+arrowup'
  | 'mod+arrowdown'
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
  | 'mod+shift+r'
  | 'mod+shift+g'
  | 'mod+u'
  | 'mod+t'
  | 'mod+shift+t'
  | 'mod+alt+t'
  | 'mod+shift+e'
  | 'mod+shift+s'
  | 'alt+f12'
  | 'shift+f6'
  | 'f2';

/**
 * Bindings that are not one app-wide keystroke, documented alongside the
 * combos: a gesture, or a key that only the editor answers (its CodeMirror
 * keymap, or editorKeys.ts while it is on screen).
 */
export type Gesture =
  | 'shift shift'
  | 'focus tab'
  | 'focus ctrl+tab'
  | 'editor mod+b'
  | 'editor alt+f7'
  | 'editor mod+alt+b'
  | 'editor mod+shift+d'
  | 'editor mod+shift+c'
  | 'editor mod+alt+shift+c'
  | 'editor mod+alt+m'
  | 'transcript mod+alt+arrowdown'
  | 'transcript arrowup'
  | "transcript mod+'"
  | 'new-task mod+enter'
  | 'guide mod+enter'
  | 'guide alt+arrows'
  | 'guide arrows'
  | 'guide alt+enter'
  | 'guide mod+r'
  | 'guide mod+shift+r'
  | 'guide mod+f'
  | 'guide mod+shift+f';

export interface ShortcutDoc {
  combo: Combo | Gesture;
  /** How the key is written for a person: ⌘N, ⌘], ⌘←. */
  keys: string;
  description: string;
  /** Bound on macOS only; the help list leaves it out elsewhere. */
  macOnly?: true;
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
  { combo: 'mod+arrowup', keys: '⌘↑', description: 'Previous Task (not in a Text Field)', macOnly: true },
  { combo: 'mod+arrowdown', keys: '⌘↓', description: 'Next Task (not in a Text Field)', macOnly: true },
  { combo: 'mod+shift+[', keys: '⇧⌘[', description: 'Previous Project' },
  { combo: 'mod+shift+]', keys: '⇧⌘]', description: 'Next Project' },
  { combo: 'mod+alt+t', keys: '⌥⌘T', description: 'Collapse / Expand the Task List' },
  { combo: 'mod+arrowleft', keys: '⌘←', description: 'Previous Reading Tab' },
  { combo: 'mod+arrowright', keys: '⌘→', description: 'Next Reading Tab' },
  { combo: 'mod+\\', keys: '⌘\\', description: 'Cycle PTY / Split / Transcript (not on the Editor tab)' },
  {
    combo: 'focus tab',
    keys: 'Tab / ⇧Tab',
    description: 'Next / Previous Area: Message Box, Terminal, Files, Tasks (the Terminal and Editor keep Tab)',
  },
  { combo: 'focus ctrl+tab', keys: '⌃Tab / ⌃⇧Tab', description: 'Next / Previous Area from Anywhere, Terminal and Editor Too' },
  { combo: 'mod+shift+o', keys: '⇧⌘O', description: 'Go to File' },
  { combo: 'mod+o', keys: '⌘O', description: 'Go to Class' },
  { combo: 'mod+alt+o', keys: '⌥⌘O', description: 'Go to Symbol' },
  { combo: 'shift shift', keys: '⇧⇧', description: 'Search Everywhere' },
  { combo: 'mod+shift+f', keys: '⇧⌘F', description: 'Find in Files (in the Review Guide: Search All Its Files)' },
  { combo: 'mod+shift+p', keys: '⇧⌘P', description: 'Push the Selected Task (Commits First)' },
  {
    combo: 'mod+shift+r',
    keys: '⇧⌘R',
    description: 'Make the Selected Task Available Remotely (Asks First; in the Review Guide: Mark the Group Reviewed)',
  },
  { combo: 'mod+shift+g', keys: '⇧⌘G', description: 'Review Guide for the Selected Task (in the Editor: Find Previous)' },
  { combo: 'mod+shift+t', keys: '⇧⌘T', description: 'Transcript Tab' },
  { combo: 'mod+shift+e', keys: '⇧⌘E', description: 'Files Tab (or the Files column, when pinned)' },
  { combo: 'mod+shift+s', keys: '⇧⌘S', description: 'Send the Waiting Comments, then Show the Transcript' },
  { combo: 'mod+u', keys: '⌘U', description: 'Attach Files to the Message' },
  {
    combo: 'transcript arrowup',
    keys: '↑',
    description: 'Message Box, While Empty: Edit the Held Messages There as One (Esc Puts Them Back)',
  },
  {
    combo: 'shift+f6',
    keys: '⇧F6 / F2',
    description: 'Rename the Selected Task (in its Terminal too; not in a Text Field, the Editor or the Shell)',
  },
  { combo: 'editor mod+b', keys: '⌘B / ⌘-click', description: 'In the Editor: Go to Declaration (on one: its usages)' },
  { combo: 'editor alt+f7', keys: '⌥F7', description: 'In the Editor: Find Usages' },
  {
    combo: 'editor mod+alt+b',
    keys: '⌥⌘B',
    description: 'In the Editor: Go to Implementation (PHP: Implementers, Subclasses or Trait Users)',
  },
  { combo: 'editor mod+shift+d', keys: '⇧⌘D', description: 'In the Editor: Diff / File' },
  { combo: 'editor mod+shift+c', keys: '⇧⌘C', description: 'In the Editor: Copy Full Path' },
  { combo: 'editor mod+alt+shift+c', keys: '⌥⇧⌘C', description: 'In the Editor: Copy Path (from the Worktree)' },
  { combo: 'editor mod+alt+m', keys: '⌥⌘M', description: 'In the Editor: Comment on the Selected Lines' },
  {
    combo: 'transcript mod+alt+arrowdown',
    keys: '⌥⌘↓',
    description: 'Transcript: Jump to the Latest Message (not while typing)',
  },
  { combo: "transcript mod+'", keys: '⌘\'', description: 'Transcript: Comment on the Selected Text (inside one message)' },
  { combo: 'guide alt+arrows', keys: '⌥↑ / ⌥↓', description: 'Review Guide: Previous / Next Group' },
  { combo: 'guide arrows', keys: '↑ / ↓', description: 'Review Guide: Previous / Next File in the Group' },
  { combo: 'guide alt+enter', keys: '⌥↩', description: 'Review Guide: Mark the Group Reviewed and Go to the Next' },
  { combo: 'guide mod+r', keys: '⌘R', description: 'Review Guide: Mark the File Reviewed and Open the Next (Again Within 2 s: Undo)' },
  {
    combo: 'guide mod+shift+r',
    keys: '⇧⌘R',
    description: 'Review Guide: Mark the Group Reviewed and Go to the Next (Again Within 2 s: Undo)',
  },
  { combo: 'guide mod+enter', keys: '⌘↩', description: 'Review Guide: Send the Waiting Comments, then Show the Transcript' },
  { combo: 'guide mod+f', keys: '⌘F', description: 'Review Guide: Search This File (↩ / ⇧↩ Next / Previous, Esc Closes)' },
  { combo: 'guide mod+shift+f', keys: '⇧⌘F', description: 'Review Guide: Search All the Guide’s Files' },
  { combo: 'new-task mod+enter', keys: '⌘↩', description: 'In New Task: Create, from any field' },
  { combo: 'alt+f12', keys: '⌥F12', description: 'Shell in the Main Checkout' },
  { combo: 'mod+t', keys: '⌘T', description: 'Shell in the Main Checkout (the same as ⌥F12)' },
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
  /**
   * With `whenTyping: 'ignore'`: a selector for editable elements that do NOT
   * count as typing for this binding (the task terminal, for Rename).
   */
  typingExcept?: string;
  /**
   * `'ignore'` skips the binding when something below the window already
   * handled the key (`defaultPrevented`): a focused menu that moves on it.
   */
  whenHandled?: 'ignore';
  /**
   * Skips the binding, leaving the key alone (not prevented), when this
   * returns true: a situation-specific stand-down such as
   * {@link taskArrowStandsDown}.
   */
  unless?: (e: KeyboardEvent) => boolean;
  /**
   * `'capture'` hears the key on the way down, before the focused element:
   * for a binding that must work wherever focus is, even inside a component
   * that stops the key's propagation. Defaults to the bubble phase.
   */
  phase?: 'capture';
  /**
   * A selector for where focus may be when this binding stands aside: it
   * neither runs nor prevents the key there, so a pane can claim the combo
   * for itself (the Review Guide's ⇧⌘R). Checked in both phases.
   */
  standAsideIn?: string;
}

export type Bindings = Partial<Record<Combo, Handler | ((e: KeyboardEvent, digit: number | null) => void)>>;

/** True for the elements where a bare arrow or letter is the user's text. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // The attribute too: CodeMirror's content is `contenteditable="true"`, and
  // jsdom (the tests) does not implement `isContentEditable`.
  if (target.isContentEditable || target.closest('[contenteditable="true"]') !== null) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function matches(target: EventTarget | null, selector: string | undefined): boolean {
  return selector !== undefined && target instanceof Element && target.closest(selector) !== null;
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
  // Remote Control, on the same terms: Ctrl+R is the terminal's reverse search.
  if (e.code === 'KeyR' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+r', digit: null };
  }
  // The Transcript and Files tabs (#256), on the same terms.
  if (e.code === 'KeyT' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+t', digit: null };
  }
  // Collapse or expand the task list (#266): Command and Option, from `code`
  // (⌥T is † on macOS). Before the Alt check, which would refuse it.
  if (e.code === 'KeyT' && e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey) {
    return { combo: 'mod+alt+t', digit: null };
  }
  if (e.code === 'KeyE' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+e', digit: null };
  }
  // Send the waiting comments (#258), on the same terms: Ctrl+S is the
  // terminal's (XOFF), and ⌘S stays the editor's Save.
  if (e.code === 'KeyS' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+s', digit: null };
  }
  // The Review Guide (#207), on the same terms: Ctrl+G belongs to the terminal.
  if (e.code === 'KeyG' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+shift+g', digit: null };
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
  // The shell again, T for Terminal (#232). Command only, from `code`:
  // Ctrl+T is Claude Code's own key in the task terminal, and the shell's
  // transpose-chars, so neither loses it.
  if (e.code === 'KeyT' && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'mod+t', digit: null };
  }
  // Rename. Function keys, read from `code`; see the module comment.
  if (e.code === 'F6' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'shift+f6', digit: null };
  }
  if (e.code === 'F2' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { combo: 'f2', digit: null };
  }
  // Previous / next task (#398). macOS only, Command only, no Shift or
  // Option; see the module comment.
  if (
    platform === 'macos' &&
    (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    return { combo: e.key === 'ArrowUp' ? 'mod+arrowup' : 'mod+arrowdown', digit: null };
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
const TAKEN_FROM_TERMINAL: ReadonlySet<Combo> = new Set([
  'mod+alt+digit',
  'mod+shift+[',
  'mod+shift+]',
  'mod+shift+r',
  'mod+shift+g',
  'mod+shift+t',
  'mod+alt+t',
  'mod+shift+e',
  'mod+shift+s',
]);

/**
 * For xterm's `attachCustomKeyEventHandler`: false when the key is one of the
 * app's that the terminal must not also act on. The terminals treat Option as
 * Meta, so without this ⌥1 would switch project AND send `Esc 1` to the pty;
 * ⇧⌘[ / ⇧⌘] switch project too, so the pty does not get them either, and
 * ⇧⌘R opens a dialog over the terminal. Ctrl+Tab / Ctrl+Shift+Tab leave the
 * terminal for the next area (focusAreas.ts), as Tab does while the terminal
 * holds focus it took on its own; xterm would otherwise send them to the pty.
 */
export function terminalTakesKey(e: KeyboardEvent): boolean {
  if (terminalYieldsKey(e)) return false;
  const hit = comboOf(e);
  return hit === null || !TAKEN_FROM_TERMINAL.has(hit.combo);
}

/** Combos the Claude Code task terminal gives up as well; the shell drawer keeps them. */
const TAKEN_FROM_TASK_TERMINAL: ReadonlySet<Combo> = new Set(['shift+f6', 'f2', 'mod+arrowup', 'mod+arrowdown']);

/**
 * For ⇧⌘G's `typingExcept`: every field counts as not typing, except inside
 * the code editor, where the key is Find Previous.
 */
export const GUIDE_KEY_EXCEPT = ':is(input, textarea, select):not(.cm-editor *)';

/**
 * Marks the Review Guide's pane (GuidePane.tsx), where ⌘R and ⇧⌘R are the
 * guide's Reviewed keys (#390, #391) and ⇧⌘R is not Remote Control.
 */
export const GUIDE_AREA_ATTR = 'data-review-guide';
export const GUIDE_AREA = `[${GUIDE_AREA_ATTR}]`;

/** Marks the input of a task's Claude Code terminal (Terminal.tsx), not the shell drawer's. */
export const TASK_TERMINAL_ATTR = 'data-task-terminal';
export const TASK_TERMINAL_INPUT = `[${TASK_TERMINAL_ATTR}]`;

/**
 * When ⌘↑ / ⌘↓ stand down and leave the key alone (#398):
 *
 *  - a modal dialog is open (`aria-modal`): the step would switch the task
 *    behind it and pull focus into that task's terminal;
 *  - the user is in a code editor on screen, read-only ones included (the
 *    project view's file): in an editable one they are start and end of
 *    the document. A read-only CodeMirror is not contenteditable and cannot
 *    hold focus -- a click there leaves focus on the body -- so neither
 *    `whenTyping` nor the focused element shows it; the last pointerdown
 *    does (`lastPointerDown`). There ⌘↑ / ⌘↓ simply do nothing;
 *  - an input method is composing;
 *  - the key is auto-repeating: every task a held ⌘↓ passed would mount
 *    its terminal and spawn `claude --resume`. One step per press.
 */
export function taskArrowStandsDown(e: KeyboardEvent): boolean {
  if (e.repeat || e.isComposing || e.keyCode === 229) return true;
  if (modalOpen()) return true;
  if (inEditorOnScreen(e.target) || inEditorOnScreen(document.activeElement)) return true;
  // Nothing holds focus: the user is where they last clicked.
  const active = document.activeElement;
  const nothingFocused = active === null || active === document.body || active === document.documentElement;
  return nothingFocused && lastPointerDown !== null && lastPointerDown.isConnected && inEditorOnScreen(lastPointerDown);
}

/** Inside a CodeMirror editor that is not in a hidden tab (as FileEditor.tsx checks its own root). */
function inEditorOnScreen(n: unknown): boolean {
  if (!(n instanceof Element)) return false;
  return n.closest('.cm-editor') !== null && n.closest('[hidden]') === null;
}

/**
 * Where the last pointerdown landed, for {@link taskArrowStandsDown}: heard on
 * the window in the capture phase, before CodeMirror's own mousedown handling,
 * and only read, never acted on.
 */
let lastPointerDown: Element | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      lastPointerDown = e.target instanceof Element ? e.target : null;
    },
    true,
  );
}

/** How TaskList binds ⌘↑ / ⌘↓, shared so a test binds them the same way. */
export const TASK_ARROW_TERMS = {
  whenTyping: 'ignore',
  typingExcept: TASK_TERMINAL_INPUT,
  whenHandled: 'ignore',
  unless: taskArrowStandsDown,
} as const satisfies Omit<Handler, 'run'>;

/**
 * {@link terminalTakesKey} for a task's Claude Code terminal: also false for
 * ⇧F6 and F2 (Rename) and ⌘↑ / ⌘↓ (previous / next task), which Claude Code
 * does not use. The shell drawer keeps using `terminalTakesKey`, so its shell
 * still gets them.
 */
export function taskTerminalTakesKey(e: KeyboardEvent): boolean {
  if (!terminalTakesKey(e)) return false;
  const hit = comboOf(e);
  return hit === null || !TAKEN_FROM_TASK_TERMINAL.has(hit.combo);
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
    const listen = (phase: 'capture' | 'bubble') => (e: KeyboardEvent) => {
      const hit = comboOf(e);
      if (!hit) return;
      const entry = ref.current[hit.combo];
      if (!entry) return;
      const handler: Handler = typeof entry === 'function' ? { run: entry } : entry;
      if ((handler.phase ?? 'bubble') !== phase) return;
      if (handler.whenTyping === 'ignore' && isTyping(e.target) && !matches(e.target, handler.typingExcept)) return;
      if (matches(e.target, handler.standAsideIn)) return;
      if (handler.whenHandled === 'ignore' && e.defaultPrevented) return;
      if (handler.unless?.(e)) return;
      e.preventDefault();
      handler.run(e, hit.digit);
    };
    const onCapture = listen('capture');
    const onBubble = listen('bubble');
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
    };
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
