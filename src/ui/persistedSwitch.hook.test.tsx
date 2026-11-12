/**
 * @vitest-environment jsdom
 *
 * `usePersistedSwitch` (#367): the component showing a switch re-renders when
 * it is set from anywhere, and reads the held value on every render.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistedSwitch, usePersistedSwitch } from './persisted';

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
});
afterEach(() => cleanup());

describe('usePersistedSwitch', () => {
  it('re-renders on a set from the hook or from outside it', () => {
    const sw = persistedSwitch('k');
    const { result } = renderHook(() => usePersistedSwitch(sw));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(data.get('k')).toBe('off');
    act(() => sw.set(true));
    expect(result.current[0]).toBe(true);
    expect(data.has('k')).toBe(false);
  });

  it('hands back the switch’s own setter, the same on every render', () => {
    const sw = persistedSwitch('k');
    const { result, rerender } = renderHook(() => usePersistedSwitch(sw));
    const first = result.current[1];
    rerender();
    expect(result.current[1]).toBe(first);
    expect(first).toBe(sw.set);
  });
});
