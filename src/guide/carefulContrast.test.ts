/**
 * The careful mark and Set Aside (#295): --warn is text (a file's reason,
 * the "Careful" label) on every ground a file row and a Map box take, in
 * every theme: 4.5. The rule beside the Careful note and Set Aside's grey
 * are UI: 3:1. Never opacity, never a colour-mix.
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

const GROUNDS = ['--panel', '--panel-hover', '--accent-soft'];

describe('review carefully and Set Aside (#295)', () => {
  it('draws the mark in --warn and Set Aside in --border-strong, never with opacity', () => {
    expect(guide).toMatch(/\.gd-careful-icon \{[^}]*color: var\(--warn\)/);
    expect(guide).toMatch(/\.gd-file-careful \{[^}]*color: var\(--warn\)/);
    expect(guide).toMatch(/\.gd-diff-why-text\[data-careful\] \{ border-left-color: var\(--warn\); \}/);
    expect(guide).toMatch(/\[data-colour='aside'\] \{ background: var\(--border-strong\); \}/);
    const added = guide.slice(guide.indexOf('Set aside and review carefully (#295)'));
    expect(added).not.toMatch(/opacity|color-mix/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`--warn reads as text on every row and box ground, ${name}`, () => {
      for (const g of GROUNDS) expect(ratio(t.get('--warn')!, t.get(g)!), `${g}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`the Careful rule and Set Aside's grey stand off their grounds, ${name}`, () => {
      expect(ratio(t.get('--warn')!, t.get('--panel')!)).toBeGreaterThanOrEqual(3);
      for (const g of GROUNDS) expect(ratio(t.get('--border-strong')!, t.get(g)!), `${g}`).toBeGreaterThanOrEqual(3);
    });
  }
});
