/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { Markdown } from './MessageRow';

afterEach(cleanup);

describe('Markdown: nested lists', () => {
  it('renders a sub-list inside its parent item', () => {
    const { container } = render(<Markdown text={'- **Label:**\n  - x\n  - y\n- next'} />);
    const top = container.querySelector('.tx-md > ul.tx-md-list');
    expect(top).not.toBeNull();
    const items = top?.querySelectorAll(':scope > li') ?? [];
    expect(items).toHaveLength(2);
    const sub = items[0]?.querySelector(':scope > ul.tx-md-list');
    expect(sub?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(items[0]?.querySelector('strong')?.textContent).toBe('Label:');
    expect(items[1]?.querySelector('ul')).toBeNull();
  });

  it('gives an ordered list its start number, and none when it starts at 1', () => {
    const { container } = render(<Markdown text={'3. a\n4. b\n\ntext\n\n1. c'} />);
    const lists = container.querySelectorAll('ol.tx-md-list');
    expect(lists).toHaveLength(2);
    expect(lists[0]?.getAttribute('start')).toBe('3');
    expect(lists[1]?.hasAttribute('start')).toBe(false);
  });
});
