/**
 * The text #404 and #409 add, measured from styles.css in all three theme
 * blocks on the grounds it is drawn on, and checked to still use those
 * tokens: Send N on the composer's accent button (and its hover), the line
 * beside it on the message box's --panel-inset, To Send's Edit and Remove in
 * Files ▸ Comments on its section's --subcard and on --panel-hover (and
 * disabled, --faint on --subcard), and the Guide's Send N key, which takes
 * the button's own colour.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('./ui/touched.css', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('./ui/transcript/transcript.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('./guide/guide.css', import.meta.url), 'utf8');

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

describe('To Send and Send N (#404, #409)', () => {
  it('draw with the tokens measured here, never dimmed after the token is chosen', () => {
    // Send N keeps the round button's pair: its colour is not set again.
    expect(rule(transcript, '.tx-composer-send')).toMatch(/background: var\(--accent-btn\);[\s\S]*color: var\(--on-accent\);/);
    expect(rule(transcript, '.tx-composer-send[data-count]')).not.toMatch(/color|background|opacity/);
    expect(rule(transcript, '.tx-composer-send-key')).not.toMatch(/color|opacity/);
    expect(rule(transcript, '.tx-composer-sends')).toMatch(/color: var\(--muted\);/);
    expect(rule(transcript, '.tx-composer-box')).toMatch(/background: var\(--panel-inset\);/);
    const act = rule(list, '.tf-comment-act');
    expect(act).toMatch(/color: var\(--muted\);/);
    expect(act).not.toMatch(/opacity|background/);
    expect(list).toMatch(/\.tf-comment-act:disabled \{ color: var\(--faint\);/);
    expect(rule(list, '.tf-comments-send-key')).not.toMatch(/color|opacity/);
    expect(rule(guide, '.gd-btn-key')).not.toMatch(/color|opacity/);
    // The held group's why sits in the head, in its --muted.
    expect(rule(transcript, '.tx-queued-why')).not.toMatch(/color|opacity/);
    expect(rule(transcript, '.tx-queued-head')).toMatch(/color: var\(--muted\);/);
    // Files ▸ Comments sits on a --subcard.
    expect(list).toMatch(/background: var\(--subcard\);/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: text clears 4.5 on its grounds`, () => {
      const g = (k: string) => t.get(k)!;
      const text: Array<[string, string]> = [
        ['--on-accent', '--accent-btn'],
        ['--on-accent', '--accent-btn-hover'],
        // The line beside Send N, on the message box's ground.
        ['--muted', '--panel-inset'],
        // Files ▸ Comments: a section is a --subcard (touched.css), a hovered
        // control --panel-hover; disabled Edit and Remove are --faint.
        ['--muted', '--subcard'],
        ['--muted', '--panel-hover'],
        ['--text', '--panel-hover'],
        ['--faint', '--subcard'],
      ];
      for (const [fg, bg] of text) expect(ratio(g(fg), g(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
