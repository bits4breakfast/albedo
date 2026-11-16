/**
 * Search in a Review Guide (#413): a match is --on-hit on --hit, the current
 * one on --hit-cur, in every theme, with headroom (CLAUDE.md, Contrast rule
 * 4); the bar and the results list draw their text in tokens cleared on the
 * grounds they sit on. The CSS is read too, so moving a match onto the
 * token's syntax colour, a tint mixed with transparent, or opacity fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('./guide.css', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('../ui/transcript/transcript.css', import.meta.url), 'utf8');
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

/** The search's rules, from its heading to the end of guide.css. */
const searchCss = guide.slice(guide.indexOf('/* --- Search (#413)'));

describe('search matches and the search bar (#413)', () => {
  it('draw a match on its own ground, in its own text tier', () => {
    expect(transcript).toMatch(/\.tx-d \.tx-d-code \.tx-tok\.tx-d-hit \{ background: var\(--hit\); color: var\(--on-hit\);/);
    expect(transcript).toMatch(/\.tx-d \.tx-d-code \.tx-tok\.tx-d-hit-cur \{ background: var\(--hit-cur\); \}/);
    expect(searchCss).toMatch(/\.gd-search-mark \{ background: var\(--hit\); color: var\(--on-hit\);/);
    expect(searchCss).not.toMatch(/opacity|color-mix\([^)]*transparent/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clear 4.5:1 with headroom, ${name}`, () => {
      for (const ground of ['--hit', '--hit-cur']) {
        expect(ratio(t.get('--on-hit')!, t.get(ground)!), `--on-hit on ${ground}`).toBeGreaterThanOrEqual(5.2);
      }
      // The bar and the list: on the pane, a hovered row, the picked row, the field.
      for (const ground of ['--panel', '--panel-hover', '--accent-soft']) {
        for (const fg of ['--text', '--text-strong', '--muted', '--faint', '--del']) {
          expect(ratio(t.get(fg)!, t.get(ground)!), `${fg} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(ratio(t.get('--text-strong')!, t.get('--panel-inset')!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.get('--faint')!, t.get('--panel-inset')!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
