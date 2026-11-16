/**
 * @vitest-environment jsdom
 *
 * ⌘↑ / ⌘↓ (#398) are bound on macOS only, so the list shows them there only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ShortcutsHelp from './ShortcutsHelp';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const as = (ua: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
const keys = () => Array.from(document.querySelectorAll('.shortcuts-row kbd'), (k) => k.textContent);

describe('ShortcutsHelp, macOS-only rows (#398)', () => {
  it('lists ⌘↑ / ⌘↓ on a Mac', () => {
    as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
    render(<ShortcutsHelp open onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(keys()).toEqual(expect.arrayContaining(['⌘↑', '⌘↓', '⌘[', '⌥⌘↓']));
  });

  it('leaves them out elsewhere, and keeps the rest', () => {
    as('Mozilla/5.0 (X11; Linux x86_64)');
    render(<ShortcutsHelp open onClose={() => {}} />);
    expect(keys()).not.toContain('⌘↑');
    expect(keys()).not.toContain('⌘↓');
    expect(keys()).toEqual(expect.arrayContaining(['⌘[', '⌥⌘↓']));
  });
});
