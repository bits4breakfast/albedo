/**
 * Keeping a review copy current (#352): every text tier on the ground it is
 * drawn on, in every theme, at 4.5:1 -- the band's --info-band and its
 * force-push and failure state on --banner-bg, "Since your review" on
 * --subcard, its picked and hovered file rows, the row's update line on the
 * Reviewing rows' grounds -- and the rail's "changed" bar as a glyph, 3:1.
 * The CSS is read too, so moving a rule onto another ground or dimming text
 * with opacity fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const band = readFileSync(new URL('./reviewupdate.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../guide/guide.css', import.meta.url), 'utf8');
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

/** ground -> the text tokens drawn on it. */
const TEXT: Record<string, string[]> = {
  '--info-band': ['--text-strong', '--text', '--muted', '--faint', '--accent'],
  '--banner-bg': ['--warn', '--muted', '--text'],
  '--subcard': ['--text', '--text-strong', '--muted', '--accent', '--add', '--del', '--danger'],
  '--panel-hover': ['--accent'],
  '--accent-soft': ['--on-accent-soft'],
  '--panel': ['--accent', '--muted'],
  '--panel-chrome': ['--accent'],
  '--row-selected': ['--accent'],
  '--accent-btn': ['--on-accent'],
};

describe('the review copy band and "Since your review" (#352)', () => {
  it('draw on the grounds measured here, with no opacity on text', () => {
    expect(band).toMatch(/\.rv-band \{[^}]*background: var\(--info-band\)/);
    expect(band).toMatch(/\.rv-band\[data-tone='warn'\] \{[^}]*background: var\(--banner-bg\)/);
    expect(band).toMatch(/\.rv-band\[data-tone='warn'\] \.rv-band-title \{ color: var\(--warn\); \}/);
    expect(guide).toMatch(/\.gd-since \{[^}]*background: var\(--subcard\)/);
    expect(band).not.toMatch(/opacity/);
    const sinceRules = guide.slice(guide.indexOf('--- Since your review (#352)'));
    expect(sinceRules).not.toMatch(/opacity/);
    expect(sinceRules).not.toMatch(/transparent\)/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clear 4.5:1 for text on every ground, ${name}`, () => {
      for (const [ground, fgs] of Object.entries(TEXT)) {
        for (const fg of fgs) {
          expect(t.get(fg), fg).toBeDefined();
          expect(t.get(ground), ground).toBeDefined();
          expect(ratio(t.get(fg)!, t.get(ground)!), `${fg} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`the rail's changed bar is a 3:1 glyph, ${name}`, () => {
      for (const ground of ['--panel', '--panel-hover']) {
        expect(ratio(t.get('--accent')!, t.get(ground)!), `--accent on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
