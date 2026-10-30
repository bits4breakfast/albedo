import { describe, expect, it } from 'vitest';
import { comboOf, createDoubleShift, DOUBLE_SHIFT_MS, SHORTCUTS, terminalTakesKey } from './shortcuts';

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

  it('jumps projects with ⌥digit (and ⌥⌘digit) on macOS, read from the physical key', () => {
    // Option rewrites `key` (⌥1 is ¡), so the code is what counts.
    const hit = { combo: 'mod+alt+digit', digit: 1 };
    expect(comboOf(ev({ key: '¡', code: 'Digit1', altKey: true }), 'macos')).toEqual(hit);
    expect(comboOf(ev({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), 'macos')).toEqual(hit);
    // Shift and Control stay out: ⇧⌥digit and ⌃⌥digit are left alone.
    expect(comboOf(ev({ key: '⁄', code: 'Digit1', altKey: true, shiftKey: true }), 'macos')).toBeNull();
    expect(comboOf(ev({ key: '1', code: 'Digit1', altKey: true, ctrlKey: true }), 'macos')).toBeNull();
    expect(comboOf(ev({ key: '0', code: 'Digit0', metaKey: true, altKey: true }), 'macos')).toBeNull();
  });

  it('jumps projects with Alt+digit off a Mac, never Ctrl+Alt (that is AltGr)', () => {
    expect(comboOf(ev({ key: '3', code: 'Digit3', altKey: true }), 'linux')).toEqual({
      combo: 'mod+alt+digit',
      digit: 3,
    });
    expect(comboOf(ev({ key: '{', code: 'Digit7', altKey: true, ctrlKey: true }), 'other')).toBeNull();
    // ⌘digit stays the task jump everywhere.
    expect(comboOf(ev({ key: '2', code: 'Digit2', metaKey: true }), 'macos')?.combo).toBe('mod+digit');
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
      comboOf(ev({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }))?.combo,
      comboOf(ev({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }))?.combo,
      comboOf(ev({ key: 'R', code: 'KeyR', metaKey: true, shiftKey: true }))?.combo,
      comboOf(ev({ key: 'u', code: 'KeyU', metaKey: true }))?.combo,
      comboOf(ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }))?.combo,
      comboOf(ev({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }))?.combo,
      comboOf(ev({ key: 'F12', code: 'F12', altKey: true }))?.combo,
      comboOf(ev({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), 'macos')?.combo,
    ]);
    // The one gesture is reachable through its own detector.
    const shift = createDoubleShift();
    shift(sh(0));
    if (shift(sh(100))) reachable.add('shift shift');
    // `editor …` entries are bound in CodeMirror's keymap (FileEditor.tsx),
    // `transcript …` ones in the transcript pane, `new-task …` in its
    // dialog and `focus …` in focusAreas.ts, none of which this matcher sees.
    for (const s of SHORTCUTS) {
      if (['editor ', 'transcript ', 'new-task ', 'focus '].some((p) => s.combo.startsWith(p))) continue;
      expect(reachable).toContain(s.combo);
    }
  });
});

