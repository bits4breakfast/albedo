/**
 * @vitest-environment jsdom
 *
 * Select lines in a diff, then comment (#222): which rows a selection
 * covers, the Comment button and ⌥⌘M at the selection, a deleted-only
 * selection saying why, and Shift-click on a + extending from the last.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Diff, DiffAnnotationsContext, selectedDiffRows, type DiffAnnotations } from './Diff';
import { diffStrings } from '../../lib/diff';

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

const OLD = ['keep 1', 'old 2', 'keep 3', 'keep 4', 'keep 5'].join('\n');
const NEW = ['keep 1', 'new 2', 'new 2b', 'keep 3', 'keep 4', 'keep 5'].join('\n');

function renderWith(pick = vi.fn()) {
  const annotate: DiffAnnotations = { after: () => null, picking: null, pick };
  render(
    <DiffAnnotationsContext.Provider value={annotate}>
      <Diff diff={diffStrings(OLD, NEW, 'src/a.ts')} expand={{ oldText: OLD, newText: NEW }} layout="unified" />
    </DiffAnnotationsContext.Provider>,
  );
  return pick;
}

/** Select from the start of one code cell to the end of another, and say so. */
function select(fromText: string, toText: string) {
  const cell = (t: string) => [...document.querySelectorAll('.tx-d-code')].find((c) => c.textContent === t)!;
  const range = document.createRange();
  range.setStart(cell(fromText), 0);
  range.setEnd(cell(toText), cell(toText).childNodes.length);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => void document.dispatchEvent(new Event('selectionchange')));
}

describe('selectedDiffRows', () => {
  it('the new-side lines a selection covers, with their code, by the rows', () => {
    renderWith();
    select('new 2', 'keep 3');
    const rows = selectedDiffRows(document.getSelection());
    expect(rows?.lines).toEqual([
      { line: 2, text: 'new 2' },
      { line: 3, text: 'new 2b' },
      { line: 4, text: 'keep 3' },
    ]);
    expect(rows?.deletedOnly).toBe(false);
    expect(rows?.root.getAttribute('data-diff-path')).toBe('src/a.ts');
  });

  it('a selection on deleted lines only has nothing to point at', () => {
    renderWith();
    select('old 2', 'old 2');
    expect(selectedDiffRows(document.getSelection())).toMatchObject({ lines: [], deletedOnly: true });
  });
});

describe('Comment on the selection', () => {
  it('a button at the selection comments on its lines', () => {
    const pick = renderWith();
    select('new 2', 'keep 3');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on Selected Lines 2–4' }));
    expect(pick).toHaveBeenCalledWith(2, 4, true);
  });

  it('⌥⌘M does the same, read from the physical key', () => {
    const pick = renderWith();
    select('new 2b', 'new 2b');
    fireEvent.keyDown(document, { key: 'µ', code: 'KeyM', metaKey: true, altKey: true });
    expect(pick).toHaveBeenCalledWith(3, 3, true);
  });

  it('deleted lines only: it says why, and offers nothing', () => {
    const pick = renderWith();
    select('old 2', 'old 2');
    expect(screen.getByText(/Deleted lines are not in the file now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Comment on Selected/ })).toBeNull();
    fireEvent.keyDown(document, { key: 'µ', code: 'KeyM', metaKey: true, altKey: true });
    expect(pick).not.toHaveBeenCalled();
  });

  it('Shift-click on a + extends from the last + pressed', () => {
    const pick = renderWith();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on line 2' }), { button: 0 });
    fireEvent.mouseUp(window);
    pick.mockClear();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on line 5' }), { button: 0, shiftKey: true });
    expect(pick).toHaveBeenCalledWith(2, 5, true);
  });
});
