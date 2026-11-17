/**
 * The comments on a marked passage (#434): every text tier of the popover,
 * measured from styles.css on the ground it sits on, in all three theme
 * blocks, and checked to still use those tokens.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
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

/** The declarations of one rule, by its exact selector. */
function rule(selector: string): string {
  const at = transcript.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return transcript.slice(at, transcript.indexOf('}', at));
}

describe('the popover on a marked passage (#434)', () => {
  it('draws with the tokens measured here, and dims nothing with opacity', () => {
    expect(rule('.tx-cmt-pop')).toMatch(/background: var\(--panel\);/);
    expect(rule('.tx-cmt-pop-top')).toMatch(/color: var\(--muted\);/);
    expect(rule('.tx-cmt-pop-chip')).toMatch(/background: var\(--banner-bg\);[^}]*color: var\(--warn\);/);
    expect(rule('.tx-cmt-pop-text')).toMatch(/color: var\(--text-strong\);/);
    expect(rule('.tx-cmt-pop-act')).toMatch(/background: transparent;[^}]*color: var\(--accent\);/);
    expect(rule('.tx-cmt-pop-act:hover:not(:disabled)')).toMatch(/background: var\(--panel-hover\);/);
    expect(rule('.tx-cmt-pop-act:disabled')).toMatch(/color: var\(--faint\);/);
    const block = transcript.slice(transcript.indexOf('\n.tx-cmt-pop {'), transcript.indexOf('.tx-cmt-pop-act:disabled'));
    expect(block).not.toMatch(/opacity|color-mix|rgba?\(/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: every text tier clears 4.5 on its ground`, () => {
      const g = (k: string) => {
        const v = t.get(k);
        expect(v, `${name} ${k}`).toBeDefined();
        return v!;
      };
      const text: Array<[string, string]> = [
        ['--text-strong', '--panel'], // the comment
        ['--muted', '--panel'], // "Your comment"
        ['--warn', '--banner-bg'], // the To Send chip
        ['--accent', '--panel'], // Edit, Remove
        ['--accent', '--panel-hover'], // hovered
        ['--faint', '--panel'], // waiting on a send
        ['--text', '--panel-inset'], // the editor's field (ToSendEditor)
      ];
      for (const [fg, bg] of text) expect(ratio(g(fg), g(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