describe('⌥⌘B, the editor’s Go to Implementation', () => {
  it('is documented, and no app-wide combo takes it first', () => {
    expect(SHORTCUTS.find((s) => s.combo === 'editor mod+alt+b')?.keys).toBe('⌥⌘B');
    expect(comboOf(ev({ key: '∫', code: 'KeyB', metaKey: true, altKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe('shell drawer key', () => {
  it('is Option-F12 alone, read from code', () => {
    expect(comboOf(ev({ key: 'F12', code: 'F12', altKey: true }))?.combo).toBe('alt+f12');
    expect(comboOf(ev({ key: 'F12', code: 'F12' }))).toBeNull();
    expect(comboOf(ev({ key: 'F12', code: 'F12', altKey: true, metaKey: true }))).toBeNull();
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

describe('find in files', () => {
  it('maps ⇧⌘F by physical key', () => {
    expect(comboOf(ev({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+f');
  });

  it('refuses Control, Alt, and ⌘F without Shift', () => {
    expect(comboOf(ev({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'F', code: 'KeyF', metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'Ï', code: 'KeyF', metaKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'f', code: 'KeyF', metaKey: true }))).toBeNull();
  });
});

describe('push', () => {
  it('maps ⇧⌘P by physical key', () => {
    expect(comboOf(ev({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+p');
  });

  it('leaves Ctrl+P to the terminal, and ⌘P unbound', () => {
    expect(comboOf(ev({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'p', code: 'KeyP', ctrlKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'p', code: 'KeyP', metaKey: true }))).toBeNull();
  });
});

describe('remote control', () => {
  it('maps ⇧⌘R by physical key', () => {
    expect(comboOf(ev({ key: 'R', code: 'KeyR', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+r');
    // A layout where R is somewhere else still types `code` KeyR on that key.
    expect(comboOf(ev({ key: 'P', code: 'KeyR', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+r');
  });

  it('leaves Ctrl+R / Ctrl+Shift+R to the terminal, and ⌘R and ⌥⇧⌘R unbound', () => {
    expect(comboOf(ev({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'r', code: 'KeyR', ctrlKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'r', code: 'KeyR', metaKey: true }))).toBeNull();
    expect(comboOf(ev({ key: '‰', code: 'KeyR', metaKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it('is kept from the terminal, which opens a dialog over it', () => {
    expect(terminalTakesKey(ev({ key: 'R', code: 'KeyR', metaKey: true, shiftKey: true }))).toBe(false);
    expect(terminalTakesKey(ev({ key: 'r', code: 'KeyR', ctrlKey: true }))).toBe(true);
  });

  it('is in the shortcuts help', () => {
    expect(SHORTCUTS.find((s) => s.combo === 'mod+shift+r')?.keys).toBe('⇧⌘R');
  });
});

describe('project step', () => {
  it('reads ⇧⌘[ / ⇧⌘] from the physical key', () => {
    // US: Shift turns the brackets into braces.
    expect(comboOf(ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+[');
    expect(comboOf(ev({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+]');
    // Italian: the same physical keys are è / + , shifted é / *.
    expect(comboOf(ev({ key: 'é', code: 'BracketLeft', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+[');
    expect(comboOf(ev({ key: '*', code: 'BracketRight', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+]');
  });

  it('is Command only, without Alt', () => {
    // Ctrl+[ is Escape in a terminal.
    expect(comboOf(ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: '”', code: 'BracketLeft', metaKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it('leaves ⌘[ / ⌘] to the task step', () => {
    expect(comboOf(ev({ key: '[', code: 'BracketLeft', metaKey: true }))?.combo).toBe('mod+[');
    expect(comboOf(ev({ key: ']', code: 'BracketRight', metaKey: true }))?.combo).toBe('mod+]');
    // ⇧⌘ on the bracket keys is the project step, whatever `key` says.
    expect(comboOf(ev({ key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true }))?.combo).toBe('mod+shift+[');
  });

  it('still steps tasks on a layout that types the bracket with Shift', () => {
    // The `[` is on another physical key there, so the code check passes it by.
    expect(comboOf(ev({ key: '[', code: 'Digit8', metaKey: true, shiftKey: true }))?.combo).toBe('mod+[');
    expect(comboOf(ev({ key: ']', code: 'Digit9', metaKey: true, shiftKey: true }))?.combo).toBe('mod+]');
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

describe('terminalTakesKey', () => {
  it('keeps the project jump from the terminal, and leaves everything else to it', () => {
    expect(terminalTakesKey(ev({ key: '¡', code: 'Digit1', altKey: true }))).toBe(false);
    expect(terminalTakesKey(ev({ key: 'b', code: 'KeyB', altKey: true }))).toBe(true);
    expect(terminalTakesKey(ev({ key: '1', code: 'Digit1', metaKey: true }))).toBe(true);
  });

  it('keeps the project step from the terminal, and leaves it the task step', () => {
    expect(terminalTakesKey(ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }))).toBe(false);
    expect(terminalTakesKey(ev({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }))).toBe(false);
    expect(terminalTakesKey(ev({ key: '[', code: 'BracketLeft', metaKey: true }))).toBe(true);
    expect(terminalTakesKey(ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

describe('editor keys', () => {
  it('none of them is also an app combo, so one key never does two things', () => {
    // ⇧⌘D, ⇧⌘C, ⌥⇧⌘C (editorKeys.ts) and ⌥⌘M (the editor's CodeMirror keymap).
    expect(comboOf(ev({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'Ç', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true }))).toBeNull();
    expect(comboOf(ev({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }))).toBeNull();
  });

  it('lists each editor key once, and the old ⌥⌘C not at all', () => {
    const keys = SHORTCUTS.filter((s) => s.combo.startsWith('editor ')).map((s) => s.keys);
    expect(keys).toEqual(expect.arrayContaining(['⇧⌘D', '⇧⌘C', '⌥⇧⌘C', '⌥⌘M']));
    expect(new Set(keys).size).toBe(keys.length);
    expect(SHORTCUTS.some((s) => s.keys === '⌥⌘C')).toBe(false);
  });
});
