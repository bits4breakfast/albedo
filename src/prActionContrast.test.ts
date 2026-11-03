/**
 * The PR's one action and its row marks (#236), measured from styles.css in
 * every token block, so a later token change cannot quietly undo them.
 *
 *   - Squash and Merge…: --add on --add-soft, edged in --add, in the task bar
 *     (--panel).
 *   - ⚠ Conflicts: --warn on --banner-bg, edged in --warn.
 *   - The reason line: --muted on the task bar.
 *   - The row marks (⚠ Conflicts, ✓ Approved): --warn / --add on the sidebar
 *     (--panel-chrome), a hovered row, and the selected row's tint.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const pr = readFileSync(new URL('./ui/pr.css', import.meta.url), 'utf8');
const rows = readFileSync(new URL('./ui/tasklist.css', import.meta.url), 'utf8');

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

describe('the PR action (#236): the rules', () => {
  it('Merge is --add on --add-soft, Conflicts --warn on --banner-bg, each edged in its own tone', () => {
    expect(pr).toMatch(/\.pr-action\[data-tone='merge'\] \{ color: var\(--add\); background: var\(--add-soft\); border-color: var\(--add\); \}/);
    expect(pr).toMatch(
      /\.pr-action\[data-tone='conflicts'\] \{ color: var\(--warn\); background: var\(--banner-bg\); border-color: var\(--warn\); \}/,
    );
    expect(pr).toMatch(/\.pr-reason \{[^}]*color: var\(--muted\)/);
    expect(rows).toMatch(/\.task-review\[data-outcome='conflicts'\] \{ color: var\(--warn\); \}/);
  });

  it('never dims with opacity (contrast rule 2)', () => {
    const own = [...pr.matchAll(/\.pr-(action|reason)[^{]*\{([^}]*)\}/g)].map((m) => m[2]!);
    expect(own.length).toBeGreaterThan(0);
    for (const body of own) expect(body).not.toMatch(/opacity/);
  });
});

for (const [name, t] of Object.entries(themes)) {
  describe(`the PR action (#236), ${name}`, () => {
    const get = (k: string) => {
      const v = t.get(k);
      expect(v, `${name} ${k}`).toBeDefined();
      return v!;
    };

    it('the buttons: text 4.5 on their own ground, the edge 3.0 on the task bar', () => {
      expect(ratio(get('--add'), get('--add-soft'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(get('--warn'), get('--banner-bg'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(get('--add'), get('--panel'))).toBeGreaterThanOrEqual(3);
      expect(ratio(get('--warn'), get('--panel'))).toBeGreaterThanOrEqual(3);
    });

    it('the reason line: 4.5 on the task bar', () => {
      expect(ratio(get('--muted'), get('--panel'))).toBeGreaterThanOrEqual(4.5);
    });

    it('the row marks: 4.5 on the sidebar, a hovered row, and the selected tint', () => {
      for (const ground of ['--panel-chrome', '--panel-hover', '--row-selected']) {
        expect(ratio(get('--warn'), get(ground)), `--warn on ${ground}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(get('--add'), get(ground)), `--add on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}
