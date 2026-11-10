import { describe, expect, it } from 'vitest';
import { SIDEBAR_MIN, sidebarCodec } from './useLayout';

describe('the task list width (#306)', () => {
  it('is never narrower than the width at which both tabs fit whole', () => {
    expect(SIDEBAR_MIN).toBe(300);
    // A width saved under the old 200px minimum opens at 300px.
    expect(sidebarCodec.decode('260')).toBe(300);
    expect(sidebarCodec.decode('200')).toBe(300);
    expect(sidebarCodec.decode('360')).toBe(360);
    expect(sidebarCodec.decode('')).toBe(300);
  });
});
