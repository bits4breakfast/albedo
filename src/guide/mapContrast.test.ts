/**
 * The guide's Map (#288): every group colour, edge, arrow and text tier
 * against every ground a box takes, in every theme. Groups, edges and bars
 * are UI (3:1); text is 4.5.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('./guide.css', import.meta.url), 'utf8');

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

const themes = {
  light: tokensIn(0, DARK_MEDIA),
  'dark (system)': tokensIn(DARK_MEDIA, DARK_ATTR),
  'dark (chosen)': tokensIn(DARK_ATTR, css.length),
};

const BOX_GROUNDS = ['--panel', '--panel-hover', '--accent-soft'];

describe('the guide map (#288)', () => {
  it('draws each part with the token measured here, and never with opacity', () => {
    for (let i = 1; i <= 8; i++) expect(guide).toContain(`[data-colour='${i}'] { background: var(--group-${i}); }`);
    expect(guide).toMatch(/\.gd-map-edge path \{[^}]*stroke: var\(--border-strong\)/);
    expect(guide).toMatch(/\.gd-map-edge\[data-hot\] path \{[^}]*stroke: var\(--accent\)/);
    expect(guide).toMatch(/\.gd-map-node \{[^}]*border: 1px solid var\(--border-strong\)/);
    expect(guide).toMatch(/\.gd-map-size \{[^}]*background: var\(--border-strong\)/);
    expect(guide).toMatch(/\.gd-map-node \{[^}]*color: var\(--text\)/);
    expect(guide).toMatch(/\.gd-map-node\[aria-current='true'\] \{[^}]*color: var\(--on-accent-soft\)/);
    expect(guide).not.toMatch(/\.gd-map-name \{[^}]*font-weight/);
    expect(guide).toMatch(/\.gd-map-facts \{[^}]*color: var\(--muted\)/);
    // Read · Map is the app's .seg, not one of its own.
    expect(guide).not.toMatch(/\.gd-seg/);
    expect(css).toMatch(/\.seg-compact \{ --seg-h:/);
    expect(guide).not.toMatch(/\.gd-map[^{]*\{[^}]*opacity/);
    expect(guide).not.toMatch(/\.gd-map[^{]*\{[^}]*color-mix/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: group colours, edges and the size bar clear 3:1 on every box ground`, () => {
      for (const g of BOX_GROUNDS) {
        for (let i = 1; i <= 8; i++) {
          expect(ratio(t.get(`--group-${i}`)!, t.get(g)!), `${name} --group-${i} on ${g}`).toBeGreaterThanOrEqual(3);
        }
        expect(ratio(t.get('--border-strong')!, t.get(g)!), `${name} --border-strong on ${g}`).toBeGreaterThanOrEqual(3);
        expect(ratio(t.get('--accent')!, t.get(g)!), `${name} --accent on ${g}`).toBeGreaterThanOrEqual(3);
        expect(ratio(t.get('--muted')!, t.get(g)!), `${name} unsorted stripe on ${g}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${name}: a box’s text clears 4.5 on every ground it takes`, () => {
      for (const g of BOX_GROUNDS) {
        for (const k of ['--text', '--muted', '--add', '--del', '--accent']) {
          expect(ratio(t.get(k)!, t.get(g)!), `${name} ${k} on ${g}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: the Read · Map toggle reads on the row’s grounds and on its chosen half`, () => {
      expect(ratio(t.get('--muted')!, t.get('--panel-chrome')!), `${name} --muted on the track`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.get('--on-accent-soft')!, t.get('--accent-soft')!), `${name} current box`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.get('--text-strong')!, t.get('--seg-on')!), `${name} chosen`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
