import { describe, expect, it } from 'vitest';
import { neighbour, setTouchedOrder, touchedOrder } from './touchedOrder';

describe('touched-file stepping', () => {
  it('steps forward and back, wrapping at the ends', () => {
    const order = ['a', 'b', 'c'];
    expect(neighbour(order, 'a', 1)).toBe('b');
    expect(neighbour(order, 'c', 1)).toBe('a');
    expect(neighbour(order, 'a', -1)).toBe('c');
  });
  it('has nowhere to go for a file not in the list, or a list of one', () => {
    expect(neighbour(['a', 'b'], 'z', 1)).toBeNull();
    expect(neighbour(['a'], 'a', 1)).toBeNull();
  });
  it('remembers the order per task', () => {
    setTouchedOrder(1, ['x', 'y']);
    setTouchedOrder(2, ['q']);
    expect(touchedOrder(1)).toEqual(['x', 'y']);
    expect(touchedOrder(3)).toEqual([]);
  });
});
