import { describe, expect, it } from 'vitest';
import { adjacent } from './filesListOpen';

describe('adjacent', () => {
  const rows = ['a', 'b', 'c'];
  it('is the row before or after', () => {
    expect(adjacent(rows, 'b', 1)).toBe('c');
    expect(adjacent(rows, 'b', -1)).toBe('a');
  });
  it('stops at either end, and knows nothing of a row not in the list', () => {
    expect(adjacent(rows, 'a', -1)).toBeNull();
    expect(adjacent(rows, 'c', 1)).toBeNull();
    expect(adjacent(rows, 'x', 1)).toBeNull();
  });
});
