/**
 * @vitest-environment jsdom
 *
 * A new or deleted file is one column (#337): side by side would put the
 * whole file beside an empty column. No toggle is offered for it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { Diff, isOneSided } from './Diff';
import { diffStrings } from '../../lib/diff';

afterEach(cleanup);

const added = diffStrings('', 'one\ntwo\n', 'src/new.ts');
const deleted = diffStrings('one\ntwo\n', '', 'src/gone.ts');
const edited = diffStrings('one\ntwo\n', 'one\nthree\n', 'src/thing.ts');
const grown = diffStrings('one\ntwo\n', 'one\ntwo\nthree\n', 'src/grown.ts');

describe('isOneSided', () => {
  it('is true for a new file and for a deleted one', () => {
    expect(isOneSided(added)).toBe(true);
    expect(isOneSided(deleted)).toBe(true);
  });

  it('is false for an edit, including one that only added lines beside context', () => {
    expect(isOneSided(edited)).toBe(false);
    expect(isOneSided(grown)).toBe(false);
  });
});

describe('Diff', () => {
  it('draws a new file unified with no toggle', () => {
    const { container } = render(<Diff diff={added} />);
    expect(container.querySelector('.tx-d-split')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull();
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('draws a deleted file unified with no toggle', () => {
    const { container } = render(<Diff diff={deleted} />);
    expect(container.querySelector('.tx-d-split')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull();
  });

  it('still offers the toggle on an edit', () => {
    render(<Diff diff={edited} />);
    expect(screen.getByRole('button', { name: 'Split' })).toBeTruthy();
  });
});
