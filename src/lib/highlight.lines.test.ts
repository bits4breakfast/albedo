/**
 * Whole texts tokenized a slice at a time (#412): the same tokens as one
 * call, the grammar state carried across slices, a yield between them, and
 * only as far as asked.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  highlightLines,
  highlightToTokens,
  MAX_TOKENIZED_LINE,
  peekLineTokens,
  setSliceForTests,
  type DualToken,
} from './highlight';

afterEach(() => setSliceForTests(100, 6_000));

/** A text with a block comment that runs across several two-line slices. */
function sample(tag: string): string {
  return [
    `const ${tag} = 1;`,
    '/*',
    ' first',
    ' second',
    ' third',
    ' */',
    'function f(a: string): number {',
    '  return a.length; // trailing',
    '}',
    'const s = `tpl ${a}`;',
  ].join('\n');
}

const shape = (lines: DualToken[][]) => lines.map((l) => l.map((t) => [t.content, t.style]));

describe('highlightLines', () => {
  it('gives the same tokens as one call, with the comment carried across slices', async () => {
    setSliceForTests(2);
    const code = sample('one');
    const sliced = await highlightLines(code, 'typescript');
    // A different key (one more, empty line), so this is tokenized afresh.
    const whole = await highlightToTokens(`${code}\n`, 'typescript');
    expect(sliced).toHaveLength(10);
    expect(shape(sliced)).toEqual(shape(whole.slice(0, 10)));
    // And the comment really is coloured as one, not as code.
    const comment = sliced[1]?.[0]?.style['--shiki-light'];
    expect(comment).toBeTruthy();
    expect(sliced[3]?.every((t) => t.style['--shiki-light'] === comment)).toBe(true);
  });

  it('yields to the browser between slices', async () => {
    await highlightToTokens('const warm = 1;', 'typescript');
    setSliceForTests(2);
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    await highlightLines(sample('two'), 'typescript');
    expect(ticked).toBe(true);
  });

  it('tokenizes only as far as asked, and carries on from there', async () => {
    setSliceForTests(2);
    const code = sample('three');
    const first = await highlightLines(code, 'typescript', 4);
    expect(first).toHaveLength(4);
    expect(peekLineTokens(code, 'typescript')).toHaveLength(4);
    const rest = await highlightLines(code, 'typescript');
    expect(rest).toHaveLength(10);
    const comment = rest[1]?.[0]?.style['--shiki-light'];
    expect(rest[4]?.every((t) => t.style['--shiki-light'] === comment)).toBe(true);
  });

  it('leaves a line too long to tokenize plain', async () => {
    const long = `const s = "${'v'.repeat(MAX_TOKENIZED_LINE)}";`;
    const lines = await highlightLines(`const a = 1;\n${long}\nconst b = 2;`, 'typescript');
    expect(lines[1]).toHaveLength(1);
    expect(lines[1]?.[0]?.style['--shiki-light']).toBeUndefined();
    expect(lines[2]!.length).toBeGreaterThan(1);
  });
});
