/**
 * @vitest-environment jsdom
 *
 * Copy what is in backticks (#242): a code block always has a copy button at
 * its end; inline code has one at its end, always shown (#244), never a Tab
 * stop; a click copies the exact text and says so; a path chip keeps its own
 * click. Inline code's button is laid over the chip from outside the text
 * (#454, InlineCodeCopy.tsx): the strip under it is CSS, so these tests point
 * at a chip to get it, as a person does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const copied = vi.hoisted(() => ({ texts: [] as string[], ok: true }));
vi.mock('../../lib/clipboard', () => ({
  copyText: async (t: string) => {
    copied.texts.push(t);
    return copied.ok;
  },
}));

const { Markdown } = await import('./Markdown');
const { COPIED_MS } = await import('./CopyButton');

/**
 * jsdom does no layout: every element measures 0 x 0, and a chip that shows
 * nothing gets no button. Give the chips a box -- the wrap 100px wide, 20px
 * tall, its 20px strip on the right -- and everything else one around it.
 */
const STRIP_X = 290;
function layOut(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('tx-md-code-wrap')) return new DOMRect(200, 40, 100, 20);
    if (this.classList.contains('tx-md-code')) return new DOMRect(200, 40, 80, 20);
    return new DOMRect(0, 0, 1000, 800);
  });
}
/** The overlay button, wherever it is in the document. */
const overlay = () => document.querySelector<HTMLButtonElement>('.tx-copy-inline');

