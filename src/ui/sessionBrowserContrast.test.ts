/**
 * Past Sessions' Try Again link (#395), drawn in the warning on --banner-bg:
 * enabled in --banner-text, disabled in --faint, both at 4.5:1 in every
 * theme. The CSS is read too, so a disabled state that falls back to .btn's,
 * or is dimmed with opacity, fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const sb = readFileSync(new URL('./sessionbrowser.css', import.meta.url), 'utf8');
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

/** The declarations of the rule whose selector list starts with `selector`. */
function rule(selector: string): string {
  const at = sb.indexOf(`${selector},`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sb.slice(sb.indexOf('{', at) + 1, sb.indexOf('}', at));
}

describe('Try Again in the Past Sessions warning', () => {
  it('has a disabled state of its own, by token, outranking its :hover rule', () => {
    expect(sb).toMatch(/\.sb-warn \{[^}]*background: var\(--banner-bg\)/);
    expect(rule('.sb-warn .btn.sb-warn-action')).toMatch(/color: var\(--banner-text\)/);
    const disabled = rule('.sb-warn .btn.sb-warn-action[disabled]');
    expect(disabled).toMatch(/color: var\(--faint\)/);
    expect(sb).toContain('.sb-warn .btn.sb-warn-action[disabled]:hover');
    expect(sb.slice(sb.indexOf('.sb-warn .btn.sb-warn-action'))).not.toMatch(/opacity\s*:/);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`clears 4.5:1 on --banner-bg, enabled and disabled, ${name}`, () => {
      for (const fg of ['--banner-text', '--faint']) {
        expect(ratio(t.get(fg)!, t.get('--banner-bg')!), fg).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
