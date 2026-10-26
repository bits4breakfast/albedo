/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Disclosure } from './Disclosure';
import { Disclosure as FromDiff } from './transcript/Diff';

afterEach(cleanup);

describe('Disclosure', () => {
  it('is one stroked chevron, rotated by a class when open', () => {
    const { container, rerender } = render(<Disclosure open={false} />);
    const caret = container.firstElementChild as HTMLElement;
    expect(caret.className).toBe('disc');
    expect(caret.getAttribute('aria-hidden')).toBe('true');
    const path = caret.querySelector('path')!;
    expect(path.getAttribute('fill')).toBe('none');
    expect(path.getAttribute('stroke')).toBe('currentColor');
    expect(path.getAttribute('stroke-linecap')).toBe('round');
    expect(path.getAttribute('stroke-linejoin')).toBe('round');

    rerender(<Disclosure open />);
    expect(caret.className).toBe('disc disc-open');
    expect(caret.querySelector('path')!.getAttribute('d')).toBe(path.getAttribute('d'));
  });

  it('drops its own hit area only when asked to sit inline', () => {
    const { container } = render(<Disclosure open inline />);
    expect((container.firstElementChild as HTMLElement).className).toBe('disc disc-open disc-inline');
  });

  it('is the same component the transcript imports', () => {
    expect(FromDiff).toBe(Disclosure);
  });
});
