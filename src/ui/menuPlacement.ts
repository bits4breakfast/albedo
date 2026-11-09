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
