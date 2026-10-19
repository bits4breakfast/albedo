import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissAfterFocusedTime } from './focusTimer';

function fakeWindow() {
  const handlers: Record<string, Array<() => void>> = { focus: [], blur: [] };
  return {
    win: {
      addEventListener: (t: string, h: () => void) => handlers[t]!.push(h),
      removeEventListener: (t: string, h: () => void) => {
        handlers[t] = handlers[t]!.filter((x) => x !== h);
      },
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    fire: (t: 'focus' | 'blur') => [...handlers[t]!].forEach((h) => h()),
    listeners: () => handlers.focus!.length + handlers.blur!.length,
  };
}

describe('dismissAfterFocusedTime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down while focused', () => {
    const w = fakeWindow();
    const done = vi.fn();
    dismissAfterFocusedTime(5000, done, w.win, () => true);
    vi.advanceTimersByTime(4999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
    expect(w.listeners()).toBe(0);
  });

  it('does not start until the window has focus', () => {
    const w = fakeWindow();
    const done = vi.fn();
    dismissAfterFocusedTime(5000, done, w.win, () => false);
    vi.advanceTimersByTime(60_000);
    expect(done).not.toHaveBeenCalled();
    w.fire('focus');
    vi.advanceTimersByTime(5000);
    expect(done).toHaveBeenCalledOnce();
  });

  it('pauses while the window is in the background and resumes on return', () => {
    const w = fakeWindow();
    const done = vi.fn();
    dismissAfterFocusedTime(5000, done, w.win, () => true);
    vi.advanceTimersByTime(3000);
    w.fire('blur');
    vi.advanceTimersByTime(60_000);
    expect(done).not.toHaveBeenCalled();
    w.fire('focus');
    vi.advanceTimersByTime(1999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it('cancels cleanly', () => {
    const w = fakeWindow();
    const done = vi.fn();
    const cancel = dismissAfterFocusedTime(5000, done, w.win, () => true);
    cancel();
    vi.advanceTimersByTime(10_000);
    w.fire('focus');
    vi.advanceTimersByTime(10_000);
    expect(done).not.toHaveBeenCalled();
    expect(w.listeners()).toBe(0);
  });
});
