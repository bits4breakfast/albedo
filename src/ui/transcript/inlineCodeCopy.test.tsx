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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { COPY_GLYPH_PATH, COPY_GLYPH_RECT, TICK_GLYPH_PATH } from './CopyButton';

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
  vi.restoreAllMocks();
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

  it('the copy button carries no text a selection could pick up', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20));
    const { container } = render(<Markdown text={'Run `npm test` first.'} />);
    fireEvent.pointerOver(container.querySelector('.tx-md-code')!, { clientX: 10 });
    const button = document.querySelector('.tx-copy-inline')!;
    expect(button.textContent).toBe('');
    expect(getComputedStyle(button).userSelect).toBe('none');
    expect(getComputedStyle(document.querySelector('.tx-copy-status')!).userSelect).toBe('none');
  });
});

/**
 * A triple click selects the whole paragraph (#454). Measured in Chrome and
 * in WKWebView, a triple click's paragraph ends at any positioned element
 * inside it: #243's per-chip `<button>` and its `sr-only` status span (both
 * absolutely positioned) made "Clarification: `<timestamp>` in the request
 * examples ..." select only up to the first chip. A positioned box is not a
 * thing jsdom can triple-click, so what is checked is the cause: with the
 * real stylesheets, nothing inside a block of prose is a button, a live
 * region, or positioned out of the flow -- before a chip is pointed at, while
 * its button shows, and after it has copied.
 */
describe('nothing in the text ends a triple click’s paragraph (#454)', () => {
  const TEXT = [
    'Clarification: `<timestamp>` in the request examples is a placeholder; only `linkType` / `linkId` differ.',
    '## A heading with `config.json` and `b` inside',
    '- First item with `config.json` inside.\n- Second `a` `b` item.',
    'The handler lives in `src/server/handlers/OrderLinkResolverHandler.php` and runs once, see `https://example.com/x`.',
  ].join('\n\n');
  const BLOCKS = 'p, li, .tx-md-h';

  function offenders(root: Element): string[] {
    const out: string[] = [];
    for (const block of root.querySelectorAll(BLOCKS)) {
      for (const el of block.querySelectorAll('*')) {
        const what = `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`;
        // A path chip or a web address is a span with role=link: inline, and
        // measured not to split the paragraph. A button or a live region is
        // what #243 put there.
        if (el.matches('button, [role="status"], [aria-live]')) out.push(`${what}: a button or live region`);
        const position = getComputedStyle(el).position;
        if (position === 'absolute' || position === 'fixed') out.push(`${what}: position ${position}`);
      }
    }
    return out;
  }

  it('in a paragraph, a heading and a list item, with one chip and with several', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20));
    const { container } = render(<Markdown text={TEXT} />);
    expect(container.querySelectorAll('.tx-md-code-wrap').length).toBeGreaterThan(6);
    // The real stylesheet reached jsdom: the wrap computes as it does in the app.
    expect(getComputedStyle(container.querySelector('.tx-md-code-wrap')!).position).toBe('relative');
    expect(offenders(container)).toEqual([]);

    fireEvent.pointerOver(container.querySelector('.tx-md-code')!, { clientX: 10 });
    const button = document.querySelector('.tx-copy-inline')!;
    expect(button).not.toBeNull();
    // Where it is: outside the Markdown altogether, positioned against the viewport.
    expect(container.contains(button)).toBe(false);
    expect(getComputedStyle(button).position).toBe('fixed');
    expect(offenders(container)).toEqual([]);

    fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 0));
    expect(offenders(container)).toEqual([]);
  });

  it('in a prompt card too', () => {
    const { container } = render(
      <div className="tx-prompt">
        <Markdown text={TEXT} />
      </div>,
    );
    expect(offenders(container)).toEqual([]);
  });
});

describe('the strip draws the same glyphs as the button had (#454)', () => {
  const tx = sheets[1]!;
  const url = (name: string) => decodeURIComponent(new RegExp(`${name}: url\\("data:image/svg\\+xml,([^"]+)"\\)`).exec(tx)![1]!);

  it('the copy icon: CopyGlyph’s square and path', () => {
    const svg = url('--tx-copy-glyph');
    const r = COPY_GLYPH_RECT;
    expect(svg).toContain(`<rect width='${r.width}' height='${r.height}' x='${r.x}' y='${r.y}' rx='${r.rx}'/>`);
    expect(svg).toContain(`<path d='${COPY_GLYPH_PATH}'/>`);
    expect(svg).toContain("viewBox='0 0 24 24'");
    expect(svg).toContain("stroke-width='2' stroke-linecap='round' stroke-linejoin='round'");
  });

  it('the tick: TickGlyph’s path', () => {
    const svg = url('--tx-tick-glyph');
    expect(svg).toContain(`<path d='${TICK_GLYPH_PATH}'/>`);
    expect(svg).toContain("viewBox='0 0 16 16'");
    expect(svg).toContain("stroke-width='1.6'");
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
