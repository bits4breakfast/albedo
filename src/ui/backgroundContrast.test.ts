/**
 * When a task will next wake itself (#443), at 4.5:1 on every ground it is
 * drawn on, in every theme: the row's "next check 14:13" (--text) on the
 * grounds an Idle or Done row can have, --panel-raised first (CLAUDE.md,
 * Contrast rule 1), and the band's time (--text-strong) on the band and its
 * hovered line. The CSS is read too, so a rule moved to another token or
 * dimmed with opacity fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('./tasklist.css', import.meta.url), 'utf8');
const band = readFileSync(new URL('./transcript/transcript.css', import.meta.url), 'utf8');
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
const light = tokensIn(0, DARK_MEDIA);
const themes: Record<string, Map<string, string>> = {
  light,
  'dark (system)': new Map([...light, ...tokensIn(DARK_MEDIA, DARK_ATTR)]),
  'dark (chosen)': new Map([...light, ...tokensIn(DARK_ATTR, css.length)]),
};

/** ink -> the grounds it is drawn on. */
const PAIRS: Record<string, string[]> = {
  // A row at rest, hovered, with its menu open, pressed; and the selected
  // row, which never shows it but is the worst ground a row can have.
  '--text': ['--panel-raised', '--panel-active', '--row-selected', '--panel-hover', '--panel-chrome'],
  // The band (.tx-queued) and its hovered line.
  '--text-strong': ['--panel', '--panel-hover'],
};

function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf('}', at));
}

describe('when a task will next wake itself (#443): contrast', () => {
  it('the row label is --text, the band time --text-strong, neither dimmed', () => {
    expect(rule(list, ".task-background[data-wake='true']")).toMatch(/color: var\(--text\);/);
    expect(rule(band, '.tx-background-when')).toMatch(/color: var\(--text-strong\);/);
    for (const r of [rule(list, ".task-background[data-wake='true']"), rule(list, '.task-background'), rule(band, '.tx-background-when')]) {
      expect(r).not.toMatch(/opacity/);
    }
  });

  for (const [theme, t] of Object.entries(themes)) {
    for (const [ink, grounds] of Object.entries(PAIRS)) {
      for (const ground of grounds) {
        it(`${theme}: ${ink} on ${ground} is at least 4.5:1`, () => {
          const g = t.get(ground);
          const i = t.get(ink);
          expect(g, `${ground} in ${theme}`).toBeDefined();
          expect(i, `${ink} in ${theme}`).toBeDefined();
          expect(ratio(i!, g!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

