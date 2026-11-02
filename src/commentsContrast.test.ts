/**
 * Review comments' states (#222): the Waiting and Sent chips, a sent card's
 * grey edge, the resolved trace and the Files pane's group labels, measured
 * from styles.css on the grounds they sit on, in all three theme blocks, and
 * checked to still use those tokens.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const cards = readFileSync(new URL('./ui/editor/comments.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('./ui/touched.css', import.meta.url), 'utf8');

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

describe('comment states (#222)', () => {
  it('draw with the tokens measured here', () => {
    expect(cards).toMatch(/\.ed-cmt-chip\[data-state='waiting'\] \{ background: var\(--accent-soft\); color: var\(--on-accent-soft\); \}/);
    expect(cards).toMatch(/\.ed-cmt-chip\[data-state='sent'\] \{ color: var\(--muted\); box-shadow: inset 0 0 0 1px var\(--border-strong\); \}/);
    expect(cards).toMatch(/\.ed-cmt\[data-state='sent'\] \{ border-left-color: var\(--border-strong\); \}/);
    expect(cards).toMatch(/\.ed-cmt-trace-mark \{ color: var\(--status-done\); \}/);
    expect(list).toMatch(/\.tf-comments-sub \{[^}]*color: var\(--muted\)/);
    // No ✓ on a state any more: it is Resolve's.
    expect(cards).not.toMatch(/ed-cmt-sent::before/);
    expect(list).not.toMatch(/tf-comment-sent::before/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: text clears 4.5 and edges 3 on their grounds`, () => {
      const g = (k: string) => t.get(k)!;
      const text: Array<[string, string]> = [
        ['--on-accent-soft', '--accent-soft'], // the Waiting chip
        ['--muted', '--panel'], // the Sent chip, the trace, the list's labels
        ['--muted', '--panel-hover'], // a list label under a hovered row's neighbour
        ['--muted', '--panel-raised'],
      ];
      for (const [fg, bg] of text) expect(ratio(g(fg), g(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      const ui: Array<[string, string]> = [
        ['--border-strong', '--panel'], // the Sent chip's outline, a sent card's edge
        ['--status-done', '--panel'], // the trace's ✓
      ];
      for (const [fg, bg] of ui) expect(ratio(g(fg), g(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }
});
