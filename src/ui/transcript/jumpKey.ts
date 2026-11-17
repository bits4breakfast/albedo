/**
 * ⌥⌘↓, Jump to the Latest Message (#398; it was ⌘↓, which now steps tasks).
 *
 * Its own module, with no stylesheet, because the editor asks it too: the
 * editor's ⌥⌘↓ (Next Changed File, FileEditor.tsx) listens on the window in
 * the capture phase, ahead of the transcript. It acts only while the editor
 * is on screen (#428), and even then yields exactly when
 * {@link transcriptTakesJumpKey} is true.
 */

/** Marks a transcript's scroller, the element ⌥⌘↓ scrolls (TranscriptPane.tsx). */
export const JUMP_LATEST_ATTR = 'data-jump-latest';

/** ⌥⌘↓ and nothing else: not ⌘↓ (Next Task), not with Shift or Control. */
export function isJumpToLatestKey(e: KeyboardEvent): boolean {
  return e.key === 'ArrowDown' && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey;
}

/**
 * Whether a key can be taken without stealing it from something focused:
 * nothing has focus (the window itself), or focus is inside `scroller` on an
 * element that is not a text field.
 */
export function keyboardIsFree(active: Element | null, scroller: Element): boolean {
  if (active === null || active === document.body || active === document.documentElement) return true;
  if (!scroller.contains(active)) return false;
  const editable =
    (active instanceof HTMLElement && active.isContentEditable) ||
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT';
  return !editable;
}

/** Whether `scroller` is on screen: not inside a hidden tab or pane. */
export function onScreen(scroller: HTMLElement): boolean {
  return scroller.offsetParent !== null;
}

/**
 * True when this keydown is ⌥⌘↓ and a transcript on screen will take it: the
 * keyboard is free there (nothing focused, or focus in that transcript and
 * not in a field).
 */
export function transcriptTakesJumpKey(e: KeyboardEvent): boolean {
  if (!isJumpToLatestKey(e)) return false;
  const scrollers = document.querySelectorAll<HTMLElement>(`[${JUMP_LATEST_ATTR}]`);
  return Array.from(scrollers).some((el) => onScreen(el) && keyboardIsFree(document.activeElement, el));
}
