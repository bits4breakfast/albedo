/**
 * Tab moves between the window's areas, not its controls (#129).
 *
 * The cycle is: message box → terminal → Files → task list → message box, and
 * Shift+Tab walks it backwards. The editor stands in the message box's slot
 * when the Editor tab is showing instead of the transcript (the two never
 * share the screen), so it is reachable too. An area that is not on screen,
 * or holds nothing that can take focus, is skipped.
 *
 * ## Which key, from where
 *
 *  - **Tab / Shift+Tab** cycle from anywhere that does not use Tab itself. From
 *    outside every area (a toolbar button, the transcript, bare background --
 *    focus on `<body>`) the first Tab, either direction, lands in the message
 *    box, so it is one key away whatever was clicked last.
 *  - **Ctrl+Tab / Ctrl+Shift+Tab** cycle from anywhere, including the places
 *    that keep Tab. That is how you leave the terminal and the editor. In xterm
 *    Ctrl+Tab was only ever a second Tab (it sends the same HT byte; Ctrl+Shift+Tab
 *    the same back-tab as Shift+Tab), so the terminal loses nothing; CodeMirror,
 *    `shortcuts.ts` and the app menu bind neither.
 *  - Not Esc: Claude Code uses it to interrupt.
 *
 * ## A terminal that took focus on its own
 *
 * Selecting a task focuses its terminal (Terminal.tsx), so typing goes
 * straight to Claude Code. That focus is marked `data-focus-auto` until the
 * person engages: any other key, a click anywhere, or focus moving away. While
 * it is marked, Tab is not the terminal's yet, so the first Tab after
 * selecting a task still lands in the message box. Typing first and then
 * pressing Tab -- autocomplete -- reaches the terminal as before.
 *
 * ## Who keeps Tab
 *
 * Anything inside a `[data-focus-keeps-tab]` element: the terminal (Claude
 * Code's autocomplete, Shift+Tab its mode switch), the editor (indent), the
 * shell drawer, and the small forms where Tab walks between a field and its
 * buttons (the "waiting on you" card, a held message being edited, the review
 * comments' opening text). Anything that already handled Tab
 * (`defaultPrevented`: the QuickOpen, Find in Files and symbol-results lists,
 * CodeMirror's indent) keeps it too. An open `aria-modal` dialog keeps both
 * keys, so focus never slips behind it.
 *
 * ## The DOM contract
 *
 *  - `data-focus-area="<id>"` on each area's root element.
 *  - `data-focus-default` on the element an area should focus (the message box
 *    textarea, xterm's textarea, the open file's row, CodeMirror's content);
 *    `data-focus-fallback` on the next best (any file row). Without either, the
 *    root itself when it is focusable (the task list, a listbox), then its first
 *    tabbable element.
 *  - `data-focus-arrived` is set on the root the cycle moved into and cleared
 *    when focus leaves it: the ring that says where the keyboard went.
 *
 * The decisions are pure functions (`cycleKeyOf`, `shouldCycle`,
 * `areaSequence`) so they are tested without a DOM; the hook only wires them.
 */

import { useEffect } from 'react';

export const AREA_ORDER = ['composer', 'editor', 'terminal', 'files', 'tasks'] as const;
export type FocusArea = (typeof AREA_ORDER)[number];

export interface CycleKey {
  /** 1 forwards, -1 backwards (Shift). */
  dir: 1 | -1;
  /** Ctrl held: cycle even from an area that keeps plain Tab. */
  leave: boolean;
}

type KeyProbe = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'> & {
  isComposing?: boolean;
};

/** Tab, Shift+Tab, Ctrl+Tab or Ctrl+Shift+Tab; null for anything else. */
export function cycleKeyOf(e: KeyProbe): CycleKey | null {
  if (e.key !== 'Tab' || e.metaKey || e.altKey || e.isComposing) return null;
  return { dir: e.shiftKey ? -1 : 1, leave: e.ctrlKey };
}

const AUTO_ATTR = 'data-focus-auto';

/**
 * For the terminals' custom key handler: true for a key the terminal hands to
 * the cycle instead of sending it to the pty. Ctrl+Tab always; plain Tab and
 * Shift+Tab only while the terminal holds focus it took on its own.
 */
export function terminalYieldsKey(e: KeyProbe & Pick<KeyboardEvent, 'target'>): boolean {
  const key = cycleKeyOf(e);
  if (key === null) return false;
  return key.leave || isAutoFocused(e.target);
}

function isAutoFocused(el: EventTarget | null): boolean {
  return el instanceof Element && el.hasAttribute(AUTO_ATTR);
}

/**
 * Focus `el` on the app's own initiative (a task was selected), and mark it so
 * the next Tab still goes to the message box. A no-op when focus did not land.
 */
export function focusOnItsOwn(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  if (el.ownerDocument.activeElement === el) el.setAttribute(AUTO_ATTR, '');
}

