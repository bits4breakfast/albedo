// @vitest-environment jsdom
/**
 * Review comments on a diff: the + handles and what appears under a row, as
 * the editor's Diff mode provides them. Without the provider -- every
 * transcript diff -- nothing of this is there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Diff, DiffAnnotationsContext, type DiffAnnotations } from './Diff';
import { diffStrings } from '../../lib/diff';

afterEach(cleanup);

const OLD = 'keep 1\nold line\nkeep 2\n';
const NEW = 'keep 1\nnew line\nextra\nkeep 2\n';

function renderDiff(layout: 'unified' | 'split', annotations: DiffAnnotations | null) {
  const diff = diffStrings(OLD, NEW, 'src/a.ts');
  return render(
    <DiffAnnotationsContext.Provider value={annotations}>
      <Diff diff={diff} expand={{ oldText: OLD, newText: NEW }} layout={layout} absoluteLines contextPath={null} />
    </DiffAnnotationsContext.Provider>,
  );
}

function annotations(over: Partial<DiffAnnotations> = {}): DiffAnnotations {
  return { after: () => null, picking: null, pick: vi.fn(), ...over };
}

describe.each(['unified', 'split'] as const)('diff comments (%s)', (layout) => {
  it('offers a + on every line of the file as it is now, none on a deleted line', () => {
    renderDiff(layout, annotations());
    const lines = screen.getAllByRole('button', { name: /^Comment on line / }).map((b) => b.getAttribute('aria-label'));
    expect(lines).toEqual(['Comment on line 1', 'Comment on line 2', 'Comment on line 3', 'Comment on line 4']);
  });

  it('a press reports that line, done on release', () => {
    const pick = vi.fn();
    renderDiff(layout, annotations({ pick }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment on line 3' }), { button: 0 });
    expect(pick).toHaveBeenLastCalledWith(3, 3, false);
    fireEvent.mouseUp(window);
    expect(pick).toHaveBeenLastCalledWith(3, 3, true);
  });

  it('shows what belongs under a line right after its row', () => {
    renderDiff(layout, annotations({ after: (line) => (line === 3 ? <span>note on 3</span> : null) }));
    const note = screen.getByText('note on 3');
    const row = note.closest('.tx-d-annot')!.previousElementSibling!;
    expect(row.textContent).toContain('extra');
  });
});

it('a transcript diff, with no provider, has no handles', () => {
  renderDiff('unified', null);
  expect(screen.queryAllByRole('button', { name: /^Comment on line / })).toEqual([]);
});
