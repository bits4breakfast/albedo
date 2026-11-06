/**
 * The task rail's circles (#266), measured in every theme block of
 * styles.css: a count is text (4.5:1) on its own ground -- the fill for a
 * filled circle, the circle's --panel and the rail's --panel-chrome for an
 * outlined one -- and the outlines and the selected ring are UI (3:1) on the
 * rail. The CSS is checked to draw each with the token measured here, and to
 * dim nothing with opacity or a transparent mix.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const rail = readFileSync(new URL('./taskrail.css', import.meta.url), 'utf8');

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

// Each dark block overrides the light :root; a token it leaves alone is the light one.
const light = tokensIn(0, DARK_MEDIA);
const themes: Record<string, Map<string, string>> = {
  light,
  'dark (system)': new Map([...light, ...tokensIn(DARK_MEDIA, DARK_ATTR)]),
  'dark (chosen)': new Map([...light, ...tokensIn(DARK_ATTR, css.length)]),
};

/** Each group's circle colour, as taskrail.css sets `--c`. */
const GROUP_COLOUR = {
  blocked: '--status-blocked',
  active: '--status-running',
  review: '--status-done',
  reviewing: '--status-done',
  quiet: '--status-idle',
  done: '--status-done',
} as const;
const FILLED = ['blocked', 'review'] as const;
const OUTLINED = ['active', 'reviewing', 'quiet', 'done'] as const;

describe('the task rail’s circles (#266)', () => {
  it('draws each with the token measured below', () => {
    for (const [group, token] of Object.entries(GROUP_COLOUR)) {
      const sel = new RegExp(`\\.rail-circle\\[data-group='${group}'\\][^{]*\\{ --c: var\\(${token}\\); \\}`);
      expect(rail, group).toMatch(sel);
    }
    expect(rail).toMatch(/\.rail-circle \{[^}]*border: 2px solid var\(--c\);[^}]*background: var\(--panel\);[^}]*color: var\(--text\);/);
    expect(rail).toMatch(/\.rail-circle\[data-fill='solid'\] \{ background: var\(--c\); color: var\(--panel\); \}/);
    expect(rail).toMatch(/\.rail-circle\[aria-current='true'\]::after \{[^}]*border: 1\.5px solid var\(--accent\)/);
    expect(rail).not.toMatch(/opacity\s*:/);
    expect(rail).not.toMatch(/transparent\)/);
    // The rail is the sidebar's ground.
    expect(css).toMatch(/\.sidebar \{[^}]*background: var\(--panel-chrome\)/);
  });

  for (const [name, t] of Object.entries(themes)) {
    const tok = (k: string) => {
      const v = t.get(k);
      expect(v, `${name} ${k}`).toBeDefined();
      return v!;
    };

    it(`${name}: a filled circle's count clears 4.5 on its fill`, () => {
      for (const g of FILLED) {
        expect(ratio(tok('--panel'), tok(GROUP_COLOUR[g])), `${name} ${g}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: an outlined circle's count clears 4.5 on the circle and on the rail`, () => {
      for (const ground of ['--panel', '--panel-chrome']) {
        expect(ratio(tok('--text'), tok(ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: every outline, fill edge and the selected ring clear 3:1 on the rail`, () => {
      for (const g of [...FILLED, ...OUTLINED]) {
        expect(ratio(tok(GROUP_COLOUR[g]), tok('--panel-chrome')), `${name} ${g}`).toBeGreaterThanOrEqual(3);
        // An outline also has to stand off the circle's own --panel inside it.
        expect(ratio(tok(GROUP_COLOUR[g]), tok('--panel')), `${name} ${g} inside`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio(tok('--accent'), tok('--panel-chrome')), `${name} ring`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: the popover's head clears 4.5 on the menu's --panel`, () => {
      expect(ratio(tok('--text'), tok('--panel'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok('--muted'), tok('--panel'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the popover head draws with those tokens', () => {
    expect(rail).toMatch(/\.rail-pop-title \{ color: var\(--text\);/);
    expect(rail).toMatch(/\.rail-pop-count \{[^}]*color: var\(--muted\);/);
  });
});
