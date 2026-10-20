import { describe, expect, it } from 'vitest';
import { parseBlocks, splitRow } from './MessageRow';

describe('splitRow', () => {
  it('splits on pipes, outer pipes optional', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitRow('a | b')).toEqual(['a', 'b']);
    expect(splitRow('| a | |')).toEqual(['a', '']);
  });

  it('keeps an escaped pipe and a pipe inside a code span', () => {
    expect(splitRow('| a \\| b | `x | y` | c |')).toEqual(['a | b', '`x | y`', 'c']);
  });
});

describe('parseBlocks: tables', () => {
  it('reads a table that follows a paragraph line directly, as GitHub does', () => {
    const src = [
      '**Results by week**',
      '| Fruit | Count | Share | Note |',
      '|---|---:|:---:|---|',
      '| Apples | 1,204 | 12.5% | fresh |',
      '| Pears (10:00–11:30) | 7 | 0% |',
      '',
      'After.',
    ].join('\n');
    expect(parseBlocks(src)).toEqual([
      { t: 'p', text: '**Results by week**' },
      {
        t: 'table',
        align: [null, 'right', 'center', null],
        head: ['Fruit', 'Count', 'Share', 'Note'],
        rows: [
          ['Apples', '1,204', '12.5%', 'fresh'],
          // A short row is padded to the header's width.
          ['Pears (10:00–11:30)', '7', '0%', ''],
        ],
      },
      { t: 'p', text: 'After.' },
    ]);
  });

  it('is not a table when the delimiter row does not match the header', () => {
    const blocks = parseBlocks('| a | b |\n|---|\n| 1 | 2 |');
    expect(blocks.some((b) => b.t === 'table')).toBe(false);
  });

  it('leaves a lone `---` a rule and a pipe in prose a paragraph', () => {
    expect(parseBlocks('a | b\n\n---')).toEqual([{ t: 'p', text: 'a | b' }, { t: 'hr' }]);
  });
});