beforeEach(() => {
  copied.texts = [];
  copied.ok = true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('copy (#242)', () => {
  it('a code block copies its exact text, from a button at its end, reachable with Tab', async () => {
    const code = '! git push --force-with-lease origin feature-b\nsecond line';
    const { container } = render(<Markdown text={'```\n' + code + '\n```'} />);
    const button = container.querySelector('.tx-md-pre > .tx-copy-block') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Copy');
    expect(button.tabIndex).toBe(0);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(copied.texts).toEqual([code]);
    expect(button.getAttribute('data-done')).toBe('copied');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied');
  });

  it('inline code: pointing at a chip lays its copy button over it, not a Tab stop, and a click copies it', async () => {
    layOut();
    const { container } = render(<Markdown text={'keep `public static` as it is'} />);
    const wrap = container.querySelector('.tx-md-code-wrap')!;
    expect(wrap.querySelector('.tx-md-code')?.textContent).toBe('public static');
    // Nothing of the icon is in the text: no button, no status (#454).
    expect(wrap.querySelector('button, [role="status"]')).toBeNull();
    expect(overlay()).toBeNull();
    fireEvent.pointerOver(wrap.querySelector('.tx-md-code')!, { clientX: 210, clientY: 50 });
    const button = overlay()!;
    expect(button).not.toBeNull();
    expect(container.contains(button)).toBe(false);
    expect(button.parentElement).toBe(document.body);
    expect(button.tabIndex).toBe(-1);
    expect(button.getAttribute('aria-label')).toBe('Copy');
    // Over the strip: the wrap's last 20px, top to bottom.
    expect([button.style.left, button.style.top, button.style.height]).toEqual(['280px', '40px', '20px']);
    // The sentence's text is unchanged.
    expect(container.textContent).toBe('keep public static as it is');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(copied.texts).toEqual(['public static']);
    expect(button.getAttribute('data-done')).toBe('copied');
    expect(button.title).toBe('Copied');
    expect(document.querySelector('body > [role="status"]')?.textContent).toBe('Copied');
  });

  it('the button copies the chip it is over, and moves to the next one pointed at', async () => {
    layOut();
    const { container } = render(<Markdown text={'only `linkType` / `linkId` differ'} />);
    const [a, b] = [...container.querySelectorAll('.tx-md-code')];
    fireEvent.pointerOver(a!, { clientX: 210 });
    fireEvent.pointerOut(a!, { relatedTarget: b! });
    fireEvent.pointerOver(b!, { clientX: 210 });
    expect(document.querySelectorAll('.tx-copy-inline')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(overlay()!);
    });
    expect(copied.texts).toEqual(['linkId']);
  });

  it('a click on the button is never the row’s click', async () => {
    layOut();
    const onRow = vi.fn();
    const { container } = render(
      <div onClick={onRow}>
        <Markdown text={'run `npm test`'} />
      </div>,
    );
    fireEvent.pointerOver(container.querySelector('.tx-md-code')!, { clientX: 210 });
    await act(async () => {
      fireEvent.click(overlay()!);
    });
    expect(copied.texts).toEqual(['npm test']);
    expect(onRow).not.toHaveBeenCalled();
  });

  it('leaving the chip takes the button away; after a copy, once the tick has had its moment', async () => {
    vi.useFakeTimers();
    layOut();
    const { container } = render(<Markdown text={'run `npm test` now'} />);
    const code = container.querySelector('.tx-md-code')!;
    const p = container.querySelector('p')!;
    fireEvent.pointerOver(code, { clientX: 210 });
    fireEvent.pointerOut(code, { relatedTarget: p });
    expect(overlay()).toBeNull();

    fireEvent.pointerOver(code, { clientX: 210 });
    fireEvent.pointerOut(code, { relatedTarget: overlay() });
    expect(overlay()).not.toBeNull(); // onto the button: it stays
    await act(async () => {
      fireEvent.click(overlay()!);
    });
    fireEvent.pointerOut(overlay()!, { relatedTarget: p });
    expect(overlay()?.getAttribute('data-done')).toBe('copied');
    act(() => vi.advanceTimersByTime(COPIED_MS));
    expect(overlay()).toBeNull();
  });

  it('a press on the strip before the button is there still copies, and starts no selection', async () => {
    layOut();
    const { container } = render(<Markdown text={'run `npm test` now'} />);
    const wrap = container.querySelector<HTMLElement>('.tx-md-code-wrap')!;
    // The strip is the wrap itself (generated content is not a node).
    const down = fireEvent.mouseDown(wrap, { clientX: STRIP_X, clientY: 50 });
    expect(down).toBe(false); // default prevented: no text selection starts
    expect(overlay()).not.toBeNull();
    await act(async () => {
      fireEvent.click(wrap, { clientX: STRIP_X, clientY: 50 });
    });
    expect(copied.texts).toEqual(['npm test']);
    // A press on the code is the code's: nothing copied, nothing prevented.
    copied.texts = [];
    expect(fireEvent.mouseDown(wrap.querySelector('.tx-md-code')!, { clientX: 210 })).toBe(true);
    fireEvent.click(wrap.querySelector('.tx-md-code')!, { clientX: 210 });
    expect(copied.texts).toEqual([]);
  });

  it('released on the button that appeared under the press: copies once', async () => {
    layOut();
    const { container } = render(<Markdown text={'run `npm test` now'} />);
    const wrap = container.querySelector<HTMLElement>('.tx-md-code-wrap')!;
    fireEvent.mouseDown(wrap, { clientX: STRIP_X, clientY: 50 });
    await act(async () => {
      fireEvent.mouseUp(overlay()!);
    });
    expect(copied.texts).toEqual(['npm test']);
  });

  it('a path chip keeps its click: nothing of the copy icon is inside it', () => {
    layOut();
    const { container } = render(<Markdown text={'see `src/a.ts:12`'} />);
    const wrap = container.querySelector<HTMLElement>('.tx-md-code-wrap')!;
    const chip = wrap.querySelector('.tx-md-code-link')!;
    fireEvent.pointerOver(chip, { clientX: 210 });
    expect(chip.querySelector('.tx-copy')).toBeNull();
    expect(wrap.querySelector('.tx-copy')).toBeNull();
    expect(wrap.dataset.copy).toBe('src/a.ts:12');
    expect(overlay()).not.toBeNull();
  });

  it('in a prompt card inline code shows no icon, so pointing at it lays no button', () => {
    layOut();
    const { container } = render(
      <div className="tx-prompt">
        <Markdown text={'answer `yes` here'} />
      </div>,
    );
    fireEvent.pointerOver(container.querySelector('.tx-md-code')!, { clientX: 210 });
    fireEvent.mouseDown(container.querySelector('.tx-md-code-wrap')!, { clientX: STRIP_X });
    expect(overlay()).toBeNull();
  });

  it('says so when it could not copy, then goes back to the icon', async () => {
    vi.useFakeTimers();
    copied.ok = false;
    const { container } = render(<Markdown text={'```\nx\n```'} />);
    const button = container.querySelector('.tx-copy-block') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute('data-done')).toBe('failed');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Couldn’t copy');
    act(() => vi.advanceTimersByTime(COPIED_MS));
    expect(button.hasAttribute('data-done')).toBe(false);
  });
});
