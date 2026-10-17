import { describe, expect, it } from 'vitest';
import { comboOf, createDoubleShift, DOUBLE_SHIFT_MS, SHORTCUTS } from './shortcuts';

const ev = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, code: '', ...init }) as KeyboardEvent;

/** A bare Shift keydown at time `t`. */
const sh = (t: number, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: 'Shift', repeat: false, timeStamp: t, metaKey: false, ctrlKey: false, altKey: false, ...extra }) as KeyboardEvent;
const key = (k: string, t: number) =>
  ({ key: k, repeat: false, timeStamp: t, metaKey: false, ctrlKey: false, altKey: false }) as KeyboardEvent;

describe('comboOf', () => {
  it('accepts either modifier, so the map works off a Mac too', () => {
    expect(comboOf(ev({ key: 'n', metaKey: true }))?.combo).toBe('mod+n');
    expect(comboOf(ev({ key: 'n', ctrlKey: true }))?.combo).toBe('mod+n');
  });

  it('ignores a bare key', () => {
    expect(comboOf(ev({ key: 'n' }))).toBeNull();
    expect(comboOf(ev({ key: 'ArrowLeft' }))).toBeNull();
  });

  it('ignores anything with Alt held', () => {
    // On macOS Alt composes characters: ⌥[ is a real keystroke that has to
    // reach the terminal rather than being eaten as a task jump.
    expect(comboOf(ev({ key: '[', metaKey: true, altKey: true }))).toBeNull();
  });

  it('reads the digit out of a number jump', () => {
    expect(comboOf(ev({ key: '3', metaKey: true }))).toEqual({ combo: 'mod+digit', digit: 3 });
    expect(comboOf(ev({ key: '9', metaKey: true }))).toEqual({ combo: 'mod+digit', digit: 9 });
    // 0 is not a jump (there is no zeroth task); it is "actual size".
    expect(comboOf(ev({ key: '0', metaKey: true }))).toEqual({ combo: 'mod+0', digit: null });
  });

  it('matches the bracket and arrow bindings', () => {
    expect(comboOf(ev({ key: '[', metaKey: true }))?.combo).toBe('mod+[');
    expect(comboOf(ev({ key: ']', metaKey: true }))?.combo).toBe('mod+]');
    expect(comboOf(ev({ key: 'ArrowLeft', metaKey: true }))?.combo).toBe('mod+arrowleft');
    expect(comboOf(ev({ key: 'ArrowRight', metaKey: true }))?.combo).toBe('mod+arrowright');
    expect(comboOf(ev({ key: '\\', metaKey: true }))?.combo).toBe('mod+\\');
    expect(comboOf(ev({ key: '/', metaKey: true }))?.combo).toBe('mod+/');
  });

  it('is case-insensitive, so Shift does not silently disable a binding', () => {
    expect(comboOf(ev({ key: 'N', metaKey: true }))?.combo).toBe('mod+n');
  });

  it('returns null for keys nothing binds', () => {
    expect(comboOf(ev({ key: 'q', metaKey: true }))).toBeNull();
  });
});

describe('SHORTCUTS', () => {
  it('documents every combo exactly once', () => {
    const combos = SHORTCUTS.map((s) => s.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('lists a combo the matcher can actually produce', () => {
    // Guards the drift this table exists to prevent: a documented shortcut
    // that no keystroke reaches.
    const reachable = new Set<string | undefined>([
      ...['n', '\\', '/', '[', ']', 'ArrowLeft', 'ArrowRight', '1', '=', '-', '0'].map(
        (key) => comboOf(ev({ key, metaKey: true }))?.combo,
      ),
      comboOf(ev({ key: 'o', code: 'KeyO', metaKey: true }))?.combo,
      comboOf(ev({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))?.combo,
      comboOf(ev({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true }))?.combo,
    ]);
    // The one gesture is reachable through its own detector.
    const shift = createDoubleShift();
    shift(sh(0));
    if (shift(sh(100))) reachable.add('shift shift');
    for (const s of SHORTCUTS) expect(reachable).toContain(s.combo);
  });
});

describe('text size keys', () => {
  it('maps Cmd = / + to bigger, Cmd - to smaller, Cmd 0 to actual size', () => {
    expect(comboOf(ev({ key: '=', metaKey: true }))?.combo).toBe('mod+=');
    expect(comboOf(ev({ key: '+', metaKey: true }))?.combo).toBe('mod+=');
    expect(comboOf(ev({ key: '-', metaKey: true }))?.combo).toBe('mod+-');
    expect(comboOf(ev({ key: '0', metaKey: true }))?.combo).toBe('mod+0');
    expect(comboOf(ev({ key: '=' }))).toBeNull();
  });
});

describe('go-to keys', () => {
  it('maps ⌘O, ⇧⌘O and ⌥⌘O by physical key', () => {
    expect(comboOf(ev({ key: 'o', code: 'KeyO', metaKey: true }))?.combo).toBe('mod+o');
    expect(comboOf(ev({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+o');
    // Option rewrites `key` on macOS; `code` is what still says O.
    expect(comboOf(ev({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true }))?.combo).toBe('mod+alt+o');
  });

  it('refuses Control, which the terminal needs for Ctrl+O', () => {
    expect(comboOf(ev({ key: 'o', code: 'KeyO', ctrlKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'o', code: 'KeyO', ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('ignores ⌥⇧⌘O and a bare O', () => {
    expect(comboOf(ev({ key: 'Ø', code: 'KeyO', metaKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'o', code: 'KeyO' }))).toBeNull();
  });

  it('leaves every other Alt combo refused', () => {
    expect(comboOf(ev({ key: '[', code: 'BracketLeft', metaKey: true, altKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'n', code: 'KeyN', metaKey: true, altKey: true }))).toBeNull();
  });
});

describe('createDoubleShift', () => {
  it('fires on two bare Shift presses inside the window', () => {
    const d = createDoubleShift();
    expect(d(sh(0))).toBe(false);
    expect(d(sh(DOUBLE_SHIFT_MS - 1))).toBe(true);
  });

  it('does not fire when the presses are too far apart', () => {
    const d = createDoubleShift();
    d(sh(0));
    expect(d(sh(DOUBLE_SHIFT_MS + 1))).toBe(false);
    // ...but that second press starts a new pair.
    expect(d(sh(DOUBLE_SHIFT_MS + 100))).toBe(true);
  });

  it('any other key in between resets it -- typing capitals is not a gesture', () => {
    const d = createDoubleShift();
    d(sh(0));
    d(key('H', 40));
    expect(d(sh(120))).toBe(false);
  });

  it('ignores auto-repeat from a held Shift', () => {
    const d = createDoubleShift();
    d(sh(0));
    expect(d(sh(30, { repeat: true }))).toBe(false);
    expect(d(sh(60, { repeat: true }))).toBe(false);
  });

  it('Shift with another modifier is a chord, not half a gesture', () => {
    const d = createDoubleShift();
    d(sh(0));
    expect(d(sh(50, { metaKey: true }))).toBe(false);
    expect(d(sh(100))).toBe(false);
  });

  it('resets after firing, so a triple press fires once', () => {
    const d = createDoubleShift();
    d(sh(0));
    expect(d(sh(100))).toBe(true);
    expect(d(sh(200))).toBe(false);
  });
});
