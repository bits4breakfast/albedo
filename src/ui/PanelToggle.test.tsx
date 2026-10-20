/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PanelToggle from './PanelToggle';

afterEach(cleanup);

describe('PanelToggle', () => {
  it('carries its state as pressed, and names what a click will do', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PanelToggle on={false} onToggle={onToggle} />);
    const off = screen.getByRole('button', { name: 'Show Files Column' });
    expect(off.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(off);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<PanelToggle on onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Hide Files Column' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says why a pinned column is not showing', () => {
    render(<PanelToggle on waiting onToggle={() => {}} />);
    expect(screen.getByRole('button').getAttribute('title')).toMatch(/no room at this width/);
  });
});
