import { describe, expect, it } from 'vitest';
import { wedge } from './GroupPie';

describe('the group pie’s wedge (#278)', () => {
  it('starts at twelve o’clock and turns clockwise', () => {
    expect(wedge(0.25)).toBe('M6 6L6 3A3 3 0 0 1 9 6Z');
    expect(wedge(0.5)).toBe('M6 6L6 3A3 3 0 0 1 6 9Z');
  });

  it('takes the long way round past a half: Awaiting ⅝, In Review ¾, Approved ⅞', () => {
    expect(wedge(0.625)).toMatch(/A3 3 0 1 1 /);
    expect(wedge(0.75)).toBe('M6 6L6 3A3 3 0 1 1 3 6Z');
    expect(wedge(0.875)).toMatch(/A3 3 0 1 1 3\.879 3\.879Z$/);
  });

  it('a whole one is a full disc', () => {
    expect(wedge(1)).toBe('M6 3a3 3 0 1 1 0 6a3 3 0 1 1 0-6Z');
  });
});
