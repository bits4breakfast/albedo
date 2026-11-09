import { describe, expect, it } from 'vitest';
import { placeMenu } from './menuPlacement';

const view = { width: 1200, height: 800 };
const menu = { width: 340, height: 420 };

describe('placeMenu (#285)', () => {
  it('opens below and to the right of the pointer when it fits', () => {
    expect(placeMenu({ x: 100, y: 100 }, menu, view)).toEqual({ left: 100, top: 100 });
  });

  it('opens upward when the pointer is near the bottom (the last row of the list)', () => {
    // The owner's case: the only task under Done, at the bottom of the window.
    expect(placeMenu({ x: 480, y: 700 }, menu, view)).toEqual({ left: 480, top: 280 });
  });

  it('opens to the left when it does not fit to the right', () => {
    expect(placeMenu({ x: 1000, y: 100 }, menu, view)).toEqual({ left: 660, top: 100 });
  });

  it('is pushed inside the window when it fits neither way', () => {
    // 420 tall in a 500-high window, pointer in the middle: below needs 670,
    // above needs -170. Clamped so its bottom is 8 px from the edge.
    expect(placeMenu({ x: 100, y: 250 }, menu, { width: 1200, height: 500 })).toEqual({ left: 100, top: 72 });
  });

  it('is capped and scrolls when taller than the window', () => {
    expect(placeMenu({ x: 100, y: 200 }, menu, { width: 1200, height: 300 })).toEqual({
      left: 100,
      top: 8,
      maxHeight: 284,
    });
  });

  it('keeps every edge at least the margin inside', () => {
    for (const [x, y] of [[0, 0], [1199, 799], [600, 400], [5, 790], [1195, 5]] as const) {
      const p = placeMenu({ x, y }, menu, view);
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.left + menu.width).toBeLessThanOrEqual(view.width - 8);
      expect(p.top + menu.height).toBeLessThanOrEqual(view.height - 8);
    }
  });
});
