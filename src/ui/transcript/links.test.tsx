/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { openExternal } from '../../lib/openUrl';
import { codeSpanRef, parseInline } from './MessageRow';
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

describe('underscores inside words', () => {
  it('do not italicise a path, but _word_ still does', () => {
    const { container } = render(<p>{parseInline('/T/NSIRD_screencaptureui_pXCwuA/Shot.png and _this_')}</p>);
    const ems = container.querySelectorAll('em');
    expect(ems).toHaveLength(1);
    expect(ems[0]?.textContent).toBe('this');
  });
});

describe('file names in code spans', () => {
  it('opens a line range at its first line', () => {
    expect(codeSpanRef('src/Factory.php:64-75')).toEqual({ path: 'src/Factory.php', line: 64 });
    expect(codeSpanRef('Consumer.php:170-187')).toEqual({ path: 'Consumer.php', line: 170, bare: true });
  });

  it('links a bare file name, marked for lookup, and nothing that only looks like one', () => {
    expect(codeSpanRef('plan-v5-pr2.md')).toEqual({ path: 'plan-v5-pr2.md', line: null, bare: true });
    expect(codeSpanRef('src/a.ts')).toEqual({ path: 'src/a.ts', line: null });
    expect(codeSpanRef('console.log')).toBeNull();
    expect(codeSpanRef('npm run build')).toBeNull();
  });
});

