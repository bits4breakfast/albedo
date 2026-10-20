import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetHandEdited,
  clearHandEdited,
  handEditedFiles,
  isHandEdited,
  markHandEdited,
  onHandEditedChange,
} from './handEdited';

beforeEach(() => {
  __resetHandEdited();
});

describe('markHandEdited / isHandEdited', () => {
  it('records a file for a task', () => {
    expect(isHandEdited(1, 'src/Foo.php')).toBe(false);
    markHandEdited(1, 'src/Foo.php');
    expect(isHandEdited(1, 'src/Foo.php')).toBe(true);
  });

  it('is scoped per task', () => {
    markHandEdited(1, 'src/Foo.php');
    expect(isHandEdited(2, 'src/Foo.php')).toBe(false);
  });

  it('is scoped per path', () => {
    markHandEdited(1, 'src/Foo.php');
    expect(isHandEdited(1, 'src/Bar.php')).toBe(false);
  });

  it('treats the relative path as an exact key', () => {
    // Callers must feed it `resolveInWorktree().relative`; `./src/a.ts` is a
    // different string and deliberately does not match.
    markHandEdited(1, 'src/a.ts');
    expect(isHandEdited(1, './src/a.ts')).toBe(false);
    expect(isHandEdited(1, '/abs/src/a.ts')).toBe(false);
  });

  it('is idempotent', () => {
    markHandEdited(1, 'src/Foo.php');
    markHandEdited(1, 'src/Foo.php');
    expect(handEditedFiles(1)).toEqual(['src/Foo.php']);
  });

  it('ignores junk input rather than poisoning the set', () => {
    markHandEdited(1, '');
    markHandEdited(Number.NaN, 'src/Foo.php');
    markHandEdited(1.5, 'src/Foo.php');
    expect(handEditedFiles(1)).toEqual([]);
  });

  it('returns false for a task it has never seen', () => {
    expect(isHandEdited(99, 'anything')).toBe(false);
    expect(handEditedFiles(99)).toEqual([]);
  });
});

describe('onHandEditedChange', () => {
  it('fires when a new file is marked', () => {
    const cb = vi.fn();
    onHandEditedChange(cb);
    markHandEdited(1, 'src/Foo.php');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not fire when nothing changed', () => {
    markHandEdited(1, 'src/Foo.php');
    const cb = vi.fn();
    onHandEditedChange(cb);
    markHandEdited(1, 'src/Foo.php');
    expect(cb).not.toHaveBeenCalled();
  });

  it('notifies every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    onHandEditedChange(a);
    onHandEditedChange(b);
    markHandEdited(1, 'src/Foo.php');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const cb = vi.fn();
    const off = onHandEditedChange(cb);
    off();
    markHandEdited(1, 'src/Foo.php');
    expect(cb).not.toHaveBeenCalled();
  });

  it('survives a subscriber that unsubscribes itself mid-notification', () => {
    const other = vi.fn();
    const off = onHandEditedChange(() => off());
    onHandEditedChange(other);
    expect(() => markHandEdited(1, 'src/Foo.php')).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('survives a subscriber that throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    onHandEditedChange(() => {
      throw new Error('boom');
    });
    onHandEditedChange(good);

    // A broken touched-files view must not fail the save that triggered it.
    expect(() => markHandEdited(1, 'src/Foo.php')).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('unsubscribing twice is harmless', () => {
    const cb = vi.fn();
    const off = onHandEditedChange(cb);
    off();
    off();
    markHandEdited(1, 'src/Foo.php');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('clearHandEdited', () => {
  it('drops a task and notifies', () => {
    markHandEdited(1, 'src/Foo.php');
    markHandEdited(2, 'src/Bar.php');
    const cb = vi.fn();
    onHandEditedChange(cb);

    clearHandEdited(1);
    expect(isHandEdited(1, 'src/Foo.php')).toBe(false);
    expect(isHandEdited(2, 'src/Bar.php')).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('is silent for a task that had nothing', () => {
    const cb = vi.fn();
    onHandEditedChange(cb);
    clearHandEdited(42);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('session scope', () => {
  it('starts empty, which is what "cleared on restart" means', () => {
    // Nothing is persisted, so a fresh module state is a fresh session. This
    // test is the guard against someone adding localStorage later.
    markHandEdited(1, 'src/Foo.php');
    __resetHandEdited();
    expect(isHandEdited(1, 'src/Foo.php')).toBe(false);
    expect(handEditedFiles(1)).toEqual([]);
  });
});
