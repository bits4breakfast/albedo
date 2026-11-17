/**
 * Which marked passages a point of the transcript is on (#434).
 *
 * A waiting comment's passage is drawn with the CSS Custom Highlight API
 * (passages.ts): a Range, not an element, so nothing under the pointer says
 * "this is a mark". The point is turned into the character under it -- the
 * engine's caret at that point, then whichever of the characters beside the
 * caret has its box around the point -- and that character is looked up in
 * the marks' ranges. A point beside the text (past a line's end, in a
 * margin) is on no character, so it is on no mark, even where a mark's
 * block-level range would cover that blank space.
 */

/** A text position, as the engine reports the caret at a point. */
export interface Caret {
  node: Node;
  offset: number;
}

/** The caret at a viewport point, or null: WebKit and Chromium name it differently. */
export function caretAt(x: number, y: number): Caret | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === 'function') {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

function boxOf(range: Range): DOMRect | null {
  if (typeof range.getBoundingClientRect !== 'function') return null;
  const r = range.getBoundingClientRect();
  return r.width > 0 || r.height > 0 ? r : null;
}

/** Half a pixel either way: a box's own edge counts as inside. */
const SLACK = 0.5;

function holds(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left - SLACK && x <= r.right + SLACK && y >= r.top - SLACK && y <= r.bottom + SLACK;
}

/**
 * The character at a viewport point: its text node, start offset, and box
 * (null where the engine draws no boxes -- then the caret's own character
 * is taken on trust). Null when the point is on no character.
 */
export function charAt(x: number, y: number, caret: (x: number, y: number) => Caret | null = caretAt): { node: Text; offset: number; box: DOMRect | null } | null {
  const at = caret(x, y);
  if (!at || at.node.nodeType !== Node.TEXT_NODE) return null;
  const node = at.node as Text;
  // The caret falls between two characters: the one after it, or before it.
  const candidates = [at.offset, at.offset - 1].filter((o) => o >= 0 && o < node.length);
  let unmeasured: number | null = null;
  for (const offset of candidates) {
    const r = document.createRange();
    r.setStart(node, offset);
    r.setEnd(node, offset + 1);
    const box = boxOf(r);
    if (box === null) {
      unmeasured ??= offset;
      continue;
    }
    if (holds(box, x, y)) return { node, offset, box };
  }
  // Measured, and the point is beside every character near the caret.
  if (unmeasured === null) return null;
  return { node, offset: unmeasured, box: null };
}

/** Whether `range` holds the one character at `offset` of `node`. */
export function rangeHolds(range: Range, node: Text, offset: number): boolean {
  try {
    return range.comparePoint(node, offset) >= 0 && range.comparePoint(node, offset + 1) <= 0;
  } catch {
    // Not in the range's document or tree (a row redrawn since).
    return false;
  }
}

/** The marks a viewport point is on, in the order given, and the box of the character it is on. */
export function marksAt<T extends { range: Range }>(
  marks: readonly T[],
  x: number,
  y: number,
  caret: (x: number, y: number) => Caret | null = caretAt,
): { hits: T[]; box: DOMRect | null } {
  if (marks.length === 0) return { hits: [], box: null };
  const ch = charAt(x, y, caret);
  if (!ch) return { hits: [], box: null };
  return { hits: marks.filter((m) => rangeHolds(m.range, ch.node, ch.offset)), box: ch.box };
}