function clearAuto(doc: Document, keep: EventTarget | null = null): void {
  for (const el of Array.from(doc.querySelectorAll(`[${AUTO_ATTR}]`))) {
    if (el !== keep) el.removeAttribute(AUTO_ATTR);
  }
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

export interface CycleContext {
  /** An `aria-modal` dialog is open. */
  modalOpen: boolean;
  /** Focus is inside a `[data-focus-keeps-tab]` element. */
  keepsTab: boolean;
  /** Something earlier already acted on the key. */
  handled: boolean;
}

/** Whether this key, in this situation, moves between areas. */
export function shouldCycle(key: CycleKey, ctx: CycleContext): boolean {
  if (ctx.modalOpen || ctx.handled) return false;
  if (ctx.keepsTab && !key.leave) return false;
  return true;
}

/**
 * The areas to try, in order, when cycling from `from` (null: from outside
 * every area). The first one that actually takes focus wins, so an area whose
 * target turns out not to be focusable is skipped like one that is off screen.
 *
 * From outside, the message box comes first in both directions -- "the first
 * Tab goes to the message box" -- then the rest in the key's direction. From an
 * area, the others in the key's direction, wrapping; never the area itself.
 */
export function areaSequence(from: FocusArea | null, onScreen: ReadonlySet<FocusArea>, dir: 1 | -1): FocusArea[] {
  const n = AREA_ORDER.length;
  const start = from === null ? 0 : AREA_ORDER.indexOf(from);
  const out: FocusArea[] = [];
  for (let i = from === null ? 0 : 1; i < n; i++) {
    const area = AREA_ORDER[(((start + dir * i) % n) + n) % n]!;
    if (onScreen.has(area)) out.push(area);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const AREA_ATTR = 'data-focus-area';
const ARRIVED_ATTR = 'data-focus-arrived';
const TABBABLE =
  'textarea, input, select, button, a[href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function isFocusArea(v: string | undefined): v is FocusArea {
  return (AREA_ORDER as readonly string[]).includes(v ?? '');
}

/**
 * On screen: no `hidden` ancestor (how App hides panes, tabs and inactive
 * terminals) and, where the engine can tell, actually rendered.
 */
function shown(el: Element): boolean {
  if (!el.isConnected || el.closest('[hidden], [inert]') !== null) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el) : true;
}

function usable(el: HTMLElement): boolean {
  return shown(el) && !(el as HTMLElement & { disabled?: boolean }).disabled;
}

/** The area roots on screen, one per area (Files can be mounted twice). */
function visibleRoots(doc: Document): Map<FocusArea, HTMLElement> {
  const roots = new Map<FocusArea, HTMLElement>();
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(`[${AREA_ATTR}]`))) {
    const id = el.getAttribute(AREA_ATTR) ?? undefined;
    if (isFocusArea(id) && !roots.has(id) && shown(el)) roots.set(id, el);
  }
  return roots;
}

/** The area holding `el`, or null when it is in none of them. */
export function areaOf(el: Element | null): FocusArea | null {
  const id = el?.closest(`[${AREA_ATTR}]`)?.getAttribute(AREA_ATTR) ?? undefined;
  return isFocusArea(id) ? id : null;
}

/** Focus the area's natural element. False when nothing in it would take focus. */
export function focusArea(root: HTMLElement): boolean {
  const doc = root.ownerDocument;
  const candidates = [
    ...Array.from(root.querySelectorAll<HTMLElement>('[data-focus-default]')),
    ...Array.from(root.querySelectorAll<HTMLElement>('[data-focus-fallback]')),
    ...(root.hasAttribute('tabindex') ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)),
  ];
  for (const el of candidates) {
    if (!usable(el)) continue;
    el.focus();
    if (doc.activeElement === el) {
      markArrived(root);
      return true;
    }
  }
  return false;
}

function markArrived(root: HTMLElement): void {
  for (const el of Array.from(root.ownerDocument.querySelectorAll(`[${ARRIVED_ATTR}]`))) {
    if (el !== root) el.removeAttribute(ARRIVED_ATTR);
  }
  root.setAttribute(ARRIVED_ATTR, '');
}

/** Drop the ring from every area that no longer holds `target`. */
function clearArrived(doc: Document, target: EventTarget | null): void {
  for (const el of Array.from(doc.querySelectorAll(`[${ARRIVED_ATTR}]`))) {
    if (!(target instanceof Node) || !el.contains(target)) el.removeAttribute(ARRIVED_ATTR);
  }
}

/**
 * The window's keydown handler. Returns true when it moved focus (and then
 * prevented the key's default); false leaves the key to the browser.
 */
export function handleCycleKey(e: KeyboardEvent, doc: Document = document): boolean {
  const key = cycleKeyOf(e);
  if (!key) return false;
  const active = doc.activeElement;
  const inside = active !== null && active !== doc.body && active !== doc.documentElement ? active : null;
  const go = shouldCycle(key, {
    modalOpen: doc.querySelector('[aria-modal="true"]') !== null,
    keepsTab: inside?.closest('[data-focus-keeps-tab]') != null && !isAutoFocused(inside),
    handled: e.defaultPrevented,
  });
  if (!go) return false;
  const roots = visibleRoots(doc);
  // Focus the app placed counts as no focus at all: the message box is next.
  const from = isAutoFocused(inside) ? null : areaOf(inside);
  for (const area of areaSequence(from, new Set(roots.keys()), key.dir)) {
    const root = roots.get(area);
    if (root && focusArea(root)) {
      e.preventDefault();
      return true;
    }
  }
  return false;
}

/** Install the area cycle for the lifetime of the component. Mount once. */
export function useFocusAreaCycle(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => void handleCycleKey(e);
    // Capture: xterm stops the keys it handles, so a bubbling listener would
    // never learn that the person started typing in the terminal.
    const onKeyFirst = (e: KeyboardEvent) => {
      if (cycleKeyOf(e) === null && !MODIFIERS.has(e.key)) clearAuto(document);
    };
    const onFocusIn = (e: FocusEvent) => {
      clearArrived(document, e.target);
      clearAuto(document, e.target);
    };
    const onPointerDown = (e: PointerEvent) => {
      clearArrived(document, e.target);
      clearAuto(document);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onKeyFirst, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onKeyFirst, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);
}
