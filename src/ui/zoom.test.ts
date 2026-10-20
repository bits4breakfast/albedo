import { describe, expect, it } from 'vitest';
import { stepZoom, ZOOM_STEPS } from './zoom';

describe('stepZoom', () => {
  it('steps through the scale and clamps at both ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
    const top = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
    expect(stepZoom(top, 1)).toBe(top);
  });
});
