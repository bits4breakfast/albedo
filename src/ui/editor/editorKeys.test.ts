import { describe, expect, it } from 'vitest';
import { editorKeyOf } from './editorKeys';

const ev = (init: Partial<KeyboardEvent> & { code: string }) =>
  ({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe('editorKeyOf', () => {
  it('⇧⌘D toggles File / Diff', () => {
    expect(editorKeyOf(ev({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true }))).toBe('toggle-diff');
  });

  it('⇧⌘C copies the full path, ⌥⇧⌘C the worktree-relative one', () => {
    expect(editorKeyOf(ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }))).toBe('copy-full-path');
    // Option rewrites `key` (⌥⇧C is "Ç"); the physical key is what counts.
    expect(editorKeyOf(ev({ key: 'Ç', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true }))).toBe('copy-path');
  });

  it('reads the physical key, whatever the layout types there', () => {
    // A layout where that key types something else still copies.
    expect(editorKeyOf(ev({ key: 'J', code: 'KeyC', metaKey: true, shiftKey: true }))).toBe('copy-full-path');
    // And the letter C on another key does not.
    expect(editorKeyOf(ev({ key: 'C', code: 'KeyJ', metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('leaves ⌘C, ⌥⌘C and ⌘D alone', () => {
    // ⌘C is copy; the old ⌥⌘C Copy Path is gone, with no alias.
    expect(editorKeyOf(ev({ key: 'c', code: 'KeyC', metaKey: true }))).toBeNull();
    expect(editorKeyOf(ev({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true }))).toBeNull();
    // ⌘D is CodeMirror's select-next-occurrence.
    expect(editorKeyOf(ev({ key: 'd', code: 'KeyD', metaKey: true }))).toBeNull();
    expect(editorKeyOf(ev({ key: 'Î', code: 'KeyD', metaKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it('is Command only: Control belongs to the terminal', () => {
    expect(editorKeyOf(ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(editorKeyOf(ev({ key: 'C', code: 'KeyC', metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(editorKeyOf(ev({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('leaves ⌥⌘M, the comment key, to CodeMirror', () => {
    expect(editorKeyOf(ev({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }))).toBeNull();
  });
});
