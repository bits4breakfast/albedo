/**
 * The task rail's circles (#266, #276), measured in every theme block of
 * styles.css: a count is text (4.5:1) on its fill (the group's -ink on its
 * -fill), and each -edge and the selected ring are UI (3:1) on the rail and
 * the list's grounds. The CSS is checked to draw each with the tokens
 * measured here, and to dim nothing with opacity (the pulse's decorative
 * ring aside) or a transparent mix.
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

/** Each group's glyph tokens, as taskrail.css sets `--fill`, `--edge`, `--ink`. */
const GROUP_GLYPH = {
  blocked: 'blocked',
  active: 'running',
  review: 'review',
  reviewing: 'reviewing',
  quiet: 'idle',
  done: 'done',
} as const;
/** The grounds a circle's or a dot's edge must clear 3:1 on. */
const EDGE_GROUNDS = ['--panel', '--panel-chrome', '--row-selected', '--panel-hover', '--panel-raised'];

describe('the task rail’s circles (#266, #276)', () => {
  it('draws each with the tokens measured below', () => {
    for (const [group, g] of Object.entries(GROUP_GLYPH)) {
      const sel = new RegExp(
        `\\.rail-circle\\[data-group='${group}'\\] \\{ --fill: var\\(--status-${g}-fill\\); --edge: var\\(--status-${g}-edge\\); --ink: var\\(--status-${g}-ink\\); \\}`,
      );
      expect(rail, group).toMatch(sel);
    }
    expect(rail).toMatch(/\.rail-circle \{[^}]*border: 1\.5px solid var\(--edge\);[^}]*background: var\(--fill\);[^}]*color: var\(--ink\);/);
    expect(rail).toMatch(/\.rail-circle\[data-fill='ringed'\] \{ box-shadow: inset 0 0 0 2px var\(--panel\); \}/);
    expect(rail).toMatch(/\.rail-circle\[aria-current='true'\]::after \{[^}]*border: 1\.5px solid var\(--accent\)/);
    // Opacity only on the pulse's decorative ring, never on a count.
    for (const m of rail.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*opacity[^{}]*)\}/g)) {
      expect(m[1]!.trim(), m[0]).toMatch(/^(\d+%|\d+%, \d+%|\.rail-circle\[data-pulse\]::before)$/);
    }
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

    it(`${name}: each circle's count clears 4.5 on its fill`, () => {
      for (const g of Object.values(GROUP_GLYPH)) {
        expect(ratio(tok(`--status-${g}-ink`), tok(`--status-${g}-fill`)), `${name} ${g}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: every edge clears 3:1 on the rail, the list's grounds and the hover halo`, () => {
      for (const g of Object.values(GROUP_GLYPH)) {
        for (const ground of EDGE_GROUNDS) {
          expect(ratio(tok(`--status-${g}-edge`), tok(ground)), `${name} ${g} on ${ground}`).toBeGreaterThanOrEqual(3);
        }
      }
      // A Needs You dot also sits on its row's tint.
      for (const ground of ['--row-blocked', '--row-blocked-hover']) {
        expect(ratio(tok('--status-blocked-edge'), tok(ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio(tok('--accent'), tok('--panel-chrome')), `${name} ring`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: the popover's head clears 4.5 on the menu's --panel`, () => {
      expect(ratio(tok('--text'), tok('--panel'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok('--muted'), tok('--panel'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('dark: In Review differs from Ready to Review by lightness, not only by the ring', () => {
    for (const name of ['dark (system)', 'dark (chosen)']) {
      const t = themes[name]!;
      const review = t.get('--status-review-fill')!;
      const reviewing = t.get('--status-reviewing-fill')!;
      expect(ratio(review, reviewing), name).toBeGreaterThanOrEqual(3);
      // Its deep body carries a light ink, ringed in the bright edge.
      expect(ratio(t.get('--status-reviewing-edge')!, reviewing), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('the popover head draws with those tokens', () => {
    expect(rail).toMatch(/\.rail-pop-title \{ color: var\(--text\);/);
    expect(rail).toMatch(/\.rail-pop-count \{[^}]*color: var\(--muted\);/);
  });
});

describe('the pulse (#276)', () => {
  it('rings in the group’s edge, three 2s pulses, restarted by swapping a and b', () => {
    expect(rail).toMatch(/\.rail-circle\[data-pulse\]::before \{[^}]*border: 2px solid var\(--edge\);[^}]*opacity: 0;/);
    expect(rail).toMatch(/\.rail-circle\[data-pulse='a'\]::before \{ animation: rail-pulse-a 2s ease-out 3; \}/);
    expect(rail).toMatch(/\.rail-circle\[data-pulse='b'\]::before \{ animation: rail-pulse-b 2s ease-out 3; \}/);
    expect(rail).toMatch(/@keyframes rail-pulse-a \{[^@]*scale\(1\.55\)/);
  });

  it('with Reduce Motion, shows the ring still for 2s instead', () => {
    const block = rail.slice(rail.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\[data-pulse='a'\]::before \{ animation: rail-still-a 2s linear 1; \}/);
    expect(block).toMatch(/\[data-pulse='b'\]::before \{ animation: rail-still-b 2s linear 1; \}/);
    for (const k of ['a', 'b']) {
      const frames = rail.match(new RegExp(`@keyframes rail-still-${k} \\{\\s*0%, 100% \\{ ([^}]*) \\}`));
      // One frame for the whole run: nothing moves.
      expect(frames?.[1]).toBe('transform: scale(1.3); opacity: 1;');
    }
  });
});
