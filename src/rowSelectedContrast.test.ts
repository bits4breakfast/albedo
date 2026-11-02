/**
 * The selected task row (#203): a tint every row tier stays legible on, and
 * an --accent ring that separates it from the sidebar. Measured from
 * styles.css, so a later token change cannot quietly undo it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
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

/** Text on a row: 4.5. */
const TEXT = ['--text', '--text-strong', '--muted', '--faint', '--add', '--warn', '--danger', '--accent'];
/** Status glyphs: non-text, 3.0. Archived takes --status-idle on this row (tasklist.css). */
const GLYPHS = ['--status-idle', '--status-running', '--status-blocked', '--status-done'];

describe('the selected task row (#203)', () => {
  it('is the tint and the ring', () => {
    expect(rows).toMatch(
      /\.task-row\[data-selected='true'\] \{\s*background: var\(--row-selected\);\s*box-shadow: inset 0 0 0 1px var\(--accent\);\s*\}/,
    );
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: every tier clears its floor on the tint, and the ring stands out`, () => {
      const tint = t.get('--row-selected')!;
      expect(tint).toBeDefined();
      for (const k of TEXT) expect(ratio(t.get(k)!, tint), `${name} ${k}`).toBeGreaterThanOrEqual(4.5);
      for (const k of GLYPHS) expect(ratio(t.get(k)!, tint), `${name} ${k}`).toBeGreaterThanOrEqual(3);
      // The ring against the sidebar and the tint: what makes it visible.
      expect(ratio(t.get('--accent')!, t.get('--panel-chrome')!)).toBeGreaterThanOrEqual(3);
      expect(ratio(t.get('--accent')!, tint)).toBeGreaterThanOrEqual(3);
    });
  }

  it('the two dark blocks agree', () => {
    expect(themes['dark (system)'].get('--row-selected')).toBe(themes['dark (chosen)'].get('--row-selected'));
  });
});
