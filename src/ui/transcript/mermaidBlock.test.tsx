/**
 * @vitest-environment jsdom
 *
 * Mermaid fences drawn as diagrams (#289). Mermaid itself needs a layout
 * engine, so it is replaced here by a stand-in with its API; what is tested is
 * Albedo's side: the config it is given, the image it becomes, the fallbacks,
 * and the bar's two actions.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const fake = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: fake }));
vi.mock('../../lib/clipboard', () => ({ copyText: async () => true }));

const { Markdown } = await import('./MessageRow');
const { __resetMermaid, diagramKind, svgToImage, SECURE_KEYS } = await import('./mermaid');

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" id="x" width="100%" style="max-width: 212.5px;" viewBox="-8 -8 212.5 100"><text>deliver</text></svg>';
const SEQ = 'sequenceDiagram\n  deliver->>endpoint: POST';

function fence(code: string, lang = 'mermaid'): string {
  return '```' + lang + '\n' + code + '\n```';
}

beforeEach(() => {
  __resetMermaid();
  fake.initialize.mockReset();
  fake.render.mockReset();
  fake.render.mockImplementation(async () => ({ svg: SVG, diagramType: 'sequence' }));
});
afterEach(() => cleanup());

describe('a mermaid fence (#289)', () => {
  it('shows the code until the drawing is ready, then the drawing as an image', async () => {
    const { container } = render(<Markdown text={fence(SEQ)} />);
    // Readable at once: the code block it always was.
    expect(container.querySelector('.tx-pre-code')?.textContent).toContain('deliver->>endpoint');
    const img = await waitFor(() => {
      const found = container.querySelector('img.tx-mermaid-img');
      expect(found).not.toBeNull();
      return found as HTMLImageElement;
    });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(img.getAttribute('alt')).toBe('Sequence diagram');
    // Sized from the viewBox, so the row has its height before the image decodes.
    expect(img.getAttribute('width')).toBe('213');
    expect(img.getAttribute('height')).toBe('100');
    // Never inserted into the page as markup.
    expect(container.querySelector('svg text')).toBeNull();
    expect(container.querySelector('.tx-mermaid-kind')?.textContent).toBe('Sequence');
    expect(fake.render).toHaveBeenCalledWith(expect.stringMatching(/^albedo-mermaid-/), SEQ);
  });

  it('is drawn strict, without HTML labels, on Albedo’s theme, and a directive cannot change that', async () => {
    render(<Markdown text={fence(SEQ)} />);
    await waitFor(() => expect(fake.initialize).toHaveBeenCalled());
    const config = fake.initialize.mock.calls[0]![0];
    expect(config.securityLevel).toBe('strict');
    expect(config.htmlLabels).toBe(false);
    expect(config.startOnLoad).toBe(false);
    expect(config.theme).toBe('base');
    expect(config.themeVariables).toHaveProperty('primaryTextColor');
    for (const key of ['securityLevel', 'theme', 'themeVariables', 'themeCSS', 'htmlLabels', 'fontFamily', 'look', 'layout', 'arrowMarkerAbsolute', 'dompurifyConfig', 'legacyMathML', 'forceLegacyMathML', 'deterministicIds', 'deterministicIDSeed', 'handDrawnSeed']) {
      expect(config.secure).toContain(key);
    }
    expect(SECURE_KEYS).toContain('secure');
    // No neo look and no drop shadow: a grey no token chose.
    expect(config.look).toBe('classic');
    expect(config.themeVariables.dropShadow).toBe('none');
    // An edge label's ground is the well, opaque, not mermaid's 50% wash.
    expect(config.themeCSS).toMatch(/\.edgeLabel rect \{ opacity: 1; \}/);
    // One text size for every kind.
    expect(config.fontSize).toBe(14);
    expect(config.themeVariables.fontSize).toBe('14px');
    expect(config.sequence).toEqual({ actorFontSize: 14, messageFontSize: 14, noteFontSize: 14 });
  });

  it('keeps the code block’s copy column on the drawing, and uses the transcript’s own buttons', async () => {
    const { container } = render(<Markdown text={fence(SEQ)} />);
    await waitFor(() => expect(container.querySelector('img.tx-mermaid-img')).not.toBeNull());
    // Where it is on every code block: the frame's right end, full height.
    expect(container.querySelector('.tx-mermaid > .tx-copy-block')?.getAttribute('aria-label')).toBe('Copy');
    const buttons = [...container.querySelectorAll('.tx-mermaid-bar button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Source', 'Open in Window']);
    for (const b of buttons) expect(b.className).toBe('tx-btn');
  });

  it('a wide diagram is never drawn below 0.8 of its size; past that the figure scrolls', async () => {
    const { container } = render(<Markdown text={fence(SEQ)} />);
    const img = await waitFor(() => {
      const found = container.querySelector('img.tx-mermaid-img') as HTMLImageElement | null;
      expect(found).not.toBeNull();
      return found!;
    });
    expect(img.style.minWidth).toBe(`${Math.round(213 * 0.8)}px`);
  });

  it('Source shows the text as a code block shows it, and Diagram goes back', async () => {
    const { container, getByRole } = render(<Markdown text={fence(SEQ)} />);
    await waitFor(() => expect(container.querySelector('img.tx-mermaid-img')).not.toBeNull());
    fireEvent.click(getByRole('button', { name: 'Source' }));
    expect(container.querySelector('img.tx-mermaid-img')).toBeNull();
    const pre = container.querySelector('.tx-mermaid-source pre.tx-pre-code')!;
    expect(pre.textContent).toContain('deliver->>endpoint');
    // The language where a code block keeps it: a comment on a selected
    // passage reads it from the frame (PassageComments).
    expect(pre.closest('.tx-md-pre')?.querySelector('.tx-md-pre-lang')?.textContent).toBe('mermaid');
    // The one copy column, still at the frame's end.
    expect(container.querySelectorAll('.tx-copy-block')).toHaveLength(1);
    fireEvent.click(getByRole('button', { name: 'Diagram' }));
    expect(container.querySelector('img.tx-mermaid-img')).not.toBeNull();
    expect(container.querySelector('.tx-md-pre-lang')).toBeNull();
  });

  it('a fence that does not parse stays code, with the error under it', async () => {
    fake.render.mockImplementation(async () => {
      throw new Error('Parse error on line 2:\n...ver->>\n----^\nExpecting ACTOR');
    });
    const { container } = render(<Markdown text={fence('sequenceDiagram\n  deliver->>')} />);
    await waitFor(() => expect(container.querySelector('.tx-mermaid-error')).not.toBeNull());
    expect(container.querySelector('.tx-mermaid-error-head')?.textContent).toBe('Couldn’t draw this diagram');
    expect(container.querySelector('.tx-mermaid-error-text')?.textContent).toContain('Parse error on line 2');
    // Inside the code block's frame, under the code, which is still there;
    // the copy column belongs to the code, not the error.
    expect(container.querySelector('.tx-md-pre > .tx-mermaid-error')).not.toBeNull();
    expect(container.querySelector('.tx-mermaid-code > .tx-copy-block')).not.toBeNull();
    expect(container.querySelector('.tx-pre-code')?.textContent).toContain('deliver->>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('Open in Window shows it larger in a dialog; Escape closes it before the app sees it, and gives focus back', async () => {
    const { container, getByRole } = render(<Markdown text={fence(SEQ)} />);
    await waitFor(() => expect(container.querySelector('img.tx-mermaid-img')).not.toBeNull());
    const open = getByRole('button', { name: 'Open in Window' });
    open.focus();
    fireEvent.click(open);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toBe('Sequence diagram');
    expect(dialog.querySelector('.wt-modal-title')?.textContent).toBe('Sequence Diagram');
    expect(dialog.querySelector('img.tx-mermaid-img')).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    // The editor closes its file on Escape from a window listener of its own.
    const appSaw = vi.fn();
    window.addEventListener('keydown', appSaw);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    window.removeEventListener('keydown', appSaw);
    expect(appSaw).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it('draws the same text once, and leaves every other fence alone', async () => {
    const first = render(<Markdown text={fence(SEQ)} />);
    await waitFor(() => expect(first.container.querySelector('img')).not.toBeNull());
    first.unmount();
    const again = render(<Markdown text={fence(SEQ) + '\n\n' + fence('const a = 1;', 'ts')} />);
    // From the cache: drawn on the first frame, no second render.
    expect(again.container.querySelector('img.tx-mermaid-img')).not.toBeNull();
    expect(fake.render).toHaveBeenCalledTimes(1);
    expect(again.container.querySelectorAll('.tx-md-pre-lang')[0]?.textContent).toBe('ts');
  });

  it('a reader at the end of the transcript stays there when the drawing replaces the code', async () => {
    const scroll = document.createElement('div');
    scroll.className = 'tx-scroll';
    document.body.appendChild(scroll);
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => (scroll.querySelector('img') ? 600 : 400) });
    scroll.scrollTop = 100; // at the end
    const { container } = render(<Markdown text={fence(SEQ)} />, { container: scroll.appendChild(document.createElement('div')) });
    // The drawing (600) is taller than the code was (400).
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(scroll.scrollTop).toBe(600);
    scroll.remove();
  });
});

describe('svgToImage', () => {
  it('sizes the image from the viewBox and drops mermaid’s page styles', () => {
    const img = svgToImage(SVG)!;
    expect(img.width).toBe(213);
    expect(img.height).toBe(100);
    const text = decodeURIComponent(img.src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    expect(text).toContain('width="213"');
    expect(text).not.toContain('max-width');
  });

  it('refuses what is not an SVG with a size', () => {
    expect(svgToImage('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBeNull();
    expect(svgToImage('<div>no</div>')).toBeNull();
  });
});

describe('diagramKind', () => {
  it('names the common kinds and calls the rest a diagram', () => {
    expect(diagramKind('sequence')).toBe('Sequence');
    expect(diagramKind('flowchart-v2')).toBe('Flowchart');
    expect(diagramKind('stateDiagram')).toBe('State');
    expect(diagramKind('classDiagram')).toBe('Class');
    expect(diagramKind('er')).toBe('Entity Relationship');
    expect(diagramKind('sankey')).toBe('Diagram');
  });
});

describe('mermaid loads lazily', () => {
  // It is large: only the first diagram may bring it in, never startup.
  it('is imported dynamically, from one file, and nowhere statically', () => {
    const root = join(process.cwd(), 'src') + '/';
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const users = files.filter((f) => /from ['"]mermaid['"]|import\(['"]mermaid['"]\)/.test(readFileSync(f, 'utf8')));
    expect(users.map((f) => f.slice(root.length))).toEqual(['ui/transcript/mermaid.ts']);
    const src = readFileSync(users[0]!, 'utf8');
    expect(src).toMatch(/import\('mermaid'\)/);
    expect(src).not.toMatch(/^import [^;]*from 'mermaid'/m);
  });
});
