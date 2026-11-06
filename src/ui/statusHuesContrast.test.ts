/**
 * The status hues (#276), parsed from every theme block of styles.css.
 *
 * Two tiers per group. Text (--status-running, -blocked, -review, -done): a
 * label or word in its group's hue, 4.5:1 on the worst flat ground and on
 * every tint such text sits on. Glyph (-fill, -edge, -ink): the list's dots
 * draw their ring in the -edge and whatever is filled inside in the -fill,
 * so a dot and the rail's circle are the same colours
 * (taskRailContrast.test.ts measures those).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('./tasklist.css', import.meta.url), 'utf8');

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

const TEXT = ['--status-running', '--status-blocked', '--status-review', '--status-done'];
/** --panel-raised first (CLAUDE.md, Contrast rule 1), then every other ground and tint. */
const TEXT_GROUNDS = [
  '--panel-raised', '--panel-active', '--panel-hover', '--panel-chrome', '--panel', '--bg', '--subcard',
  '--row-selected', '--accent-soft', '--accent-soft-strong', '--row-blocked', '--row-blocked-hover',
];
const GROUPS = ['blocked', 'running', 'review', 'reviewing', 'idle', 'done'];

describe('status hues (#276)', () => {
  it('every block defines every status token, and the two dark blocks agree', () => {
    const own = (from: number, to: number) => tokensIn(from, to);
    const sys = own(DARK_MEDIA, DARK_ATTR);
    const chosen = own(DARK_ATTR, css.length);
    for (const g of GROUPS) {
      for (const part of ['fill', 'edge', 'ink']) {
        const k = `--status-${g}-${part}`;
        expect(light.get(k), `light ${k}`).toBeDefined();
        expect(sys.get(k), `dark (system) ${k}`).toBeDefined();
        expect(chosen.get(k), k).toBe(sys.get(k));
      }
    }
    for (const k of TEXT) {
      expect(light.get(k), k).toBeDefined();
      expect(chosen.get(k), k).toBe(sys.get(k));
    }
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: the text tier clears 4.5 on --panel-raised and on every tint`, () => {
      for (const k of TEXT) {
        for (const g of TEXT_GROUNDS) {
          expect(ratio(t.get(k)!, t.get(g)!), `${name} ${k} on ${g}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it('the list’s dots ring in the -edge and fill with the -fill', () => {
    const rule = (sel: string) => {
      const i = css.indexOf(`${sel} {`);
      expect(i, sel).toBeGreaterThan(-1);
      return css.slice(i, css.indexOf('}', i));
    };
    expect(rule(".status-dot[data-status='idle']")).toContain('border-color: var(--status-idle-edge)');
    expect(rule(".status-dot[data-status='done']")).toMatch(/border-color: var\(--status-done-edge\); background: var\(--status-done-fill\)/);
    expect(rule(".status-dot[data-status='review']")).toContain('var(--status-review-edge)');
    expect(rule(".status-dot[data-status='review']::after")).toContain('background: var(--status-review-fill)');
    expect(rule(".status-dot[data-status='reviewing']")).toContain('var(--status-reviewing-edge)');
    expect(rule(".status-dot[data-status='reviewing']::after")).toContain('background: var(--status-reviewing-fill)');
    expect(rule(".status-dot[data-status='running']")).toContain('border-color: var(--status-running-edge)');
    expect(rule(".status-dot[data-status='running']::after")).toContain('background: var(--status-running-fill)');
    expect(rule(".status-dot[data-status='blocked']")).toMatch(/border-color: var\(--status-blocked-edge\);\s*background: var\(--status-blocked-fill\);/);
  });

  it('labels take the text tier of their group', () => {
    expect(list).toMatch(/\.group-label\[data-tone='blocked'\] \{ color: var\(--status-blocked\); \}/);
    expect(list).toMatch(/\.group-label\[data-tone='review'\] \{ color: var\(--status-review\); \}/);
  });

  it('context meters keep their warning colour, which is not a task status', () => {
    expect(css).toMatch(/\.ctx\[data-level='warn'\] \.ctx-text \{ color: var\(--warn\); \}/);
    expect(css).toMatch(/\.ctx\[data-level='warn'\] \.ctx-fill \{ background: var\(--warn\); \}/);
    expect(css).not.toMatch(/data-level='warn'[^{]*\{[^}]*--status-blocked/);
  });
});
