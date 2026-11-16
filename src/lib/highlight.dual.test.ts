/**
 * One grammar pass for both themes (#418): the tokens must be exactly what
 * Shiki's `codeToTokensWithThemes` gave -- the same tokens, the same offsets,
 * the same colours and font style in both themes -- on whole real files, and
 * through every entry point: one call, a slice at a time, block by block.
 *
 * The expected side is Shiki's own two-pass call, run here, converted the way
 * highlight.ts converted it before #418.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HighlighterCore, ThemedTokenWithVariants, TokenStyles } from 'shiki/core';
import {
  THEMES,
  MAX_TOKENIZED_LINE,
  ensureLang,
  getHighlighter,
  highlightBlocks,
  highlightLines,
  highlightToTokens,
  setSliceForTests,
  type DualToken,
} from './highlight';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Real files, in the languages the app highlights most. */
const FILES: Array<[name: string, lang: string]> = [
  ['./highlight.ts', 'typescript'],
  ['../ui/transcript/Diff.tsx', 'tsx'],
  ['./fixtures/highlight-sample.php', 'php'],
  ['../styles.css', 'css'],
  ['../../package.json', 'json'],
  ['../gh/fixtures/pr-graphql.json', 'json'],
  ['../../docs/REGRESSIONS.md', 'markdown'],
  ['../../docs/ARCHITECTURE.md', 'markdown'],
  ['../../CLAUDE.md', 'markdown'],
  ['../../index.html', 'html'],
  ['../../src-tauri/src/fsx.rs', 'rust'],
  ['../../scripts/regression-reminder.sh', 'shellscript'],
  ['../../.github/workflows/ci.yml', 'yaml'],
  ['../../src-tauri/Cargo.toml', 'toml'],
];

/** The style highlight.ts built from Shiki's two variants before #418. */
function expectedStyle(light: TokenStyles | undefined, dark: TokenStyles | undefined): Record<string, string> {
  const style: Record<string, string> = {};
  if (light?.color) style['--shiki-light'] = light.color;
  if (dark?.color) style['--shiki-dark'] = dark.color;
  const fs = dark?.fontStyle ?? light?.fontStyle ?? 0;
  if (fs & 1) style.fontStyle = 'italic';
  if (fs & 2) style.fontWeight = 'bold';
  if (fs & 4) style.textDecoration = 'underline';
  return style;
}

function convert(lines: ThemedTokenWithVariants[][]): DualToken[][] {
  return lines.map((line) =>
    line.map((t) => ({ content: t.content, offset: t.offset, style: expectedStyle(t.variants.light, t.variants.dark) })),
  );
}

/** Shiki's two-pass tokens for `code`, as the app had them. */
function twoPass(hl: HighlighterCore, code: string, lang: string, maxLine = 0): DualToken[][] {
  return convert(hl.codeToTokensWithThemes(code, { lang, themes: THEMES, tokenizeMaxLineLength: maxLine }));
}

/**
 * What `highlightLines` gave before #418: the same slices (`run` in
 * highlight.ts), Shiki's grammar state carried from one to the next, offsets
 * counted from each slice's start.
 */
function twoPassSliced(hl: HighlighterCore, code: string, lang: string, sliceLines: number, sliceChars: number) {
  const lines = code.split('\n');
  const out: DualToken[][] = [];
  let state: unknown;
  while (out.length < lines.length) {
    const start = out.length;
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < sliceLines && (end === start || chars < sliceChars)) {
      chars += (lines[end]?.length ?? 0) + 1;
      end++;
    }
    const tokens = hl.codeToTokensWithThemes(lines.slice(start, end).join('\n'), {
      lang,
      themes: THEMES,
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      ...(state ? { grammarState: state as never } : {}),
    });
    state = hl.getLastGrammarState(tokens as never);
    out.push(...convert(tokens));
  }
  return out;
}

/** Shiki's light and dark font style must agree, or the shared style would hide one. */
function fontStylesAgree(hl: HighlighterCore, code: string, lang: string): boolean {
  return hl
    .codeToTokensWithThemes(code, { lang, themes: THEMES })
    .every((l) => l.every((t) => (t.variants.light?.fontStyle ?? 0) === (t.variants.dark?.fontStyle ?? 0)));
}

/** Distinct colour pairs: a sanity check that the file is actually coloured. */
function colourPairs(lines: DualToken[][]): number {
  return new Set(lines.flat().map((t) => `${t.style['--shiki-light']}|${t.style['--shiki-dark']}`)).size;
}

let hl: HighlighterCore;

beforeAll(async () => {
  // Grammars a Markdown fence or a PHP template embeds, so those paths run too.
  for (const lang of new Set([...FILES.map(([, l]) => l), 'javascript', 'sql', 'json', 'shellscript'])) {
    expect(await ensureLang(lang)).toBe(true);
  }
  hl = await getHighlighter();
}, 60_000);

afterEach(() => setSliceForTests(100, 6_000));

/** Whole files, each through Shiki twice more as the reference: give a busy machine room. */
const SLOW = 60_000;

describe('one grammar pass gives what two gave', () => {
  it.each(FILES)('%s (%s), in one call', async (path, lang) => {
    const code = read(path);
    const got = await highlightToTokens(code, lang);
    expect(colourPairs(got)).toBeGreaterThan(2);
    expect(got).toEqual(twoPass(hl, code, lang));
  }, SLOW);

  it.each(FILES)('%s (%s), a slice at a time with the grammar state carried', async (path, lang) => {
    setSliceForTests(37, 1_500);
    // A different text from the one-call case, so the cache cannot answer.
    const code = `${read(path)}\n`;
    expect(await highlightLines(code, lang)).toEqual(twoPassSliced(hl, code, lang, 37, 1_500));
  }, SLOW);

  it.each(FILES)('%s (%s), as separate blocks', async (path, lang) => {
    const lines = read(path).split('\n');
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i += 23) blocks.push(lines.slice(i, i + 23).join('\n'));
    // An empty block is plain without asking Shiki, then as now.
    const expected = blocks.flatMap((b) => (b === '' ? [[{ content: '', offset: 0, style: {} }]] : twoPass(hl, b, lang)));
    expect(await highlightBlocks(blocks, lang)).toEqual(expected);
  }, SLOW);

  it('a line too long to tokenize is plain, and the state skips it', async () => {
    const long = `const s = "${'x'.repeat(MAX_TOKENIZED_LINE)}";`;
    const code = ['/* a comment', long, 'still the comment */', 'const after = 1;', ''].join('\n');
    setSliceForTests(2);
    expect(await highlightLines(code, 'typescript')).toEqual(twoPassSliced(hl, code, 'typescript', 2, 6_000));
  });

  it('the light and dark themes agree on font style for these files', () => {
    // highlight.ts emits one font style for both themes; if a file ever
    // disagreed, the comparisons above would not see the difference.
    for (const [path, lang] of FILES) expect(fontStylesAgree(hl, read(path), lang), path).toBe(true);
  }, SLOW);
});

describe('Shiki is left as it was found', () => {
  it("Shiki's own single-theme call still gives its own colours afterwards", async () => {
    const code = 'const a: string = "x"; // note\n';
    // Leaves Shiki with the dark theme current, so the call below does not set it again.
    twoPass(hl, code, 'typescript');
    const before = hl.codeToTokensBase(code, { lang: 'typescript', theme: THEMES.dark });
    await highlightToTokens(`${code}let b = 2;\n`, 'typescript');
    expect(hl.codeToTokensBase(code, { lang: 'typescript', theme: THEMES.dark })).toEqual(before);
  });
});
