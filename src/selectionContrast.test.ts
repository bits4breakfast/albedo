/**
 * Text selection stays visible and legible (#195), per theme, measured from
 * styles.css itself so a later token change cannot quietly undo it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

const DARK_MEDIA = css.indexOf('@media (prefers-color-scheme: dark)');
const DARK_ATTR = css.indexOf(":root[data-theme='dark']");

/** `--name: #hex` in one theme's block. */
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

/** The grounds text can be selected on. */
const GROUNDS = ['--bg', '--panel', '--panel-inset', '--panel-hover', '--panel-raised'];

describe('text selection (#195)', () => {
  it('the rule uses the token and its own text tier', () => {
    expect(css).toMatch(/::selection\s*\{\s*background:\s*var\(--selection\);\s*color:\s*var\(--text-strong\);\s*\}/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: stands apart from every ground, and its text clears 4.5`, () => {
      const sel = t.get('--selection');
      expect(sel).toBeDefined();
      for (const g of GROUNDS) {
        const ground = t.get(g);
        expect(ground, g).toBeDefined();
        // Light fills cannot separate as far without going dark; both are
        // several times the 1.03-1.04 they measured before.
        expect(ratio(sel!, ground!), `${name} ${g}`).toBeGreaterThanOrEqual(name === 'light' ? 1.45 : 2.0);
      }
      expect(ratio(t.get('--text-strong')!, sel!)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the two dark blocks agree', () => {
    expect(themes['dark (system)'].get('--selection')).toBe(themes['dark (chosen)'].get('--selection'));
  });
});
