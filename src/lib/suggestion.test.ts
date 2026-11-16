import { describe, expect, it } from 'vitest';
import { commentHeadline, fenceFor, indentOf, joinSuggestion, linesOf, replacesLabel, splitSuggestion } from './suggestion';

describe('a suggestion in a comment body (#411)', () => {
  it('is stored as GitHub writes one, before the text', () => {
    expect(joinSuggestion(['  return total;'], ' Simpler. ')).toBe('```suggestion\n  return total;\n```\nSimpler.');
    expect(joinSuggestion(null, ' Just words. ')).toBe('Just words.');
  });

  it('reads back what was stored: lines, indentation, blank lines and the text', () => {
    for (const lines of [['a'], ['  a', '', '\tb  '], [''], []]) {
      for (const text of ['', 'Why not this?', 'Two\nlines.']) {
        expect(splitSuggestion(joinSuggestion(lines, text))).toEqual({ suggestion: lines, text });
      }
    }
  });

  it('an empty block is a deletion; a block of one empty line is not', () => {
    expect(splitSuggestion('```suggestion\n```').suggestion).toEqual([]);
    expect(splitSuggestion('```suggestion\n\n```').suggestion).toEqual(['']);
  });

  it('fences past any backticks in the code, so code holding ``` cannot close it', () => {
    const lines = ['x = "```"', '```'];
    const body = joinSuggestion(lines, 'Keep the fence.');
    expect(body.startsWith('````suggestion\n')).toBe(true);
    expect(splitSuggestion(body)).toEqual({ suggestion: lines, text: 'Keep the fence.' });
    expect(fenceFor([])).toBe('```');
  });

  it('a body without one, or with one not at its start or never closed, is all text', () => {
    expect(splitSuggestion('Plain.')).toEqual({ suggestion: null, text: 'Plain.' });
    expect(splitSuggestion('See:\n```suggestion\nx\n```')).toEqual({ suggestion: null, text: 'See:\n```suggestion\nx\n```' });
    expect(splitSuggestion('```suggestion\nx')).toEqual({ suggestion: null, text: '```suggestion\nx' });
    expect(splitSuggestion('```ts\nx\n```').suggestion).toBeNull();
  });

  it('a box left empty is no lines', () => {
    expect(linesOf('')).toEqual([]);
    expect(linesOf('a\n')).toEqual(['a', '']);
  });

  it('says what it replaces', () => {
    expect(replacesLabel(3, 1)).toBe('replaces 3 lines with 1');
    expect(replacesLabel(1, 4)).toBe('replaces 1 line with 4');
    expect(replacesLabel(3, 0)).toBe('replaces 3 lines with nothing');
  });

  it('a one-line headline: the text, or what it is when it has none', () => {
    expect(commentHeadline(joinSuggestion(['x'], 'First.\nSecond.'))).toBe('First.');
    expect(commentHeadline(joinSuggestion(['x'], ''))).toBe('Suggested change');
    expect(commentHeadline('Plain.\nMore.')).toBe('Plain.');
  });

  it('Tab indents as the lines do', () => {
    expect(indentOf(['\tif (x) {', '\t\treturn;'])).toBe('\t');
    expect(indentOf(['  a', '    b'])).toBe('  ');
    expect(indentOf(['    a', '        b'])).toBe('    ');
    expect(indentOf(['a', ''])).toBe('    ');
  });
});
