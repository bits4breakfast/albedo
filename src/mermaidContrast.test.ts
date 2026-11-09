/**
 * The mermaid theme's colours (#289), measured on every theme: each piece of
 * text in a diagram on the ground it is drawn on clears 4.5:1, each line a
 * reader follows clears 3:1, and the block's own bar and error text clear
 * 4.5:1 on the well. The theme is read from mermaid.ts and the tokens from
 * styles.css, so a later edit to either fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINE_PAIRS, TEXT_PAIRS, THEME_TOKENS, themeVariables } from './ui/transcript/mermaid';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const tx = readFileSync(new URL('./ui/transcript/transcript.css', import.meta.url), 'utf8');
const DARK_MEDIA = css.indexOf('@media (prefers-color-scheme: dark)');
const DARK_ATTR = css.indexOf(":root[data-theme='dark']");

function tokensIn(from: number, to: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.slice(from, to).matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!.toLowerCase());
  }
  return out;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
const light = tokensIn(0, DARK_MEDIA);
const themes = {
  light,
  // The dark blocks override; anything they leave alone is the light value.
  'dark (system)': new Map([...light, ...tokensIn(DARK_MEDIA, DARK_ATTR)]),
  'dark (chosen)': new Map([...light, ...tokensIn(DARK_ATTR, css.length)]),
};

function rule(selector: string): string {
  const at = tx.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return tx.slice(at, tx.indexOf('}', at));
}

describe('the mermaid theme (#289)', () => {
  it('uses only tokens, and the block never dims with opacity', () => {
    for (const name of Object.values(THEME_TOKENS)) expect(name).toMatch(/^--[a-z-]+$/);
    expect(tx).not.toMatch(/\.tx-mermaid[^{]*\{[^}]*opacity/);
    expect(rule('.tx-mermaid-kind')).toMatch(/color: var\(--faint\)/);
    expect(rule('.tx-mermaid-act')).toMatch(/color: var\(--muted\)/);
    expect(rule('.tx-mermaid-error-text')).toMatch(/color: var\(--muted\)/);
  });

  for (const [name, t] of Object.entries(themes)) {
    const v = themeVariables((token) => t.get(token) ?? '');

    it(`every token it uses is a colour, ${name}`, () => {
      for (const [key, value] of Object.entries(v)) expect(value, key).toMatch(/^#[0-9a-f]{6}$/);
    });

    it(`text clears 4.5:1 on its ground, ${name}`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        expect(ratio(v[fg], v[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`lines clear 3:1 on the well, ${name}`, () => {
      for (const [fg, bg] of LINE_PAIRS) {
        expect(ratio(v[fg], v[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`the bar and the error read on the well, ${name}`, () => {
      const g = (k: string) => t.get(k)!;
      expect(ratio(g('--faint'), g('--panel-inset'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(g('--muted'), g('--panel-inset'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(g('--text'), g('--panel-hover'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(g('--text'), g('--panel-raised'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(g('--danger'), g('--panel-inset'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
