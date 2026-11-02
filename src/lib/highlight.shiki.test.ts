import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGS, ensureLang, highlightToTokens } from './highlight';

/*
 * What the Shiki 1 -> 4 upgrade (#206) had to keep. The engines left
 * `shiki/core` in Shiki 3, and a wrong import path fails soft by design --
 * every token plain, nothing thrown -- so only a test that looks at the
 * colours notices. The expected values are the ones Shiki 1.29.2 produced
 * with the same two themes; 4.5.0 gives the same tokens and colours for
 * these languages (compared over whole files from this repository).
 */

/** The token whose text is `content` on line `line`, with both colours. */
async function colours(code: string, lang: string, line: number, content: string) {
  const lines = await highlightToTokens(code, lang);
  const tok = lines[line]?.find((t) => t.content === content);
  return tok && { light: tok.style['--shiki-light'], dark: tok.style['--shiki-dark'] };
}

const KEYWORD = { light: '#CF222E', dark: '#FF7B72' };
const STRING = { light: '#0A3069', dark: '#A5D6FF' };
const COMMENT = { light: '#6E7781', dark: '#8B949E' };
const FUNCTION = { light: '#8250DF', dark: '#D2A8FF' };
const TYPE = { light: '#953800', dark: '#FFA657' };

describe('Shiki colours stay what they were', () => {
  it('TypeScript: keyword, string and comment', async () => {
    const code = "import { a } from 'b';\n// note\n";
    expect(await colours(code, 'typescript', 0, 'import')).toEqual(KEYWORD);
    expect(await colours(code, 'typescript', 0, "'b'")).toEqual(STRING);
    expect(await colours(code, 'typescript', 1, '// note')).toEqual(COMMENT);
  });

  it('PHP: class name, method name and string', async () => {
    const code = '<?php\nfinal class X {\n  public function f(): string { return "a"; }\n}\n';
    expect(await colours(code, 'php', 1, 'X')).toEqual(TYPE);
    expect(await colours(code, 'php', 2, 'f')).toEqual(FUNCTION);
    expect(await colours(code, 'php', 2, '"a"')).toEqual(STRING);
  });

  it('Rust: keyword and string', async () => {
    const code = 'fn main() {\n    let s = "x";\n}\n';
    expect(await colours(code, 'rust', 0, 'fn')).toEqual(KEYWORD);
    expect(await colours(code, 'rust', 1, '"x"')).toEqual(STRING);
  });
});

describe('every grammar in the bounded set loads', () => {
  it.each(SUPPORTED_LANGS.map((l) => [l]))('%s', async (lang) => {
    expect(await ensureLang(lang)).toBe(true);
  });
});
