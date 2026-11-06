/**
 * The copy button's tokens (#242), measured on every theme: the icon is a
 * non-text glyph (3:1) in --muted at rest on the grounds it sits on, and
 * --text-strong on --panel-hover when pointed at. The CSS is read too, so a
 * later edit to another token fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
const themes = {
  light: tokensIn(0, DARK_MEDIA),
  'dark (system)': tokensIn(DARK_MEDIA, DARK_ATTR),
  'dark (chosen)': tokensIn(DARK_ATTR, css.length),
};

function rule(selector: string): string {
  const at = tx.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return tx.slice(at, tx.indexOf('}', at));
}

describe('the copy button’s colours (#242)', () => {
  it('uses the tokens measured below', () => {
    expect(rule('.tx-copy')).toMatch(/color: var\(--muted\)/);
    expect(tx).toMatch(/\.tx-copy:hover \{ color: var\(--text-strong\); background: var\(--panel-hover\); \}/);
    expect(rule('.tx-copy-inline')).toMatch(/background: var\(--panel-chrome\)/);
    expect(tx).not.toMatch(/\.tx-copy[^{]*\{[^}]*opacity/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clears 3:1 as a glyph, ${name}`, () => {
      const g = (k: string) => t.get(k)!;
      // At rest: on a block's well, and on an inline chip's ground.
      expect(ratio(g('--muted'), g('--panel-inset'))).toBeGreaterThanOrEqual(3);
      expect(ratio(g('--muted'), g('--panel-chrome'))).toBeGreaterThanOrEqual(3);
      // Pointed at.
      expect(ratio(g('--text-strong'), g('--panel-hover'))).toBeGreaterThanOrEqual(3);
      // The tick and the failure, on the wells they show on.
      expect(ratio(g('--add'), g('--panel-inset'))).toBeGreaterThanOrEqual(3);
      expect(ratio(g('--danger'), g('--panel-chrome'))).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('the inline copy icon is always there and reachable (#244)', () => {
  // #243 revealed it on hover, 1px to the right of the code: crossing that
  // pixel ended the hover, so it hid before the pointer got to it.
  it('is never hidden, never offset, never floated away from the code', () => {
    const inline = rule('.tx-copy-inline');
    expect(inline).not.toMatch(/visibility|display: none|position: absolute|margin/);
    expect(tx).not.toMatch(/\.tx-md-code-wrap:hover/);
    // A segment of the chip: the wrap lays them side by side, stretched to one height.
    expect(rule('.tx-md-code-wrap')).toMatch(/display: inline-flex;[\s\S]*align-items: stretch/);
  });
});
