/**
 * @vitest-environment jsdom
 *
 * Syntax colour must not run across the lines a diff hides (#412).
 *
 * A diff used to highlight the shown lines of all its hunks as one text, so
 * a block comment opened at the end of one hunk and closed in the hidden
 * lines coloured the whole next hunk as a comment. With both whole texts (the
 * editor's Diff mode, the Guide, an Edit call) every row now takes its tokens
 * from its own line in the whole text; with only hunks (a `git diff` in the
 * transcript), each hunk is highlighted on its own.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Diff } from './Diff';
import { diffStrings } from '../../lib/diff';
import { peekTokens } from '../../lib/highlight';

afterEach(cleanup);

/** The `--shiki-light` colour of each token in the code cell reading exactly `text`. */
function colours(text: string): string[] {
  const cell = [...document.querySelectorAll<HTMLElement>('.tx-d-code')].find((el) => el.textContent === text);
  if (!cell) throw new Error(`no line reads ${JSON.stringify(text)}`);
  return [...cell.querySelectorAll<HTMLElement>('.tx-tok')].map(
    (t) => /--shiki-light:\s*([^;]+)/.exec(t.getAttribute('style') ?? '')?.[1]?.trim() ?? '',
  );
}

/** Wait until `text` has been tokenized into more than one coloured span. */
async function coloured(text: string): Promise<void> {
  await waitFor(() => expect(colours(text).filter((c) => c !== '').length).toBeGreaterThan(1), { timeout: 10_000 });
}

/** A line is in the comment colour throughout. */
function isComment(text: string, comment: string): boolean {
  const cs = colours(text).filter((c) => c !== '');
  return cs.length > 0 && cs.every((c) => c === comment);
}

/**
 * A comment opened just above the gap and closed inside it. The first hunk
 * ends on `/**`; the second starts on code after the hidden `*\/`.
 */
const OLD = [
  'const a = 1;',
  '/**',
  ' * one',
  ' * two',
  ' * three',
  ' */',
  'const b = 1;',
  'const c = 1;',
  'const d = 1;',
  'const e = 1;',
  'const f = 1;',
  'const g = 1;',
].join('\n');
const NEW = OLD.replace('const a = 1;', 'const a = 2;').replace('const g = 1;', 'const g = 2;');

/**
 * A comment opened in the gap and still open where the next hunk starts:
 * only the whole text can know these lines are a comment.
 */
const OLD_INSIDE = [
  'const a = 1;',
  '// note',
  'const c = 1;',
  'const d = 1;',
  'const e = 1;',
  '/*',
  ' x y',
  ' x z',
  ' x w',
  ' */',
  'const g = 1;',
].join('\n');
const NEW_INSIDE = OLD_INSIDE.replace('const a = 1;', 'const a = 2;').replace('const g = 1;', 'const g = 2;');

describe('diff highlighting across a hidden gap (#412)', () => {
  it('the fixtures have two hunks with the comment end hidden between them', () => {
    expect(diffStrings(OLD, NEW, 'x.ts').hunks).toHaveLength(2);
    expect(diffStrings(OLD_INSIDE, NEW_INSIDE, 'x.ts').hunks).toHaveLength(2);
  });

  it('only hunks known: the hunk after the gap is code, not comment', async () => {
    const diff = diffStrings(OLD, NEW, 'x.ts');
    render(<Diff diff={diff} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    const comment = colours('/**')[0] ?? '';
    expect(comment).not.toBe('');
    expect(isComment('const d = 1;', comment)).toBe(false);
    expect(isComment('const g = 2;', comment)).toBe(false);
    expect(isComment('const g = 1;', comment)).toBe(false);
  });

  it('whole texts known: hunks and the opened gap are coloured as in the file', async () => {
    const diff = diffStrings(OLD, NEW, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: OLD, newText: NEW }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    const comment = colours('/**')[0] ?? '';
    expect(isComment('const d = 1;', comment)).toBe(false);
    expect(isComment('const g = 2;', comment)).toBe(false);

    // The hidden lines: the rest of the comment, then code again.
    fireEvent.click(screen.getByRole('button', { name: /Unchanged Lines/ }));
    await waitFor(() => expect(colours(' */')).not.toHaveLength(0));
    await waitFor(() => expect(isComment(' * three', comment)).toBe(true), { timeout: 10_000 });
    expect(isComment(' */', comment)).toBe(true);
    expect(isComment('const b = 1;', comment)).toBe(false);
  });

  it('whole texts known: a hunk that starts inside a comment is coloured as one', async () => {
    const diff = diffStrings(OLD_INSIDE, NEW_INSIDE, 'x.ts');
    render(
      <Diff diff={diff} expand={{ oldText: OLD_INSIDE, newText: NEW_INSIDE }} layout="unified" contextPath={null} />,
    );
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    // The comment colour, from a line no mode can mistake.
    const comment = colours('// note')[0] ?? '';
    expect(comment).not.toBe('');
    await waitFor(() => expect(isComment(' x w', comment)).toBe(true), { timeout: 10_000 });
    expect(isComment(' x z', comment)).toBe(true);
    expect(isComment(' */', comment)).toBe(true);
    expect(isComment('const g = 2;', comment)).toBe(false);
  });

  it('split layout reads each side from its own whole text', async () => {
    const diff = diffStrings(OLD, NEW, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: OLD, newText: NEW }} layout="split" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const a = 1;');
    const comment = colours('/**')[0] ?? '';
    expect(isComment('const g = 1;', comment)).toBe(false);
    expect(isComment('const g = 2;', comment)).toBe(false);
  });
});

describe('diff highlighting: what stays as it was', () => {
  it('a diff with no gaps colours the same with or without the whole texts', async () => {
    const old = ['/**', ' * doc', ' */', 'const a = 1;', 'const b = "s";'].join('\n');
    const next = old.replace('const a = 1;', 'const a = 2;');
    const diff = diffStrings(old, next, 'x.ts');
    expect(diff.hunks).toHaveLength(1);

    const html = async (expand: { oldText: string; newText: string } | null): Promise<string> => {
      const { container, unmount } = render(<Diff diff={diff} expand={expand} layout="unified" contextPath={null} />);
      await coloured('const a = 2;');
      await coloured('const a = 1;');
      await coloured('const b = "s";');
      const out = container.querySelector('.tx-d-hunk')?.innerHTML ?? '';
      unmount();
      return out;
    };
    const hunks = await html(null);
    const whole = await html({ oldText: old, newText: next });
    expect(hunks).not.toBe('');
    expect(whole).toBe(hunks);
  });

  it('past the size cap, highlights the hunks on their own and never the whole texts', async () => {
    const filler = Array.from({ length: 2100 }, (_, i) => `const x${i} = ${i};`);
    const old = [...OLD.split('\n'), ...filler].join('\n');
    const next = [...NEW.split('\n'), ...filler].join('\n');
    const diff = diffStrings(old, next, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    const comment = colours('/**')[0] ?? '';
    expect(isComment('const d = 1;', comment)).toBe(false);
    expect(peekTokens(old, diff.lang)).toBeUndefined();
    expect(peekTokens(next, diff.lang)).toBeUndefined();
  });
});
