/**
 * The `/` list's and the skill strip's colours (#349), measured on every
 * theme from styles.css: each text token on each ground it is drawn on --
 * the menu, a hovered row, the selected row, and the strip. The CSS is read
 * too, so a later edit to a token or a rule fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const sk = readFileSync(new URL('./ui/transcript/skillMenu.css', import.meta.url), 'utf8');
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
const themes = {
  light: tokensIn(0, DARK_MEDIA),
  'dark (system)': tokensIn(DARK_MEDIA, DARK_ATTR),
  'dark (chosen)': tokensIn(DARK_ATTR, css.length),
};

function rule(selector: string): string {
  const at = sk.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sk.slice(at, sk.indexOf('}', at));
}

describe('the / list’s colours (#349)', () => {
  it('uses the tokens measured below, and no opacity', () => {
    expect(rule('.sk-pop')).toMatch(/background: var\(--panel\)/);
    expect(sk).toMatch(/\.sk-row:hover \{ background: var\(--panel-hover\); \}/);
    expect(sk).toMatch(/\.sk-row\[aria-selected='true'\] \{ background: var\(--panel-raised\);/);
    expect(rule('.sk-strip')).toMatch(/background: var\(--panel-raised\)/);
    expect(rule('.sk-prefix')).toMatch(/color: var\(--muted\)/);
    expect(rule('.sk-desc')).toMatch(/color: var\(--muted\)/);
    expect(rule('.sk-strip-desc')).toMatch(/color: var\(--muted\)/);
    expect(rule('.sk-hit')).toMatch(/color: var\(--accent\)/);
    expect(rule('.sk-chip')).toMatch(/color: var\(--accent\)/);
    expect(rule('.sk-foot')).toMatch(/color: var\(--faint\)/);
    const rules = sk.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/opacity|color-mix/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clears 4.5:1 on every ground, ${name}`, () => {
      const g = (k: string) => t.get(k)!;
      const grounds = ['--panel', '--panel-hover', '--panel-raised'];
      for (const ground of grounds) {
        for (const text of ['--text', '--text-strong', '--muted', '--faint', '--accent']) {
          expect(ratio(g(text), g(ground)), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
