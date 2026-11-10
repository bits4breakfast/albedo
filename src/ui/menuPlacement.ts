/**
 * Where a menu opened at the pointer goes so that all of it is in the window
 * (#285). Pure.
 *
 * Below and to the right of the pointer when it fits; above it (its bottom at
 * the pointer) when it does not fit below but fits above; likewise to the left
 * when it does not fit to the right. Otherwise it is pushed inside the
 * window's edges, and a menu taller than the window is capped and scrolls --
 * every item stays reachable.
 */

export interface MenuPlacement {
  left: number;
  top: number;
  /** Set only when the menu is taller than the window allows. */
  maxHeight?: number;
}

/** Room kept between a menu and the window's edges. */
export const MENU_MARGIN = 8;

export function placeMenu(
  pointer: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = MENU_MARGIN,
): MenuPlacement {
  const left = fit(pointer.x, size.width, viewport.width, margin);
  const room = viewport.height - 2 * margin;
  if (size.height > room) return { left, top: margin, maxHeight: Math.max(0, room) };
  return { left, top: fit(pointer.y, size.height, viewport.height, margin) };
}

/** Start at `p` if it fits after it, else end at `p` if it fits before it, else clamp. */
function fit(p: number, size: number, extent: number, margin: number): number {
  if (p + size <= extent - margin) return Math.max(margin, p);
  const end = Math.min(p, extent - margin);
  if (end - size >= margin) return end - size;
  return Math.max(margin, Math.min(p, extent - margin - size));
}

/** Where a popover beside an anchor goes, and where its arrow points. */
export interface BesidePlacement {
  left: number;
  top: number;
  /** The arrow's centre, from the popover's top edge: level with the anchor's centre. */
  arrowY: number;
  /** Set only when the popover is taller than the window allows. */
  maxHeight?: number;
}

/** How far the arrow sits from the popover's top (or bottom, flipped) by preference. */
export const ARROW_INSET = 20;
/** The arrow never comes closer than this to the popover's corners. */
const ARROW_MIN = 12;

/**
 * A popover to the right of an anchor (a task list row, #332), with an arrow
 * pointing at the anchor's vertical centre, kept in the window. Pure.
 *
 * Its top sits {@link ARROW_INSET} above the anchor's centre when it fits
 * below that; otherwise it flips, its bottom {@link ARROW_INSET} below the
 * centre; otherwise it is pushed inside the window's edges. A popover taller
 * than the window is capped and scrolls, as {@link placeMenu}'s menus do.
 * The arrow follows the anchor's centre wherever the popover lands, kept off
 * its corners.
 */
export function placeBeside(
  anchor: { top: number; bottom: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 10,
  margin = MENU_MARGIN,
): BesidePlacement {
  const cy = (anchor.top + anchor.bottom) / 2;
  const left = Math.max(margin, Math.min(anchor.right + gap, viewport.width - margin - size.width));
  const room = viewport.height - 2 * margin;
  const arrow = (top: number, height: number) => Math.max(ARROW_MIN, Math.min(height - ARROW_MIN, cy - top));
  if (size.height > room) {
    const height = Math.max(0, room);
    return { left, top: margin, arrowY: arrow(margin, height), maxHeight: height };
  }
  const below = cy - ARROW_INSET;
  const above = cy + ARROW_INSET - size.height;
  const preferred = below + size.height <= viewport.height - margin ? below : above;
  const top = Math.max(margin, Math.min(preferred, viewport.height - margin - size.height));
  return { left, top, arrowY: arrow(top, size.height) };
}
