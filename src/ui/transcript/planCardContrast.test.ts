/**
 * #272: the plan in the "waiting on you" card, in every theme. Text 4.5:1 and
 * marks (the underline, the pin's disc, the suggested option's edge) 3:1, on
 * the grounds they are drawn on: the document's --panel, the card's
 * --prompt-bg, a marked passage's --accent-soft(-strong), a pin's and Send's
 * --accent-btn. The CSS is read too, so moving a rule onto another token or
 * ground, or dimming it with opacity, fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const card = readFileSync(new URL('./promptCard.css', import.meta.url), 'utf8');
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
const themes = {
  light,
  // A dark block overrides; anything it does not name is the light value.
  'dark (system)': new Map([...light, ...tokensIn(DARK_MEDIA, DARK_ATTR)]),
  'dark (chosen)': new Map([...light, ...tokensIn(DARK_ATTR, css.length)]),
};

/** The body of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = card.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return card.slice(at, card.indexOf('}', at));
}

const TEXT: Array<[string, string, string]> = [
  // The document, on --panel.
  ['document text', '--text', '--panel'],
  ['document headings', '--text-strong', '--panel'],
  ['document note, comment quote', '--muted', '--panel'],
  ['document folder, key hint', '--faint', '--panel'],
  ['Open', '--accent', '--panel'],
  ['Open, hovered', '--accent', '--panel-hover'],
  ['Comment button, hovered', '--text', '--panel-hover'],
  // A marked passage: drawn --text-strong whatever its token was.
  ['marked passage', '--text-strong', '--accent-soft'],
  ['passage being commented on', '--text-strong', '--accent-soft-strong'],
  // Pins and Send.
  ['pin number', '--on-accent', '--accent-btn'],
  ['Send', '--on-accent', '--accent-btn'],
  ['Send, hovered', '--on-accent', '--accent-btn-hover'],
  // The card's ground: the tray, Show All, the time waited.
  ['tray head', '--warn', '--prompt-bg'],
  ['tray comment', '--text', '--prompt-bg'],
  ['tray quote, Edit, ✕', '--muted', '--prompt-bg'],
  ['tray quote, hovered', '--muted', '--panel-hover'],
  ['disabled Edit, time waited', '--faint', '--prompt-bg'],
  ['Show All', '--accent', '--prompt-bg'],
  ['question', '--text', '--prompt-bg'],
  // The comment box's field and the options.
  ['comment field', '--text', '--panel-inset'],
  ['comment placeholder', '--faint', '--panel-inset'],
];

const MARKS: Array<[string, string, string]> = [
  ['passage underline', '--accent', '--accent-soft'],
  ['passage underline, being commented on', '--accent', '--accent-soft-strong'],
  ['pin disc in the document', '--accent-btn', '--panel'],
  ['pin disc in the tray', '--accent-btn', '--prompt-bg'],
  ['suggested option edge', '--accent', '--panel-inset'],
  ['comment box edge', '--accent', '--panel'],
];

describe('the plan card’s contrast (#272)', () => {
  for (const [name, t] of Object.entries(themes)) {
    it(`text clears 4.5:1 and marks 3:1, ${name}`, () => {
      for (const [what, fg, bg] of TEXT) {
        expect(ratio(t.get(fg)!, t.get(bg)!), `${what}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const [what, fg, bg] of MARKS) {
        expect(ratio(t.get(fg)!, t.get(bg)!), `${what}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('the rules use those tokens, on those grounds', () => {
    expect(rule('.pc-doc')).toMatch(/background: var\(--panel\);/);
    expect(rule('::highlight(albedo-plan-comment)')).toMatch(/background-color: var\(--accent-soft\);/);
    expect(rule('::highlight(albedo-plan-comment)')).toMatch(/color: var\(--text-strong\);/);
    expect(rule('::highlight(albedo-plan-comment)')).toMatch(/text-decoration: underline 2px var\(--accent\);/);
    expect(rule('::highlight(albedo-plan-comment-pending)')).toMatch(/background-color: var\(--accent-soft-strong\);/);
    expect(rule('.pc-pin')).toMatch(/background: var\(--accent-btn\);[\s\S]*color: var\(--on-accent\);/);
    expect(rule('.pc-send')).toMatch(/background: var\(--accent-btn\);/);
    expect(rule('.pc-tray-head')).toMatch(/color: var\(--warn\);/);
    expect(rule('.pc-more')).toMatch(/color: var\(--accent\);/);
    expect(rule('.pc-option-suggested')).toMatch(/border-color: var\(--accent\);/);
    // The question is not bold any more.
    expect(card).toMatch(/\.pc-q \{ font-weight: 400;/);
  });

  it('nothing is dimmed with opacity, mixed with transparent, or given an alpha', () => {
    expect(card).not.toMatch(/opacity\s*:/);
    expect(card).not.toMatch(/color-mix\(/);
    expect(card).not.toMatch(/rgba?\(/);
  });
});
