/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { openExternal } from '../../lib/openUrl';
import { parseInline } from './MessageRow';
import { LinkifiedText } from './Diff';

vi.mock('../../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view = (text: string) => render(<p>{parseInline(text)}</p>);

describe('transcript links', () => {
  it('makes a bare URL clickable and drops trailing punctuation', () => {
    view('Open https://linear.app/x/issue/ACME-1.');
    const link = screen.getByRole('link');
    expect(link.textContent).toBe('https://linear.app/x/issue/ACME-1');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith('https://linear.app/x/issue/ACME-1');
  });

  it('shows the real host beside a markdown label that hides it', () => {
    view('[docs](https://evil.example/login)');
    const link = screen.getByRole('link');
    expect(link.textContent).toBe('docs (evil.example)');
    expect(link.getAttribute('title')).toBe('https://evil.example/login');
  });

  it('does not repeat the host when the label is the URL itself', () => {
    view('[https://a.dev/x](https://a.dev/x)');
    expect(screen.getByRole('link').textContent).toBe('https://a.dev/x');
  });

  it('never makes a non-web link clickable', () => {
    view('[click](javascript:alert(1)) and [file](file:///etc/passwd) and [rel](./a.md)');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('links a URL that is alone in a code span, but not other code', () => {
    view('`https://a.dev/x` and `const x = 1`');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('links URLs in tool output', () => {
    render(<LinkifiedText text={'see https://a.dev/x\nsecond line'} />);
    expect(screen.getByRole('link').textContent).toBe('https://a.dev/x');
  });
});
