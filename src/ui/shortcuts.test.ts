import { describe, expect, it } from 'vitest';
import { comboOf, SHORTCUTS } from './shortcuts';

const ev = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ altKey: false, metaKey: false, ctrlKey: false, ...init }) as KeyboardEvent;

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
    const reachable = new Set(
      ['n', '\\', '/', '[', ']', 'ArrowLeft', 'ArrowRight', '1', '=', '-', '0'].map(
        (key) => comboOf(ev({ key, metaKey: true }))?.combo,
      ),
    );
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
