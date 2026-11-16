/**
 * @vitest-environment jsdom
 *
 * A search marked in the one diff component (#413, the Review Guide's This
 * File): what it finds and in what order, every match highlighted and the
 * current one stronger, alongside syntax colour and word-level changes; a
 * folded run of unchanged lines opens by itself when it holds a match, and
 * folds again when the search closes; the rows drawn reach the current match.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { Diff, diffSearchMatches, findInLine, type DiffSearch } from './Diff';
import { composePieces } from './codeTokens';
import { diffStrings } from '../../lib/diff';

afterEach(cleanup);

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1));

// 40 lines; line 3 and line 30 change, so lines 7-26 fold between the two
// hunks and 34-40 after the last. "marker" is on line 15 (folded) and 38 (tail).
const OLD = lines(40, (i) => (i === 15 || i === 38 ? `line ${i} marker` : `line ${i}`)).join('\n');
const NEW = OLD.replace('line 3\n', 'line 3 Marker added\n').replace('line 30\n', 'line 30 changed\n');
const EXPAND = { oldText: OLD, newText: NEW };

function view(search: DiffSearch | null, layout: 'unified' | 'split' = 'unified'): { rerender: (s: DiffSearch | null) => void } {
  const diff = diffStrings(OLD, NEW, 'notes.txt');
  const el = (s: DiffSearch | null): ReactNode => (
    <Diff diff={diff} expand={EXPAND} layout={layout} head={false} contextPath={null} search={s} />
  );
  const r = render(el(search));
  return { rerender: (s) => r.rerender(el(s)) };
}

const hits = () => [...document.querySelectorAll('.tx-d-hit')].map((e) => e.textContent);
const current = () => [...document.querySelectorAll('.tx-d-hit-cur')].map((e) => e.closest('.tx-d-code')?.textContent);
const shownLine = (text: string) => [...document.querySelectorAll('.tx-d-code')].some((e) => e.textContent === text);

describe('findInLine', () => {
  it('is plain text, and case-insensitive unless the query has a capital', () => {
    expect(findInLine('A marker and a Marker', 'marker')).toEqual([
      [2, 8],
      [15, 21],
    ]);
    expect(findInLine('A marker and a Marker', 'Marker')).toEqual([[15, 21]]);
    // Not a pattern: the dot and the brackets are themselves.
    expect(findInLine('a.b axb [x]', 'a.b')).toEqual([[0, 3]]);
    expect(findInLine('a.b axb [x]', '[x]')).toEqual([[8, 11]]);
    expect(findInLine('anything', '')).toEqual([]);
  });
});

describe('diffSearchMatches', () => {
  it('finds changed, removed, context and folded lines, in the order the diff shows them', () => {
    const diff = diffStrings(OLD, NEW, 'notes.txt');
    const found = diffSearchMatches(diff, EXPAND, 'line 3');
    // Removed line 3 by its base number, then the added one, then the
    // unchanged lines 30-39 that start with "line 3" (line 30's old text is
    // removed, its new one added).
    expect(found.map((m) => `${m.side}:${m.line}`).slice(0, 2)).toEqual(['old:3', 'new:3']);
    expect(found.map((m) => `${m.side}:${m.line}`)).toContain('old:30');
    expect(found.map((m) => `${m.side}:${m.line}`)).toContain('new:30');
    const marker = diffSearchMatches(diff, EXPAND, 'marker');
    expect(marker.map((m) => [m.side, m.line, m.gap])).toEqual([
      ['new', 3, null],
      ['new', 15, 1],
      ['new', 38, 2],
    ]);
    // Without the whole texts, folded lines cannot be shown, so are not found.
    expect(diffSearchMatches(diff, null, 'marker').map((m) => m.line)).toEqual([3]);
  });

  it('keys a match by side, line and column, the same whatever else the diff shows', () => {
    const diff = diffStrings(OLD, NEW, 'notes.txt');
    const whole = diffSearchMatches(diff, EXPAND, 'marker');
    const firstHunkOnly = diffSearchMatches({ ...diff, hunks: diff.hunks.slice(0, 1) }, EXPAND, 'marker');
    expect(firstHunkOnly.map((m) => m.key)).toEqual(whole.map((m) => m.key));
  });
});

describe('composePieces with matches', () => {
  it('keeps the token colour and the word change on each piece, and splits at the match', () => {
    const tokens = [
      { content: 'let ', offset: 0, style: { '--shiki-light': '#a' } },
      { content: 'total', offset: 4, style: { '--shiki-light': '#b' } },
    ];
    const pieces = composePieces('let total', tokens, [{ text: 'let to', changed: false }, { text: 'tal', changed: true }], [
      { start: 2, end: 6, current: true },
    ]);
    expect(pieces.map((p) => [p.text, p.style['--shiki-light'], p.changed, p.hit ?? 0])).toEqual([
      ['le', '#a', false, 0],
      ['t ', '#a', false, 2],
      ['to', '#b', false, 2],
      ['tal', '#b', true, 0],
    ]);
  });

  it('is unchanged without matches', () => {
    const pieces = composePieces('abc', undefined, undefined, []);
    expect(pieces).toEqual([{ text: 'abc', style: {}, changed: false }]);
  });
});

describe('Diff with a search', () => {
  it('highlights every match, the current one stronger', () => {
    view({ query: 'marker', current: 'n:15:8' });
    expect(hits()).toEqual(['Marker', 'marker', 'marker']);
    expect(current()).toEqual(['line 15 marker']);
  });

  it('opens a folded run that holds a match, says so, and leaves the others folded', () => {
    view({ query: 'line 15', current: null });
    expect(shownLine('line 15 marker')).toBe(true);
    expect(screen.getByRole('button', { name: /20 Unchanged Lines · opened: 1 match inside/ }).getAttribute('aria-expanded')).toBe('true');
    // The run after the last hunk has no match: still folded.
    expect(shownLine('line 40')).toBe(false);
    expect(screen.getByRole('button', { name: '7 Unchanged Lines' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('folds the run again when the search closes', () => {
    const v = view({ query: 'line 15', current: null });
    expect(shownLine('line 15 marker')).toBe(true);
    v.rerender(null);
    expect(shownLine('line 15 marker')).toBe(false);
    expect(hits()).toEqual([]);
  });

  it('lets the reader fold a run the search opened, but keeps the current match’s open', () => {
    const v = view({ query: 'marker', current: 'n:3:12' });
    const bar = screen.getByRole('button', { name: /20 Unchanged Lines/ });
    fireEvent.click(bar);
    expect(shownLine('line 15 marker')).toBe(false);
    expect(bar.textContent).toContain('1 match inside');
    v.rerender({ query: 'marker', current: 'n:15:8' });
    expect(shownLine('line 15 marker')).toBe(true);
  });

  it('marks a split diff’s unchanged rows on both halves and a removed row on the left', () => {
    view({ query: 'line 30', current: null }, 'split');
    const left = [...document.querySelectorAll('.tx-d-pair > .tx-d-half:first-child .tx-d-hit')];
    const right = [...document.querySelectorAll('.tx-d-pair > .tx-d-half:last-child .tx-d-hit')];
    expect(left.map((e) => e.closest('.tx-d-code')?.textContent)).toContain('line 30');
    expect(right.map((e) => e.closest('.tx-d-code')?.textContent)).toContain('line 30 changed');
    expect(right.map((e) => e.closest('.tx-d-code')?.textContent)).not.toContain('line 30');
  });

  it('draws as many rows as the current match needs', () => {
    // 400 changed lines: past the first 320 rows the diff stops drawing.
    const old = lines(400, (i) => `row ${i}`).join('\n');
    const now = lines(400, (i) => (i === 390 ? `row ${i} needle!` : `row ${i}!`)).join('\n');
    const diff = diffStrings(old, now, 'big.txt');
    const el = (s: DiffSearch | null) => <Diff diff={diff} expand={{ oldText: old, newText: now }} layout="unified" head={false} contextPath={null} search={s} />;
    const r = render(el(null));
    expect(shownLine('row 390 needle!')).toBe(false);
    r.rerender(el({ query: 'needle', current: 'n:390:8' }));
    expect(shownLine('row 390 needle!')).toBe(true);
    expect(current()).toEqual(['row 390 needle!']);
  });
});
