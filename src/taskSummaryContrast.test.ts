/**
 * A task's summary (#262): the muted text after the title in the task bar, and
 * the field that edits it. Each is drawn with a token that clears 4.5:1 on
 * every ground it can sit on, in all three theme blocks, and none is dimmed
 * with opacity (CLAUDE.md, Contrast). The task row shows it only in its
 * tooltip. Measured from the CSS, so a later token change cannot quietly undo it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const edit = readFileSync(new URL('./ui/tasktitleedit.css', import.meta.url), 'utf8');

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

/** The body of the first rule whose selector list is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`);
  expect(at, `no rule ${selector}`).toBeGreaterThan(-1);
  return sheet.slice(at, sheet.indexOf('}', at));
}

describe('the task summary (#262)', () => {
  it('is drawn in --muted, on one line, never with opacity', () => {
    const bar = rule(css, '.main-ident-summary');
    expect(bar).toMatch(/color: var\(--muted\);/);
    expect(bar).toMatch(/white-space: nowrap;/);
    expect(bar).toMatch(/text-overflow: ellipsis;/);
    for (const body of [bar, edit]) {
      expect(body).not.toMatch(/opacity/);
      expect(body).not.toMatch(/color-mix\([^)]*transparent/);
    }
    expect(edit).toMatch(/\.task-summary-edit::placeholder \{ color: var\(--faint\); \}/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: the task bar's summary and the edit field clear 4.5`, () => {
      // The bar's ground, and --panel-raised, the floor every tier is held to.
      for (const g of ['--panel', '--panel-raised']) {
        expect(ratio(t.get('--muted')!, t.get(g)!), `${name} --muted on ${g}`).toBeGreaterThanOrEqual(4.5);
      }
      // The field: typed text, and its placeholder, on the inputs' well.
      expect(ratio(t.get('--text-strong')!, t.get('--panel-inset')!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.get('--faint')!, t.get('--panel-inset')!), `${name} placeholder`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
