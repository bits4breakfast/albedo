import { describe, expect, it } from 'vitest';
import { stepProjectTab } from './projectStep';

describe('stepProjectTab', () => {
  const keys = ['p1', 'p2', 'p3'];

  it('steps in bar order', () => {
    expect(stepProjectTab(keys, 'p1', 1)).toBe('p2');
    expect(stepProjectTab(keys, 'p3', -1)).toBe('p2');
  });

  it('stops at both ends, like the task step', () => {
    expect(stepProjectTab(keys, 'p3', 1)).toBeNull();
    expect(stepProjectTab(keys, 'p1', -1)).toBeNull();
  });

  it('does nothing with fewer than two tabs', () => {
    expect(stepProjectTab(['p1'], 'p1', 1)).toBeNull();
    expect(stepProjectTab([], null, -1)).toBeNull();
  });

  it('enters from the matching end when the active tab is not in the list', () => {
    expect(stepProjectTab(keys, null, 1)).toBe('p1');
    expect(stepProjectTab(keys, 'gone', -1)).toBe('p3');
  });
});
