import { describe, expect, it } from 'vitest';
import { thumbGeometry } from './OverlayScrollbar';

describe('thumbGeometry', () => {
  it('is null when nothing scrolls', () => {
    expect(thumbGeometry(0, 500, 500)).toBeNull();
  });
  it('sizes the thumb by the visible share and moves it with the scroll', () => {
    expect(thumbGeometry(0, 1000, 500)).toEqual({ top: 0, height: 250 });
    expect(thumbGeometry(500, 1000, 500)).toEqual({ top: 250, height: 250 });
  });
  it('keeps a long transcript thumb grabbable', () => {
    expect(thumbGeometry(0, 1_000_000, 500)?.height).toBe(28);
  });
});
