import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_MAX_CHARS,
  expandPastes,
  intactTokens,
  lineBreaks,
  lineCount,
  pastesIn,
  placeholderFor,
  replaceRanges,
  shouldCollapse,
  tokenRanges,
} from './pastedText';

describe('pasted text placeholders', () => {
  it("collapses at Claude Code's threshold: over 800 characters, or over two line breaks", () => {
    expect(shouldCollapse('one line')).toBe(false);
    expect(shouldCollapse('a\nb')).toBe(false);
    expect(shouldCollapse('a\nb\nc')).toBe(false); // two breaks: Claude Code keeps it inline too
    expect(shouldCollapse('a\nb\nc\nd')).toBe(true);
    expect(shouldCollapse('a\nb\nc\n')).toBe(true); // a trailing break counts, as in Claude Code
    expect(shouldCollapse('a\r\nb\r\nc\r\nd')).toBe(true);
    expect(shouldCollapse('x'.repeat(COLLAPSE_MAX_CHARS))).toBe(false);
    expect(shouldCollapse('x'.repeat(COLLAPSE_MAX_CHARS + 1))).toBe(true);
  });

  it('counts breaks the way Claude Code does: \\r\\n, \\r and \\n are one each', () => {
    expect(lineBreaks('a\r\nb\rc\nd')).toBe(3);
    expect(lineBreaks('flat')).toBe(0);
  });

  it('counts lines the way the placeholder reports them', () => {
    expect(lineCount('a\nb\nc\n')).toBe(3);
    expect(lineCount('a\r\nb')).toBe(2);
    expect(placeholderFor(2, 'a\nb\nc')).toBe('[Pasted text #2 +3 lines]');
    expect(placeholderFor(1, 'x'.repeat(900))).toBe('[Pasted text #1 +1 line]');
  });

  it('expands intact placeholders and leaves everything else alone', () => {
    const store = new Map([
      [1, 'line1\nline2\nline3'],
      [2, 'other'],
    ]);
    const draft = 'look: [Pasted text #1 +3 lines] and [Pasted text #9 +2 lines] and [Pasted text #2 +1 line]';
    expect(expandPastes(draft, store)).toBe('look: line1\nline2\nline3 and [Pasted text #9 +2 lines] and other');
    // An edited token is no longer a placeholder.
    expect(expandPastes('[Pasted text #1 +3 lin]', store)).toBe('[Pasted text #1 +3 lin]');
    expect(expandPastes('plain', new Map())).toBe('plain');
  });

  it('does not expand a token whose line count was edited: its paste is not sent', () => {
    const store = new Map([[1, 'a\nb\nc\nd']]);
    expect(expandPastes('[Pasted text #1 +5 lines]', store)).toBe('[Pasted text #1 +5 lines]');
    expect(expandPastes('[Pasted text #1 +4 lines]', store)).toBe('a\nb\nc\nd');
  });

  it('does not treat $-patterns in the pasted text specially', () => {
    expect(expandPastes('[Pasted text #1 +1 line]', new Map([[1, "cost: $1 and $& and $'"]]))).toBe(
      "cost: $1 and $& and $'",
    );
  });

  it('expands a token moved whole, and one that appears twice', () => {
    const store = new Map([[3, 'x\ny\nz\nw']]);
    const t = placeholderFor(3, 'x\ny\nz\nw');
    expect(expandPastes(`${t} then ${t}`, store)).toBe('x\ny\nz\nw then x\ny\nz\nw');
  });
});

describe('the pastes a draft uses', () => {
  const store = new Map([
    [1, 'a\nb\nc\nd'],
    [2, 'p\nq\nr\ns\nt'],
    [3, 'gone\nfrom\nthe\ndraft'],
  ]);
  const draft = `see ${placeholderFor(2, 'p\nq\nr\ns\nt')} and ${placeholderFor(1, 'a\nb\nc\nd')} and ${placeholderFor(2, 'p\nq\nr\ns\nt')}`;

  it('lists intact tokens in order, with where they sit', () => {
    const tokens = intactTokens(draft, store);
    expect(tokens.map((t) => t.id)).toEqual([2, 1, 2]);
    for (const t of tokens) expect(draft.slice(t.start, t.end)).toBe(placeholderFor(t.id, store.get(t.id) ?? ''));
  });

  it('keeps only pastes with an intact token, each once, in order of first appearance', () => {
    expect([...pastesIn(draft, store).keys()]).toEqual([2, 1]);
    expect(pastesIn('nothing here', store).size).toBe(0);
  });

  it('replaces one paste\'s tokens, leaving the others', () => {
    const ranges = tokenRanges(draft, store, 2);
    expect(ranges).toHaveLength(2);
    expect(replaceRanges(draft, ranges, '')).toBe(`see  and ${placeholderFor(1, 'a\nb\nc\nd')} and `);
    expect(replaceRanges(draft, tokenRanges(draft, store, 1), 'a\nb\nc\nd')).toBe(
      `see ${placeholderFor(2, 'p\nq\nr\ns\nt')} and a\nb\nc\nd and ${placeholderFor(2, 'p\nq\nr\ns\nt')}`,
    );
    expect(tokenRanges(draft, store, 3)).toEqual([]);
  });
});
