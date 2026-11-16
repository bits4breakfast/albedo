/**
 * Whole texts tokenized a slice at a time (#412): the same tokens as one
 * call, the grammar state carried across slices, a yield between them, and
 * only as far as asked.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  highlightBlocks,
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

  it('leaves a line of 2,000 characters plain (a long TSX line costs seconds)', async () => {
    const long = `const s = "${'v'.repeat(1_990)}";`;
    expect(long.length).toBeGreaterThanOrEqual(2_000);
    const lines = await highlightLines(`const a = 1;\n${long}`, 'typescript');
    expect(lines[1]).toHaveLength(1);
  });

  it('gives even a text of one slice a task of its own', async () => {
    await highlightToTokens('const warm = 2;', 'typescript');
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    await highlightLines('const single = 1;\nconst slice = 2;', 'typescript');
    expect(ticked).toBe(true);
  });

  it('stops once nobody is waiting, and carries on for a later ask', async () => {
    setSliceForTests(2);
    const code = Array.from({ length: 40 }, (_, i) => `const gone${i} = ${i};`).join('\n');
    const stop = new AbortController();
    const pending = highlightLines(code, 'typescript', Infinity, stop.signal);
    stop.abort();
    await pending;
    expect(peekLineTokens(code, 'typescript')?.length ?? 0).toBeLessThan(40);
    expect(await highlightLines(code, 'typescript')).toHaveLength(40);
  });

  it('keeps going while one of two callers still waits', async () => {
    setSliceForTests(2);
    const code = Array.from({ length: 20 }, (_, i) => `const kept${i} = ${i};`).join('\n');
    const stop = new AbortController();
    const left = highlightLines(code, 'typescript', Infinity, stop.signal);
    const stays = highlightLines(code, 'typescript');
    stop.abort();
    await left;
    expect(await stays).toHaveLength(20);
  });
});

describe('highlightBlocks', () => {
  it('yields to the browser between blocks once a slice of characters is done', async () => {
    await highlightToTokens('const warm = 3;', 'typescript');
    setSliceForTests(100, 30);
    const blocks = Array.from({ length: 12 }, (_, i) => `const hunk${i} = ${i};`);
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    const lines = await highlightBlocks(blocks, 'typescript');
    expect(lines).toHaveLength(12);
    expect(ticked).toBe(true);
  });
});
