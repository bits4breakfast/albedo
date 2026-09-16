import { describe, expect, it } from 'vitest';
import { anchorBlock, fileLines } from './anchor';

const F = ['a', 'b', 'c', 'd', 'e'];

describe('fileLines', () => {
  it('drops the empty element a trailing newline produces', () => {
    // Otherwise every file ending in \n reports one more line than it has, and
    // line numbers stop matching git and every editor.
    expect(fileLines('a\nb\n')).toEqual(['a', 'b']);
    expect(fileLines('a\nb')).toEqual(['a', 'b']);
  });

  it('keeps a genuinely blank final line', () => {
    expect(fileLines('a\n\n')).toEqual(['a', '']);
  });

  it('treats the empty file as one empty line, not zero', () => {
    expect(fileLines('')).toEqual(['']);
  });
});

describe('anchorBlock', () => {
  it('finds a unique block', () => {
    expect(anchorBlock(F, ['c', 'd'])).toEqual({ ok: true, offset: 2 });
    expect(anchorBlock(F, ['a'])).toEqual({ ok: true, offset: 0 });
  });

  it('reports a block the file no longer contains', () => {
    // The file changed after this diff was written. Saying so is the point:
    // the alternative is splicing current lines around a historical hunk.
    expect(anchorBlock(F, ['c', 'X'])).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses to guess between identical candidates', () => {
    const file = ['x', 'dup', 'y', 'dup', 'z'];
    expect(anchorBlock(file, ['dup'])).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('uses a hint to break a tie, but only to choose among real matches', () => {
    const file = ['x', 'dup', 'y', 'dup', 'z'];
    expect(anchorBlock(file, ['dup'], 4)).toEqual({ ok: true, offset: 3 });
    expect(anchorBlock(file, ['dup'], 2)).toEqual({ ok: true, offset: 1 });
    // A hint never rescues a block that is not there at all.
    expect(anchorBlock(file, ['nope'], 2)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('stays ambiguous when the hint is exactly between two candidates', () => {
    const file = ['dup', 'x', 'dup'];
    expect(anchorBlock(file, ['dup'], 2)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('compares exactly, so a reformatted file reads as changed', () => {
    // A trimmed comparison would "succeed" here and then report offsets into a
    // file whose indentation no longer matches what the diff showed.
    expect(anchorBlock(['  a', '  b'], ['a', 'b'])).toEqual({ ok: false, reason: 'not-found' });
  });

  it('handles the degenerate inputs', () => {
    expect(anchorBlock(F, [])).toEqual({ ok: false, reason: 'empty' });
    expect(anchorBlock([], ['a'])).toEqual({ ok: false, reason: 'empty' });
    expect(anchorBlock(['a'], ['a', 'b'])).toEqual({ ok: false, reason: 'not-found' });
  });
});
