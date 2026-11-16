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
import { cacheStats, peekLineTokens } from '../../lib/highlight';

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

  it('past the line cap, highlights the hunks on their own and never the whole texts', async () => {
    const filler = Array.from({ length: 3100 }, (_, i) => `const x${i} = ${i};`);
    const old = [...OLD_INSIDE.split('\n'), ...filler].join('\n');
    const next = [...NEW_INSIDE.split('\n'), ...filler].join('\n');
    const diff = diffStrings(old, next, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    // Per hunk, the hunk that starts inside the comment cannot know it.
    const comment = colours('// note')[0] ?? '';
    expect(isComment(' x w', comment)).toBe(false);
    expect(peekLineTokens(old, diff.lang)).toBeUndefined();
    expect(peekLineTokens(next, diff.lang)).toBeUndefined();
  });

  it('past the character cap, highlights the hunks on their own (one huge hidden line)', async () => {
    const huge = `const s = "${'v'.repeat(310_000)}";`;
    // Below the last hunk's context, so only the whole-text path would read it.
    const pad = 'const p1 = 1;\nconst p2 = 2;\nconst p3 = 3;\nconst p4 = 4;';
    const old = `${OLD_INSIDE}\n${pad}\n${huge}`;
    const next = `${NEW_INSIDE}\n${pad}\n${huge}`;
    const diff = diffStrings(old, next, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    const comment = colours('// note')[0] ?? '';
    expect(isComment(' x w', comment)).toBe(false);
    expect(peekLineTokens(old, diff.lang)).toBeUndefined();
  });

  it('a diff of many hunks takes one cache entry a side, not one a hunk', async () => {
    const old = Array.from({ length: 200 }, (_, i) => `const k${i} = ${i};`);
    const next = old.map((l, i) => (i % 20 === 0 ? l.replace('= ', '= 1 + ') : l));
    const diff = diffStrings(old.join('\n'), next.join('\n'), 'many.ts');
    expect(diff.hunks.length).toBeGreaterThanOrEqual(10);
    const before = cacheStats().entries;
    render(<Diff diff={diff} layout="unified" contextPath={null} />);
    await coloured('const k0 = 1 + 0;');
    await coloured('const k0 = 0;');
    expect(cacheStats().entries - before).toBeLessThanOrEqual(2);
  });
});

describe('diff highlighting with the whole texts: the edges (#412)', () => {
  it('an opened gap whose old and new numbering drift colours each row from its own text', async () => {
    // Hunk 2 adds five lines and is hidden, as the Guide's restrictDiff does:
    // inside the gap the old numbers point five lines away from the text shown.
    const tail = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? `// c${i}` : `let v${i} = ${i};`));
    const oldLines = ['const a = 1;', ...Array.from({ length: 9 }, (_, i) => `const p${i} = ${i};`), 'const m = 1;', ...tail, 'const z = 1;'];
    const newLines = [...oldLines];
    newLines[0] = 'const a = 2;';
    newLines.splice(11, 0, ...Array.from({ length: 5 }, (_, i) => `const n${i} = ${i};`));
    newLines[newLines.length - 1] = 'const z = 2;';
    const old = oldLines.join('\n');
    const next = newLines.join('\n');
    const full = diffStrings(old, next, 'x.ts');
    expect(full.hunks).toHaveLength(3);
    const diff = { ...full, hunks: [full.hunks[0]!, full.hunks[2]!] };
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const z = 2;');

    fireEvent.click(screen.getAllByRole('button', { name: /Unchanged Lines/ })[0]!);
    const comment = '// c0';
    await waitFor(() => expect(colours(comment)).not.toHaveLength(0));
    const commentColour = colours(comment)[0] ?? '';
    const gapRows = [...document.querySelectorAll<HTMLElement>('.tx-d-code')]
      .map((el) => el.textContent ?? '')
      .filter((t) => /^(\/\/ c|let v|const n)/.test(t));
    expect(gapRows.length).toBeGreaterThan(5);
    await waitFor(() => {
      for (const t of gapRows) expect([t, isComment(t, commentColour)]).toEqual([t, t.startsWith('//')]);
    });
  });

  it('split: a context row is coloured by its own side, old on the left and new on the right', async () => {
    const old = ['/*', 'x = 1;', '*/', 'const y = 1;'].join('\n');
    const next = ['//', 'x = 1;', '*/', 'const y = 2;'].join('\n');
    const diff = diffStrings(old, next, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="split" contextPath={null} />);
    await coloured('const y = 2;');
    await coloured('const y = 1;');
    const cells = () => [...document.querySelectorAll<HTMLElement>('.tx-d-code')].filter((el) => el.textContent === 'x = 1;');
    expect(cells()).toHaveLength(2);
    const comment = colours('//')[0] ?? '';
    const tok = (el: HTMLElement) =>
      [...el.querySelectorAll<HTMLElement>('.tx-tok')].map((t) => /--shiki-light:\s*([^;]+)/.exec(t.getAttribute('style') ?? '')?.[1]?.trim() ?? '');
    await waitFor(() => expect(tok(cells()[0]!).every((c) => c === comment)).toBe(true));
    expect(tok(cells()[1]!).some((c) => c !== comment)).toBe(true);
  });

  it('the gap after the last hunk is coloured as in the file once opened', async () => {
    const old = ['const a = 1;', '// note', 'const b = 1;', '/*', ' q r', ' q s', ' */', 'const z = 1;'].join('\n');
    const next = old.replace('const a = 1;', 'const a = 2;');
    const diff = diffStrings(old, next, 'x.ts');
    expect(diff.hunks).toHaveLength(1);
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    // Only as far as the last line the hunk shows, until the gap below opens.
    expect(peekLineTokens(next, diff.lang)).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /Unchanged Lines/ }));
    const comment = colours('// note')[0] ?? '';
    await waitFor(() => expect(isComment(' q r', comment)).toBe(true), { timeout: 10_000 });
    expect(isComment(' */', comment)).toBe(true);
    await waitFor(() => expect(colours('const z = 1;').filter((c) => c !== '').length).toBeGreaterThan(1));
    expect(isComment('const z = 1;', comment)).toBe(false);
  });

  it('CRLF texts stay on the whole-text path', async () => {
    const old = OLD_INSIDE.split('\n').join('\r\n');
    const next = NEW_INSIDE.split('\n').join('\r\n');
    const diff = diffStrings(old, next, 'x.ts');
    render(<Diff diff={diff} expand={{ oldText: old, newText: next }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const g = 2;');
    const comment = colours('// note')[0] ?? '';
    await waitFor(() => expect(isComment(' x w', comment)).toBe(true), { timeout: 10_000 });
    expect(isComment('const g = 2;', comment)).toBe(false);
  });

  it('whole texts that do not match the rows are not used to colour them', async () => {
    const diff = diffStrings(OLD, NEW, 'x.ts');
    // Same shape, but the line a hunk shows as code is a comment here.
    const lie = (t: string) => t.replace('const d = 1;', '// const d = 1;');
    render(<Diff diff={diff} expand={{ oldText: lie(OLD), newText: lie(NEW) }} layout="unified" contextPath={null} />);
    await coloured('const a = 2;');
    await coloured('const d = 1;');
    const comment = colours('/**')[0] ?? '';
    expect(isComment('const d = 1;', comment)).toBe(false);
  });
});
