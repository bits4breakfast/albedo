/**
 * Review before a PR (#464): every new text tier on the ground it is drawn
 * on, in every theme, at 4.5:1 -- the Guide's banner on --info-band, and out
 * of date on --banner-bg; "4 of 6 reviewed" on the task list's row grounds;
 * the task bar's "4 of 6" on the bar and on a hovered badge. The CSS is read
 * too, so moving a rule onto another ground or dimming text with opacity
 * fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('./guide.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('../ui/tasklist.css', import.meta.url), 'utf8');
const pr = readFileSync(new URL('../ui/pr.css', import.meta.url), 'utf8');
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
  // The Guide's banner, and its out-of-date tone.
  '--info-band': ['--text-strong', '--muted'],
  '--banner-bg': ['--warn', '--muted'],
  // Its buttons, on their own grounds.
  '--panel-raised': ['--text'],
  '--accent-btn': ['--on-accent'],
  // My Review's row text, on every row ground.
  '--panel-chrome': ['--muted'],
  '--panel-hover': ['--muted', '--text'],
  '--row-selected': ['--muted'],
  '--accent-soft-strong': ['--muted'],
  // The task bar's Review Changes count, on the bar and a pressed badge.
  '--panel': ['--text', '--muted'],
  '--panel-active': ['--text'],
};

describe('review before a PR (#464): contrast', () => {
  it('draws on the grounds measured here, with no opacity and no alpha on text', () => {
    expect(guide).toMatch(/\.gd-gate \{[^}]*background: var\(--info-band\)/);
    expect(guide).toMatch(/\.gd-gate\[data-tone='warn'\] \{[^}]*background: var\(--banner-bg\)/);
    expect(guide).toMatch(/\.gd-gate-title \{[^}]*color: var\(--text-strong\)/);
    expect(guide).toMatch(/\.gd-gate\[data-tone='warn'\] \.gd-gate-title \{ color: var\(--warn\); \}/);
    expect(guide).toMatch(/\.gd-gate-sub \{[^}]*color: var\(--muted\)/);
    expect(list).toMatch(/\.task-gate \{[^}]*color: var\(--muted\)/);
    expect(pr).toMatch(/\.pr-gate-count \{[^}]*color: var\(--text\)/);
    const rules = [
      guide.slice(guide.indexOf('.gd-gate {'), guide.indexOf('.gd-gate-sub')),
      list.slice(list.indexOf('.task-gate'), list.indexOf('.task-gate') + 80),
      pr.slice(pr.indexOf('.pr-gate-count'), pr.indexOf('.pr-gate-count') + 100),
    ];
    for (const r of rules) {
      expect(r).not.toMatch(/opacity/);
      expect(r).not.toMatch(/transparent\)/);
    }
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clears 4.5:1 for text on every ground, ${name}`, () => {
      for (const [ground, fgs] of Object.entries(TEXT)) {
        for (const fg of fgs) {
          expect(t.get(fg), fg).toBeDefined();
          expect(t.get(ground), ground).toBeDefined();
          expect(ratio(t.get(fg)!, t.get(ground)!), `${fg} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
