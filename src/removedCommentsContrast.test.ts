/**
 * A comment on removed lines (#402): its red edge, its place ("On removed
 * line 4") and the File mode's gap mark are --del, measured from styles.css
 * on the grounds they sit on -- the card's --panel, the editor's
 * --panel-inset -- in all three theme blocks, and checked to still use it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const cards = readFileSync(new URL('./ui/editor/comments.css', import.meta.url), 'utf8');

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

describe('comments on removed lines (#402)', () => {
  it('draw with the token measured here', () => {
    expect(cards).toMatch(/\.ed-cmt\[data-side='old'\]\[data-state\] \{ border-left-color: var\(--del\); \}/);
    expect(cards).toMatch(/\.ed-cmt\[data-side='old'\] > \.ed-cmt-head > \.ed-cmt-where \{ color: var\(--del\);/);
    expect(cards).toMatch(/\.ed-cmt-gap \{[^}]*background: var\(--del\)/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: the place clears 4.5 on the card, the edge and the mark 3 on theirs`, () => {
      const g = (k: string) => t.get(k)!;
      expect(ratio(g('--del'), g('--panel')), `${name} --del on --panel`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(g('--del'), g('--panel-inset')), `${name} --del on --panel-inset`).toBeGreaterThanOrEqual(3);
    });
  }
});
