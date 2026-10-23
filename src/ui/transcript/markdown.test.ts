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

describe('parseBlocks: lists', () => {
  const item = (text: string, children: unknown[] = []) => ({ text, children });
  const ul = (...items: unknown[]) => ({ t: 'list', ordered: false, start: 1, items });
  const ol = (start: number, ...items: unknown[]) => ({ t: 'list', ordered: true, start, items });

  it('nests a sub-list under a bold label, siblings keeping continuations and code', () => {
    const src = [
      '- **First group:**',
      '  - The first point, with `a code span`.',
      '  - A second point.',
      '  - A third point.',
      '- **Second group:** a sibling with `inline code`',
      '  that continues on a second line.',
      '- **Third group:** another sibling',
      '  continued here too.',
    ].join('\n');
    expect(parseBlocks(src)).toEqual([
      ul(
        item('**First group:**', [
          ul(item('The first point, with `a code span`.'), item('A second point.'), item('A third point.')),
        ]),
        item('**Second group:** a sibling with `inline code`\nthat continues on a second line.'),
        item('**Third group:** another sibling\ncontinued here too.'),
      ),
    ]);
  });

  it('nests three levels with 2-space indents', () => {
    const src = ['- a', '  - b', '    - c', '  - d', '- e'].join('\n');
    expect(parseBlocks(src)).toEqual([
      ul(item('a', [ul(item('b', [ul(item('c'))]), item('d'))]), item('e')),
    ]);
  });

  it('nests three levels with 4-space indents', () => {
    const src = ['- a', '    - b', '        - c', '    - d', '- e'].join('\n');
    expect(parseBlocks(src)).toEqual([
      ul(item('a', [ul(item('b', [ul(item('c'))]), item('d'))]), item('e')),
    ]);
  });

  it('nests under a numbered item at 2 spaces, not only at its content column', () => {
    const src = ['1. **Step**', '  - detail', '  - more', '2. next'].join('\n');
    expect(parseBlocks(src)).toEqual([ol(1, item('**Step**', [ul(item('detail'), item('more'))]), item('next'))]);
  });

  it('nests sloppy 1-space indents by how far each marker moved', () => {
    const src = ['- a', ' - b', '  - c', ' - d', '- e'].join('\n');
    expect(parseBlocks(src)).toEqual([
      ul(item('a', [ul(item('b', [ul(item('c'))]), item('d'))]), item('e')),
    ]);
  });

  it('nests a numbered item at 3 spaces too', () => {
    const src = ['1. a', '   - b', '   - c', '2. d'].join('\n');
    expect(parseBlocks(src)).toEqual([ol(1, item('a', [ul(item('b'), item('c'))]), item('d'))]);
  });

  it('decides ordered or not per level', () => {
    const src = ['- a', '  1. b', '  2. c', '- d', '  - e'].join('\n');
    expect(parseBlocks(src)).toEqual([
      ul(item('a', [ol(1, item('b'), item('c'))]), item('d', [ul(item('e'))])),
    ]);
  });

  it('keeps an ordered start number, at the top and nested', () => {
    expect(parseBlocks('3. a\n4. b')).toEqual([ol(3, item('a'), item('b'))]);
    expect(parseBlocks('- a\n  7) b')).toEqual([ul(item('a', [ol(7, item('b'))]))]);
  });

  it('keeps a loose list together across blank lines, nested items included', () => {
    const src = ['1. a', '', '2. b', '', '   - c', '', '   - d', '', '3. e', '', 'After.'].join('\n');
    expect(parseBlocks(src)).toEqual([
      ol(1, item('a'), item('b', [ul(item('c'), item('d'))]), item('e')),
      { t: 'p', text: 'After.' },
    ]);
  });

  it('attaches a continuation line to the deepest open item', () => {
    const src = ['- a', '  - b', '    more of b', '- c'].join('\n');
    expect(parseBlocks(src)).toEqual([ul(item('a', [ul(item('b\nmore of b'))]), item('c'))]);
  });

  it('starts a new list when the marker kind changes at the same level', () => {
    expect(parseBlocks('- a\n1. b')).toEqual([ul(item('a')), ol(1, item('b'))]);
  });

  it('leaves a code fence inside an item as item text, as before', () => {
    const src = ['- one', '  ```ts', '  const a = 1;', '  ```', '- two'].join('\n');
    expect(parseBlocks(src)).toEqual([ul(item('one\n```ts\nconst a = 1;\n```'), item('two'))]);
  });

  it('ends the list at an unindented fence, a heading or a paragraph', () => {
    expect(parseBlocks('- one\n```ts\nconst a = 1;\n```\n- two')).toEqual([
      ul(item('one')),
      { t: 'code', lang: 'ts', code: 'const a = 1;' },
      ul(item('two')),
    ]);
    expect(parseBlocks('- one\n  - sub\n## Heading\ntext')).toEqual([
      ul(item('one', [ul(item('sub'))])),
      { t: 'h', level: 2, text: 'Heading' },
      { t: 'p', text: 'text' },
    ]);
    expect(parseBlocks('- one\n  - sub\nA paragraph.')).toEqual([
      ul(item('one', [ul(item('sub'))])),
      { t: 'p', text: 'A paragraph.' },
    ]);
    expect(parseBlocks('- one\n\nA paragraph.')).toEqual([ul(item('one')), { t: 'p', text: 'A paragraph.' }]);
  });
});
