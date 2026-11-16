/**
 * The GitHub tools' surfaces (#427), at 4.5:1 on the grounds they are drawn
 * on, in every theme: the card asking to delete a posted comment (its quote
 * on --panel-inset, its delete button on --danger-soft, its notes and
 * disabled buttons on --prompt-bg), and a removed draft's line in Files ▸
 * Comments (--panel-chrome) and card in the diff (--panel). The CSS is read
 * too, so moving a rule onto another ground or dimming text with opacity
 * fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const card = readFileSync(new URL('./transcript/deletionCard.css', import.meta.url), 'utf8');
const touched = readFileSync(new URL('./touched.css', import.meta.url), 'utf8');
const comments = readFileSync(new URL('./editor/comments.css', import.meta.url), 'utf8');
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
  '--panel-inset': ['--text-strong', '--muted'],
  '--danger-soft': ['--danger', '--on-del-soft'],
  '--prompt-bg': ['--muted', '--faint', '--warn'],
  '--panel-chrome': ['--text', '--muted'],
  '--panel': ['--muted', '--text'],
};

describe('the GitHub tools’ surfaces (#427)', () => {
  for (const [theme, t] of Object.entries(themes)) {
    for (const [ground, inks] of Object.entries(TEXT)) {
      for (const ink of inks) {
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

  it('draw on the grounds measured here, with no opacity', () => {
    expect(card).toMatch(/\.gd-quote \{[^}]*background: var\(--panel-inset\)/);
    expect(card).toMatch(/\.gd-text \{[^}]*color: var\(--text-strong\)/);
    expect(card).toMatch(/\.gd-where \{[^}]*color: var\(--muted\)/);
    expect(card).toMatch(/\.btn\.gd-delete:not\(\[disabled\]\) \{[^}]*background: var\(--danger-soft\);[^}]*color: var\(--danger\)/);
    expect(touched).toMatch(/\.tf-comment-removed \{ background: var\(--panel-chrome\); \}/);
    expect(touched).toMatch(/\.tf-comment-removed \.tf-comment-body \{ color: var\(--muted\); \}/);
    expect(comments).toMatch(/\.ed-cmt-removed-text \{ color: var\(--muted\);/);
    // The rules only: the comment above them names what they avoid.
    expect(card.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/opacity|color-mix|rgba\(/);
  });
});
