/**
 * @vitest-environment jsdom
 *
 * Copy what is in backticks (#242): a code block always has a copy button at
 * its end; inline code has one at its end, always shown (#244), never a Tab
 * stop; a click copies the exact text and says so; a path chip keeps its own
 * click.
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

const { Markdown } = await import('./MessageRow');
const { COPIED_MS } = await import('./CopyButton');

beforeEach(() => {
  copied.texts = [];
  copied.ok = true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it('inline code has its own copy button after it, not a Tab stop', async () => {
    const { container } = render(<Markdown text={'keep `public static` as it is'} />);
    const wrap = container.querySelector('.tx-md-code-wrap')!;
    expect(wrap.querySelector('.tx-md-code')?.textContent).toBe('public static');
    const button = wrap.querySelector('.tx-copy-inline') as HTMLButtonElement;
    expect(button.tabIndex).toBe(-1);
    // The sentence's text is unchanged: the button has none.
    expect(container.textContent).toBe('keep public static as it is');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(copied.texts).toEqual(['public static']);
  });

  it('a path chip keeps its click: the copy button is a sibling, never inside it', () => {
    const { container } = render(<Markdown text={'see `src/a.ts:12`'} />);
    const wrap = container.querySelector('.tx-md-code-wrap')!;
    const chip = wrap.querySelector('.tx-md-code-link')!;
    expect(chip.querySelector('.tx-copy')).toBeNull();
    expect(wrap.querySelector(':scope > .tx-copy-inline')).not.toBeNull();
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
