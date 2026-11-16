/**
 * Without the vscode-textmate seam the one pass relies on (#418), highlighting
 * falls back to Shiki's two passes for good, with the same tokens, and says so
 * once. Its own file: the decision is made once per module, at the first
 * grammar load.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ThemedTokenWithVariants, TokenStyles } from 'shiki/core';
import {
  THEMES,
  ensureLang,
  getHighlighter,
  highlightBlocks,
  highlightLines,
  highlightToTokens,
  onePassForTests,
  type DualToken,
} from './highlight';

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
const convert = (lines: ThemedTokenWithVariants[][]): DualToken[][] =>
  lines.map((l) => l.map((t) => ({ content: t.content, offset: t.offset, style: expectedStyle(t.variants.light, t.variants.dark) })));

const CODE = [
  'import { a } from "b";',
  '/* a comment',
  '   across lines */',
  'export function f(x: number): string {',
  '  return `${x}`; // trailing',
  '}',
  '',
].join('\n');

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
afterAll(() => warn.mockRestore());

describe('without the seam', () => {
  it('falls back to two passes, with the same tokens, and says so once', async () => {
    const hl = await getHighlighter();
    // Load the grammar directly, so its class can lose the getter before
    // highlight.ts first looks for it.
    await hl.loadLanguage((await import('shiki/langs/typescript.mjs')).default);
    const proto = Object.getPrototypeOf(hl.getLanguage('typescript')) as object;
    const getter = Object.getOwnPropertyDescriptor(proto, 'themeProvider')!;
    expect(getter.get).toBeTypeOf('function');
    Object.defineProperty(proto, 'themeProvider', { configurable: true, get: () => undefined });
    try {
      expect(await ensureLang('typescript')).toBe(true);
    } finally {
      Object.defineProperty(proto, 'themeProvider', getter);
    }
    expect(onePassForTests()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('grammar.themeProvider');

    const expected = convert(hl.codeToTokensWithThemes(CODE, { lang: 'typescript', themes: THEMES }));
    expect(await highlightToTokens(CODE, 'typescript')).toEqual(expected);
    // Whole text in one slice here, so the offsets are the file's.
    expect(await highlightLines(`${CODE}\n`, 'typescript')).toEqual(
      convert(hl.codeToTokensWithThemes(`${CODE}\n`, { lang: 'typescript', themes: THEMES, tokenizeMaxLineLength: 2_000 })),
    );
    expect(await highlightBlocks([CODE], 'typescript')).toEqual(expected);

    // Decided for good: a later grammar does not look again.
    expect(await ensureLang('css')).toBe(true);
    expect(onePassForTests()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  }, 60_000);
});
