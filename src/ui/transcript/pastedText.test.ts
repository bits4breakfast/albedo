import { describe, expect, it } from 'vitest';
import { expandPastes, lineCount, placeholderFor, shouldCollapse } from './pastedText';

describe('pasted text placeholders', () => {
  it('collapses multi-line or long pastes, keeps short ones inline', () => {
    expect(shouldCollapse('one line')).toBe(false);
    expect(shouldCollapse('a\nb')).toBe(false);
    expect(shouldCollapse('a\nb\nc')).toBe(true);
    expect(shouldCollapse('x'.repeat(601))).toBe(true);
  });

  it('counts lines the way the placeholder reports them', () => {
    expect(lineCount('a\nb\nc\n')).toBe(3);
    expect(lineCount('a\r\nb')).toBe(2);
    expect(placeholderFor(2, 'a\nb\nc')).toBe('[Pasted text #2 +3 lines]');
    expect(placeholderFor(1, 'x'.repeat(700))).toBe('[Pasted text #1 +1 line]');
  });

  it('expands intact placeholders and leaves everything else alone', () => {
    const store = new Map([
      [1, 'line1\nline2\nline3'],
      [2, 'other'],
    ]);
    const draft = 'look: [Pasted text #1 +3 lines] and [Pasted text #9 +2 lines] and [Pasted text #2 +1 line]';
    expect(expandPastes(draft, store)).toBe(
      'look: line1\nline2\nline3 and [Pasted text #9 +2 lines] and other',
    );
    // An edited token is no longer a placeholder.
    expect(expandPastes('[Pasted text #1 +3 lin]', store)).toBe('[Pasted text #1 +3 lin]');
    expect(expandPastes('plain', new Map())).toBe('plain');
  });

  it('does not treat $-patterns in the pasted text specially', () => {
    expect(expandPastes('[Pasted text #1 +1 line]', new Map([[1, "cost: $1 and $& and $'"]]))).toBe(
      "cost: $1 and $& and $'",
    );
  });
});
