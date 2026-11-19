/**
 * The text #448 adds, measured from styles.css in all three theme blocks on
 * the grounds it is drawn on, and checked to still use those tokens: the
 * trigger card on the "waiting on you" card's --prompt-bg, its drafted
 * message on --panel-inset, the sheet in Projects… on the modal's --panel,
 * and the row's word in the Needs You tier on every ground a row has.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const triggers = readFileSync(new URL('./ui/triggers/triggers.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('./ui/tasklist.css', import.meta.url), 'utf8');

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

function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf('}', at));
}

describe('Triggers (#448)', () => {
  it('draw with the tokens measured here, never dimmed, tinted or mixed', () => {
    expect(rule(triggers, '.tg-meta')).toMatch(/color: var\(--faint\);/);
    expect(rule(triggers, '.tg-why')).toMatch(/color: var\(--text\);/);
    const msg = rule(triggers, '.tg-msg');
    expect(msg).toMatch(/color: var\(--text-strong\);/);
    expect(msg).toMatch(/background: var\(--panel-inset\);/);
    expect(triggers).toMatch(/\.tg-msg\[disabled\] \{ color: var\(--faint\); \}/);
    expect(rule(triggers, '.tg-note')).toMatch(/color: var\(--muted\);/);
    expect(triggers).toMatch(/\.tg-lead \{[^}]*color: var\(--muted\);/);
    expect(triggers).toMatch(/\.tg-ev \{[^}]*color: var\(--text-strong\);/);
    expect(triggers.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/opacity|color-mix|rgba|transparent/);
    // The row's word shares the preview's rule: the Needs You text tier.
    expect(list).toMatch(/\.task-why\[data-why='preview'\],\n\.task-why\[data-why='trigger'\] \{ color: var\(--status-blocked\); \}/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: text clears 4.5 on its grounds`, () => {
      const g = (k: string) => {
        const v = t.get(k);
        expect(v, `${name} ${k}`).toBeDefined();
        return v!;
      };
      const text: Array<[string, string]> = [
        // The card, on the "waiting on you" ground.
        ['--text', '--prompt-bg'],
        ['--muted', '--prompt-bg'],
        ['--faint', '--prompt-bg'],
        // The drafted message.
        ['--text-strong', '--panel-inset'],
        ['--faint', '--panel-inset'],
        // The sheet, on the modal.
        ['--text-strong', '--panel'],
        ['--muted', '--panel'],
        ['--faint', '--panel'],
        // The row's word, on every ground a Needs You row has.
        ['--status-blocked', '--row-blocked'],
        ['--status-blocked', '--row-blocked-hover'],
        ['--status-blocked', '--row-selected'],
        ['--status-blocked', '--panel-raised'],
        ['--status-blocked', '--panel-active'],
        ['--status-blocked', '--accent-soft-strong'],
      ];
      for (const [fg, bg] of text) expect(ratio(g(fg), g(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // The message box's edge, non-text: 3:1.
      expect(ratio(g('--border-strong'), g('--prompt-bg')), `${name} edge`).toBeGreaterThanOrEqual(3);
    });
  }
});
