/**
 * The status strip's text (#283 added the keep-awake note): every colour
 * token its text uses clears 4.5:1 on its ground, --panel-chrome, in all
 * three theme blocks of styles.css. And no dimming the audit cannot see:
 * no opacity, no color-mix with transparent (CLAUDE.md, Contrast 2 and 5).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const strip = readFileSync(new URL('./statusbar.css', import.meta.url), 'utf8');

const DARK_MEDIA = css.indexOf('@media (prefers-color-scheme: dark)');
const DARK_ATTR = css.indexOf(":root[data-theme='dark']");

function tokensIn(from: number, to: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.slice(from, to).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) {
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
const themes: Record<string, Map<string, string>> = {
  light,
  'dark (system)': new Map([...light, ...tokensIn(DARK_MEDIA, DARK_ATTR)]),
  'dark (chosen)': new Map([...light, ...tokensIn(DARK_ATTR, css.length)]),
};

/** The `color:` of a rule in statusbar.css, as the token it names. */
function colorOf(selector: string): string {
  const at = strip.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = strip.slice(at, strip.indexOf('}', at));
  const m = body.match(/(?:^|[\s;{])color:\s*var\((--[a-z0-9-]+)\)/);
  expect(m, `${selector} color`).not.toBeNull();
  return m![1]!;
}

describe('status strip contrast', () => {
  it('the strip is on --panel-chrome', () => {
    const at = strip.indexOf('.statusbar {');
    expect(strip.slice(at, strip.indexOf('}', at))).toMatch(/background:\s*var\(--panel-chrome\)/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: the keep-awake note and the strip's text clear 4.5 on --panel-chrome`, () => {
      const ground = t.get('--panel-chrome')!;
      expect(ground, '--panel-chrome').toBeDefined();
      for (const sel of ['.statusbar', '.keep-awake-note', '.plan-label', '.plan-reset']) {
        const token = colorOf(sel);
        const fg = t.get(token);
        expect(fg, `${sel} ${token}`).toBeDefined();
        expect(ratio(fg!, ground), `${name} ${sel} ${token} on --panel-chrome`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('dims nothing with opacity or a transparent mix', () => {
    expect(strip).not.toMatch(/opacity\s*:/);
    expect(strip).not.toMatch(/color-mix\([^)]*transparent/);
  });
});
