/**
 * A PR's failing checks queued for Claude (#280): the "✗ CI failed" label in
 * the failing tone, above the message box (--panel, the head hovered on
 * --panel-hover) and in the Files pane's Waiting group (--panel, a row
 * hovered on --panel-hover), measured from styles.css in all three theme
 * blocks, and checked to still use those tokens. Step 2's details: the notes
 * --muted on --panel, a check's log tail --text on --panel-inset, and its
 * "… N more lines" --muted on --panel-inset.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('./ui/touched.css', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('./ui/transcript/transcript.css', import.meta.url), 'utf8');

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

describe('the queued CI failure (#280)', () => {
  it('draws with the tokens measured here', () => {
    expect(transcript).toMatch(/\.tx-waiting-ci-mark \{ color: var\(--danger\); font-weight: 600; \}/);
    expect(transcript).toMatch(/\.tx-waiting-ci-glyph \{ color: var\(--danger\); \}/);
    expect(transcript).toMatch(/\.tx-waiting-ci-conclusion \{ color: var\(--muted\); \}/);
    expect(list).toMatch(/\.tf-comment-ci-label \{[^}]*color: var\(--danger\)/);
    expect(list).toMatch(/\.tf-comment-drop:hover \{ color: var\(--text\); background: var\(--panel-hover\); \}/);
  });

  it('draws its details (step 2) with the tokens measured here', () => {
    expect(transcript).toMatch(/\.tx-waiting-ci-note \{[^}]*color: var\(--muted\)/);
    const log = /\.tx-waiting-ci-log \{([^}]*)\}/.exec(transcript)?.[1] ?? '';
    expect(log).toMatch(/background: var\(--panel-inset\);/);
    expect(log).toMatch(/color: var\(--text\);/);
    // Never dimmed after the token is chosen, never a wash over whatever is behind.
    expect(log).not.toMatch(/opacity|transparent/);
    expect(transcript).toMatch(/\.tx-waiting-ci-log-more \{ color: var\(--muted\); \}/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: text clears 4.5 on its grounds`, () => {
      const g = (k: string) => t.get(k)!;
      const text: Array<[string, string]> = [
        ['--danger', '--panel'],
        ['--danger', '--panel-hover'],
        ['--muted', '--panel'],
        ['--muted', '--panel-hover'],
        ['--text', '--panel-hover'],
        // Step 2: the log tail and what was cut from it.
        ['--text', '--panel-inset'],
        ['--muted', '--panel-inset'],
      ];
      for (const [fg, bg] of text) expect(ratio(g(fg), g(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

