import { describe, expect, it } from 'vitest';
import { COMPOSER_MAX_PX, COMPOSER_MIN_PX, composerHeight } from './composerHeight';

const free = Infinity;

describe('composerHeight', () => {
  describe('with a dragged (resting) height', () => {
    it('stays at the resting height while the content fits', () => {
      expect(composerHeight({ content: 40, resting: 100, available: free })).toBe(100);
    });

    it('never shrinks below the resting height, even when empty', () => {
      expect(composerHeight({ content: 0, resting: 100, available: free })).toBe(100);
    });

    it('grows with the content', () => {
      expect(composerHeight({ content: 130, resting: 100, available: free })).toBe(130);
    });

    it('stops at 150% of the resting height, then the content scrolls', () => {
      expect(composerHeight({ content: 150, resting: 100, available: free })).toBe(150);
      expect(composerHeight({ content: 900, resting: 100, available: free })).toBe(150);
    });

    it('rounds an odd ceiling down to a whole pixel', () => {
      expect(composerHeight({ content: 900, resting: 81, available: free })).toBe(121);
    });

    it('does not take more than the room there is', () => {
      expect(composerHeight({ content: 900, resting: 200, available: 260 })).toBe(260);
      // Even the resting height gives way when the window has shrunk under it.
      expect(composerHeight({ content: 0, resting: 400, available: 300 })).toBe(300);
    });

    it('keeps one line when there is no room at all', () => {
      expect(composerHeight({ content: 900, resting: 200, available: -50 })).toBe(COMPOSER_MIN_PX);
    });
  });

  describe('with no dragged height', () => {
    it('follows the content, the CSS min-height being its floor', () => {
      expect(composerHeight({ content: 66, resting: null, available: free })).toBe(66);
    });

    it('keeps the auto-grow ceiling, not 150% of one line', () => {
      expect(composerHeight({ content: 900, resting: null, available: free })).toBe(COMPOSER_MAX_PX);
    });

    it('does not take more than the room there is', () => {
      expect(composerHeight({ content: 900, resting: null, available: 90 })).toBe(90);
    });
  });
});
