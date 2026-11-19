/**
 * @vitest-environment jsdom
 *
 * Copied text keeps inline code on its line (#452). #243 laid the code and
 * its copy icon out with `display: inline-flex`; a flex container's children
 * are blockified, and the plain text of a selection (⌘C, the selection bar's
 * Copy, a passage comment's quote: all `Selection.toString()`) breaks a line
 * before and after every block. Measured in Chrome and in WKWebView on a page
 * with the app's markup and CSS, a paragraph copied as
 *   "Clarification: \n<timestamp>\n in the request examples ..."
 * and, with inline boxes, as
 *   "Clarification: <timestamp> in the request examples ...".
 * jsdom does no layout, so `toString()` cannot show it here; what is checked
 * is the cause: with the app's real stylesheets loaded, nothing between the
 * paragraph and the code's text is laid out as anything but an inline box.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Markdown } from './Markdown';

/** The stylesheets that style a transcript paragraph and a prompt card, in the app's order. */
const FILES = ['../../styles.css', './transcript.css', './promptCard.css'];
const sheets = FILES.map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'));

/** A display a selection's text runs straight through: no line break before or after. */
const INLINE = new Set(['inline', 'inline-block']);

let style: HTMLStyleElement;
beforeEach(() => {
  style = document.createElement('style');
  style.textContent = sheets.join('\n');
  document.head.appendChild(style);
});
afterEach(() => {
  style.remove();
  cleanup();
});

/** Every element from the code's text up to (not including) its paragraph, with its computed display. */
function displaysUpTo(text: Node, stop: Element): string[] {
  const out: string[] = [];
  for (let el = text.parentElement; el && el !== stop; el = el.parentElement) {
    out.push(`${el.className || el.tagName}: ${getComputedStyle(el).display}`);
  }
  return out;
}

describe('inline code stays inline (#452)', () => {
  for (const [name, text] of [
    ['plain code', 'Clarification: `<timestamp>` is a placeholder; only `linkType` / `linkId` differ.'],
    ['a path chip', 'The handler lives in `src/server/handlers/OrderLinkResolverHandler.php` and runs once.'],
    ['a web address', 'See `https://example.com/docs/page` for the format.'],
  ] as const) {
    it(`${name}: no flex, grid or block box between the paragraph and the code's text`, () => {
      const { container } = render(<Markdown text={text} />);
      const p = container.querySelector('.tx-md-p')!;
      const codes = [...p.querySelectorAll('.tx-md-code')];
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        const displays = displaysUpTo(code.firstChild!, p);
        // The real stylesheet reached jsdom: the wrap is not left at the UA's `inline`.
        expect(displays.some((d) => d.startsWith('tx-md-code-wrap: '))).toBe(true);
        for (const d of displays) expect(INLINE.has(d.split(': ')[1]!), d).toBe(true);
      }
    });
  }

  it('the copy icon carries no text a selection could pick up', () => {
    const { container } = render(<Markdown text={'Run `npm test` first.'} />);
    const button = container.querySelector('.tx-copy-inline')!;
    expect(button.textContent).toBe('');
    expect(getComputedStyle(button).userSelect).toBe('none');
    expect(getComputedStyle(container.querySelector('.tx-copy-status')!).userSelect).toBe('none');
  });
});

describe('no stylesheet gives inline code a block-level display (#452)', () => {
  // Any rule, in any file, that could reach the wrap or the code: a later
  // `display: flex` on either brings the line breaks back.
  for (const [i, css] of sheets.entries()) {
    it(FILES[i]!, () => {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/\.tx-md-code(-wrap)?(?![-\w])/.test(m[1]!)) continue;
        const display = /(?:^|[;\s])display\s*:\s*([a-z-]+)/.exec(m[2]!)?.[1];
        if (display === undefined) continue;
        expect(['inline', 'inline-block', 'none'], `${m[1]!.trim()} { display: ${display} }`).toContain(display);
      }
    });
  }
});
