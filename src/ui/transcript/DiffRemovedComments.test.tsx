// @vitest-environment jsdom
/**
 * Comments on deleted rows (#402): a + on each deleted row, by the base's
 * line, what belongs under a deleted row, and a selection over deleted rows
 * (alone, or with added ones). Only where the provider offers `removed`:
 * without it a deleted row has no handle and a selection on one says why,
 * as before (DiffComments.test.tsx, DiffSelectComment.test.tsx).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Diff, DiffAnnotationsContext, selectedDiffRows, type DiffAnnotations, type RemovedAnnotations } from './Diff';
import { diffStrings } from '../../lib/diff';

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

const OLD = ['keep 1', 'old 2', 'old 3', 'keep 4', 'keep 5'].join('\n');
const NEW = ['keep 1', 'new 2', 'keep 4', 'keep 5'].join('\n');

function removedHooks(over: Partial<RemovedAnnotations> = {}): RemovedAnnotations {
  return { after: () => null, picking: null, pick: vi.fn(), ...over };
}

function annotations(over: Partial<DiffAnnotations> = {}): DiffAnnotations {
  return { after: () => null, picking: null, pick: vi.fn(), ...over };
}

function renderDiff(layout: 'unified' | 'split', value: DiffAnnotations | null) {
  return render(
    <DiffAnnotationsContext.Provider value={value}>
      <Diff diff={diffStrings(OLD, NEW, 'src/a.ts')} expand={{ oldText: OLD, newText: NEW }} layout={layout} absoluteLines contextPath={null} />
    </DiffAnnotationsContext.Provider>,
  );
}

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

describe.each(['unified', 'split'] as const)('deleted rows (%s)', (layout) => {
  it('each deleted row has a + for its base line, next to the new side’s', () => {
    renderDiff(layout, annotations({ removed: removedHooks() }));
    const removed = screen.getAllByRole('button', { name: /^Comment on removed line / }).map((b) => b.getAttribute('aria-label'));
    expect(removed).toEqual(['Comment on removed line 2', 'Comment on removed line 3']);
    // The new side's + are all still there.
    expect(screen.getAllByRole('button', { name: /^Comment on line / })).toHaveLength(4);
  });

  it('a press reports the base line to the removed side, never to the new side', () => {
    const pick = vi.fn();
    const removed = removedHooks({ pick: vi.fn() });
    renderDiff(layout, annotations({ pick, removed }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on removed line 3' }), { button: 0 });
    expect(removed.pick).toHaveBeenLastCalledWith(3, 3, false);
    fireEvent.mouseUp(window);
    expect(removed.pick).toHaveBeenLastCalledWith(3, 3, true);
    expect(pick).not.toHaveBeenCalled();
  });

  it('Shift-click extends only from the last + on the same side', () => {
    const pick = vi.fn();
    const removed = removedHooks({ pick: vi.fn() });
    renderDiff(layout, annotations({ pick, removed }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on removed line 2' }), { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on removed line 3' }), { button: 0, shiftKey: true });
    expect(removed.pick).toHaveBeenLastCalledWith(2, 3, true);
    // From a deleted row's + to a line of the file: not a range, a fresh press.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on line 4' }), { button: 0, shiftKey: true });
    expect(pick).toHaveBeenLastCalledWith(4, 4, false);
    fireEvent.mouseUp(window);
  });

  it('shows what belongs under a deleted row right after it, and edges the rows it covers', () => {
    const { container } = renderDiff(
      layout,
      annotations({
        removed: removedHooks({ after: (line) => (line === 3 ? <span>on removed 3</span> : null), commented: (line) => line === 2 || line === 3 }),
      }),
    );
    const note = screen.getByText('on removed 3');
    const annot = note.closest('.tx-d-annot')!;
    expect(annot.getAttribute('data-side')).toBe('old');
    // Under the row holding "old 3": unified, its own row; split, its pair.
    expect(annot.previousElementSibling!.textContent).toContain('old 3');
    const marked = [...container.querySelectorAll('.tx-d-commented')].map((r) => r.getAttribute('data-old-line'));
    expect(marked).toEqual(['2', '3']);
  });
});

it('without `removed`, deleted rows have no + and nothing under them', () => {
  renderDiff('unified', annotations({ after: () => <span>new side</span> }));
  expect(screen.queryAllByRole('button', { name: /^Comment on removed line / })).toEqual([]);
  expect(document.querySelector('.tx-d-annot[data-side="old"]')).toBeNull();
});

describe('a selection over deleted rows', () => {
  it('reads their base lines alongside the new side’s', () => {
    renderDiff('unified', annotations({ removed: removedHooks() }));
    select('old 2', 'new 2');
    const rows = selectedDiffRows(document.getSelection());
    expect(rows?.removed).toEqual([
      { line: 2, text: 'old 2' },
      { line: 3, text: 'old 3' },
    ]);
    expect(rows?.lines).toEqual([{ line: 2, text: 'new 2' }]);
    expect(rows?.deletedOnly).toBe(false);
  });

  it('deleted rows only: Comment on them, by their base lines, and ⌥⌘M the same', () => {
    const removed = removedHooks({ pick: vi.fn() });
    const pick = vi.fn();
    renderDiff('unified', annotations({ pick, removed }));
    select('old 2', 'old 3');
    expect(screen.queryByText(/nothing to comment on/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Comment on Removed Lines 2–3' }));
    expect(removed.pick).toHaveBeenCalledWith(2, 3, true);
    select('old 3', 'old 3');
    fireEvent.keyDown(document, { key: 'µ', code: 'KeyM', metaKey: true, altKey: true });
    expect(removed.pick).toHaveBeenLastCalledWith(3, 3, true);
    expect(pick).not.toHaveBeenCalled();
  });

  it('deleted and added lines: one Comment, one per side', () => {
    const pickBoth = vi.fn();
    const pick = vi.fn();
    const removed = removedHooks({ pick: vi.fn() });
    renderDiff('unified', annotations({ pick, removed, pickBoth }));
    select('old 2', 'new 2');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on Removed Lines 2–3 and Line 2' }));
    expect(pickBoth).toHaveBeenCalledWith({ from: 2, to: 2 }, { from: 2, to: 3 });
    expect(pick).not.toHaveBeenCalled();
    expect(removed.pick).not.toHaveBeenCalled();
  });
});

describe('a selection in a split diff', () => {
  it('in the left column: the deleted rows only, not the right column’s rows its range runs through', () => {
    const pickBoth = vi.fn();
    const pick = vi.fn();
    const removed = removedHooks({ pick: vi.fn() });
    renderDiff('split', annotations({ pick, removed, pickBoth }));
    fireEvent.mouseDown(document.querySelector('.tx-d-half[data-old-line="2"]')!);
    select('old 2', 'old 3');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on Removed Lines 2–3' }));
    expect(removed.pick).toHaveBeenCalledWith(2, 3, true);
    expect(pickBoth).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
  });

  it('in the right column: the file’s lines only', () => {
    const pickBoth = vi.fn();
    const pick = vi.fn();
    const removed = removedHooks({ pick: vi.fn() });
    renderDiff('split', annotations({ pick, removed, pickBoth }));
    fireEvent.mouseDown(document.querySelector('.tx-d-half[data-new-line="2"]')!);
    // From the right half of line 2 to the right half of line 3: the range
    // runs through the left half holding "old 3" on the way.
    const code = (n: number) => document.querySelector(`.tx-d-half[data-new-line="${n}"] .tx-d-code`)!;
    const range = document.createRange();
    range.setStart(code(2), 0);
    range.setEnd(code(3), code(3).childNodes.length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    act(() => void document.dispatchEvent(new Event('selectionchange')));
    expect(selectedDiffRows(document.getSelection())?.removed).toEqual([{ line: 3, text: 'old 3' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on Selected Lines 2–3' }));
    expect(pick).toHaveBeenCalledWith(2, 3, true);
    expect(pickBoth).not.toHaveBeenCalled();
    expect(removed.pick).not.toHaveBeenCalled();
  });
});
