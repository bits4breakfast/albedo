/**
 * A selection's range, trimmed to the text it actually covers (#449).
 *
 * A triple click selects a whole block, and the browser (Blink and WebKit
 * alike) ends that range at the NEXT block's first selectable position:
 * offset 0 of its first content, AFTER any `user-select: none` text before
 * it -- a row's "You" gutter, a diff row's line numbers and +/- mark. The
 * range reaches into the following row without covering a character of it
 * the user could select. Read as is, its end is in the wrong row (so a
 * comment is refused) and its last client rect is the empty one at the start
 * of that next row (so the bar is drawn there). The same can happen to a
 * start left at the very end of the block before.
 *
 * `trimRange` moves the end back to the end of the last text node holding
 * selected, non-whitespace, selectable text, and the start forward to the
 * first such node. Text under `user-select: none` is passed over: it is in
 * the DOM range, never in what the user selected. An end or start already
 * inside such text -- what a drag leaves -- stays where it is. It never
 * touches the range it is given: the user's live selection is left alone.
 */

/** Where a boundary of `range` lands in text node `t`, or null when `t` is outside it. */
function covered(range: Range, t: Text): { s: number; e: number } | null {
  let inside: boolean;
  try {
    inside = range.intersectsNode(t);
  } catch {
    return null;
  }
  if (!inside) return null;
  const s = t === range.startContainer ? range.startOffset : 0;
  const e = t === range.endContainer ? range.endOffset : t.length;
  return { s, e };
}

/**
 * Whether the user can select `t`: the nearest element from it up with an
 * explicit `user-select` (or `-webkit-user-select`) decides -- `none` no,
 * anything else but `auto` yes. Not "any ancestor is none": the app's shell
 * sets `body { user-select: none }` and the panes turn it back on
 * (`.tx-pane { user-select: text }`), so every transcript text has a `none`
 * above it. A browser computes the pane's value on its descendants and
 * decides at the parent; jsdom, which computes no inheritance, walks up to
 * the rule. With no explicit value anywhere, it is selectable.
 */
function selectable(t: Text): boolean {
  const view = t.ownerDocument.defaultView;
  if (!view) return true;
  for (let el: Element | null = t.parentElement; el !== null; el = el.parentElement) {
    const css = view.getComputedStyle(el);
    const vs = [css.getPropertyValue('user-select'), css.getPropertyValue('-webkit-user-select')];
    if (vs.includes('none')) return false;
    if (vs.some((v) => v !== '' && v !== 'auto')) return true;
  }
  return true;
}

/**
 * Selected, non-blank, selectable text. Blank text is ruled out first, so a
 * style is read only for a node that could end the walk: the walk stops at
 * the first one that is selectable, a few nodes from the edge however long
 * the range is.
 */
function hasText(t: Text, at: { s: number; e: number } | null): at is { s: number; e: number } {
  return at !== null && at.e > at.s && /\S/.test(t.data.slice(at.s, at.e)) && selectable(t);
}

function deepestLast(n: Node): Node {
  let d = n;
  while (d.lastChild) d = d.lastChild;
  return d;
}

/** The last text node with selected, non-blank text, walking back from the range's end. */
function lastText(range: Range, walker: TreeWalker): { t: Text; e: number } | null {
  const { endContainer: c, endOffset: o } = range;
  // The node the walk starts on, and whether it is itself a candidate.
  let from: Node;
  let self: boolean;
  if (c.nodeType === Node.TEXT_NODE) [from, self] = [c, true];
  else if (o > 0 && c.childNodes[o - 1]) [from, self] = [deepestLast(c.childNodes[o - 1]!), true];
  else [from, self] = [c, false];
  walker.currentNode = from;
  for (let n: Node | null = self ? from : walker.previousNode(); n !== null; n = walker.previousNode()) {
    if (n.nodeType !== Node.TEXT_NODE) continue;
    const t = n as Text;
    // Before the start: nothing more of the range lies behind it.
    if (range.comparePoint(t, t.length) < 0) return null;
    const at = covered(range, t);
    if (hasText(t, at)) return { t, e: at.e };
  }
  return null;
}

/** The first text node with selected, non-blank text, walking on from the range's start. */
function firstText(range: Range, walker: TreeWalker): { t: Text; s: number } | null {
  const { startContainer: c, startOffset: o } = range;
  let from: Node;
  let self: boolean;
  if (c.nodeType === Node.TEXT_NODE) [from, self] = [c, true];
  else if (c.childNodes[o]) [from, self] = [c.childNodes[o]!, true];
  else [from, self] = [deepestLast(c), false];
  walker.currentNode = from;
  for (let n: Node | null = self ? from : walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n.nodeType !== Node.TEXT_NODE) continue;
    const t = n as Text;
    // Past the end: nothing more of the range lies ahead.
    if (range.comparePoint(t, 0) > 0) return null;
    const at = covered(range, t);
    if (hasText(t, at)) return { t, s: at.s };
  }
  return null;
}

/**
 * `range` trimmed to the text it covers, as a new range; `cut` says whether
 * a boundary moved (the browser's text for it may carry a line break the
 * trimmed one does not). A range
 * with no non-blank text at all comes back as an unchanged copy.
 */
export function trimRange(range: Range): { range: Range; cut: boolean } {
  const out = range.cloneRange();
  const root = range.commonAncestorContainer;
  if (range.collapsed || root.nodeType === Node.TEXT_NODE) return { range: out, cut: false };
  const doc = root.ownerDocument ?? (root as Document);
  // SHOW_ALL so a walk can start on an element; only text nodes are read.
  const first = firstText(range, doc.createTreeWalker(root, NodeFilter.SHOW_ALL));
  const last = lastText(range, doc.createTreeWalker(root, NodeFilter.SHOW_ALL));
  if (!first || !last) return { range: out, cut: false };
  out.setStart(first.t, first.s);
  out.setEnd(last.t, last.e);
  const moved =
    out.startContainer !== range.startContainer ||
    out.startOffset !== range.startOffset ||
    out.endContainer !== range.endContainer ||
    out.endOffset !== range.endOffset;
  return { range: out, cut: moved };
}
