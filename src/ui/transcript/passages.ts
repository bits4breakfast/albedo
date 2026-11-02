/**
 * Passages of the rendered transcript (#187): finding a quoted passage again
 * in a row's DOM, marking it, and taking the reader to it.
 *
 * A passage is found by its text, not by offsets into the DOM: a row renders
 * the same text after a reload, while its nodes do not. Whitespace is left
 * out of the match on both sides, because what a selection reads as text
 * (line breaks between blocks, a code block's lines) and what the DOM holds
 * differ in nothing else. `offset` -- the non-blank characters before the
 * passage when it was selected -- picks the right one of several matches.
 *
 * Marks are drawn with the CSS Custom Highlight API, so nothing is inserted
 * into rows React owns; where it is missing the passage is simply not
 * marked, and a jump still scrolls to the row and flashes it.
 */

import { createContext } from 'react';

/** Take the reader to a passage: scroll to its row, and flash it. */
export type RevealPassage = (target: { messageId: number; quote: string; offset?: number }) => void;

/** Provided by the transcript pane; absent elsewhere, where a quote is not a link. */
export const PassageRevealContext = createContext<RevealPassage | null>(null);

/** Where a row's text is: its content column, never the gutter. */
export function rowContent(row: Element): Element {
  return row.querySelector(':scope > .tx-content') ?? row;
}

function isBlank(ch: string): boolean {
  return /\s/.test(ch);
}

/** Every non-blank character under `root`, with the text node and offset it is at. */
function textMap(root: Node): { chars: string; at: Array<[Text, number]> } {
  const at: Array<[Text, number]> = [];
  let chars = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const t = n as Text;
    const s = t.data;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i] as string;
      if (isBlank(ch)) continue;
      chars += ch;
      at.push([t, i]);
    }
  }
  return { chars, at };
}

/** The passage without its whitespace: what `findPassage` matches. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Non-blank characters from the start of `root` to the start of `range`. */
export function offsetOf(root: Node, range: Range): number {
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return squeeze(before.toString()).length;
}

/**
 * The passage in `root` as a Range, or null when it is not there (a folded
 * block, a row that is not drawn). With several matches, the one nearest
 * `offset`.
 */
export function findPassage(root: Node, quote: string, offset = 0): Range | null {
  const needle = squeeze(quote);
  if (needle.length === 0) return null;
  const { chars, at } = textMap(root);
  let best = -1;
  for (let i = chars.indexOf(needle); i >= 0; i = chars.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - offset) < Math.abs(best - offset)) best = i;
    if (i >= offset) break;
  }
  if (best < 0) return null;
  const start = at[best];
  const end = at[best + needle.length - 1];
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1] + 1);
  return range;
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

/** The CSS highlight names (transcript.css draws them). */
export const HIGHLIGHT = {
  /** Passages with a comment waiting. */
  waiting: 'albedo-comment',
  /** The passage being commented on, while its field is open. */
  pending: 'albedo-comment-pending',
  /** A passage just jumped to. */
  flash: 'albedo-comment-flash',
} as const;

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}

function registry(): { reg: HighlightRegistry; make: (ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || typeof Ctor !== 'function') return null;
  return { reg: css.highlights, make: (ranges) => new Ctor(...ranges) };
}

/** Draw `ranges` under `name`, replacing what it drew before; none clears it. */
export function setHighlight(name: string, ranges: Range[]): void {
  const r = registry();
  if (!r) return;
  if (ranges.length === 0) r.reg.delete(name);
  else r.reg.set(name, r.make(ranges));
}

/** How long a jumped-to passage stays flashed. */
export const FLASH_MS = 1600;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bring a passage of `row` to the middle of `scroller` and flash it; the row
 * itself when the passage is not found. True when the passage was found.
 */
export function revealPassageIn(scroller: HTMLElement, row: HTMLElement, quote: string, offset = 0): boolean {
  const range = findPassage(rowContent(row), quote, offset);
  const target = range?.getBoundingClientRect?.();
  if (range && target && (target.height > 0 || target.width > 0)) {
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += target.top - box.top - (scroller.clientHeight - target.height) / 2;
  } else {
    row.scrollIntoView?.({ block: 'center' });
  }
  if (flashTimer !== null) clearTimeout(flashTimer);
  setHighlight(HIGHLIGHT.flash, range ? [range] : []);
  row.classList.add('tx-row-flash');
  flashTimer = setTimeout(() => {
    flashTimer = null;
    setHighlight(HIGHLIGHT.flash, []);
    row.classList.remove('tx-row-flash');
  }, FLASH_MS);
  return range !== null;
}
