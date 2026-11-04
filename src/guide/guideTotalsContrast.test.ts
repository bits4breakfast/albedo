/**
 * The guide's change totals (#250): "+320 −45" in --add and --del, on the meta
 * row's two grounds -- --panel, and --banner-bg once the guide is out of date
 * -- in every theme. Text, so 4.5:1. The CSS is read too, so moving them onto
 * another token or ground fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('./guide.css', import.meta.url), 'utf8');
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

describe('the guide’s change totals (#250)', () => {
  it('use the file counts’ tokens, on the meta row', () => {
    expect(guide).toMatch(/\.gd-add \{ color: var\(--add\); \}/);
    expect(guide).toMatch(/\.gd-del \{ color: var\(--del\); \}/);
    expect(guide).toMatch(/\.gd-meta\[data-stale\] \{[^}]*background: var\(--banner-bg\)/);
    expect(guide).not.toMatch(/\.gd-meta-totals[^{]*\{[^}]*opacity/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clear 4.5:1 on both grounds, ${name}`, () => {
      for (const ground of ['--panel', '--banner-bg']) {
        for (const fg of ['--add', '--del', '--muted', '--banner-text']) {
          expect(ratio(t.get(fg)!, t.get(ground)!), `${fg} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
