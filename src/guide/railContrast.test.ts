/**
 * The guide's progress rail (#201): every state reads against the pane, as
 * UI (3:1), and the CSS still draws each with the token measured here.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const rail = readFileSync(new URL('./guide.css', import.meta.url), 'utf8');

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

describe('the guide rail (#201)', () => {
  it('draws each state with its token', () => {
    expect(rail).toMatch(/\.gd-rail-mark::before \{[^}]*border: 1\.5px solid var\(--border-strong\)/);
    expect(rail).toMatch(/\.gd-rail-mark\[data-unsorted\]::before \{ border-style: dashed; \}/);
    expect(rail).toMatch(/\.gd-rail-mark\[data-reviewed\]::before \{ border-color: var\(--status-done\); background: var\(--status-done\); \}/);
    expect(rail).toMatch(/\.gd-rail-mark\[aria-current='true'\]::before \{[^}]*var\(--accent\)/);
    // The count is text: 4.5.
    expect(rail).toMatch(/\.gd-rail-count \{[^}]*color: var\(--text\)/);
    expect(rail).toMatch(/\.gd-rail-of \{[^}]*color: var\(--muted\)/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: every state clears 3:1 on the pane, the count 4.5`, () => {
      const pane = t.get('--panel')!;
      for (const k of ['--border-strong', '--status-done', '--accent', '--muted']) {
        expect(ratio(t.get(k)!, pane), `${name} ${k}`).toBeGreaterThanOrEqual(3);
      }
      for (const k of ['--text', '--muted', '--status-done']) {
        expect(ratio(t.get(k)!, pane), `${name} ${k} as text`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
