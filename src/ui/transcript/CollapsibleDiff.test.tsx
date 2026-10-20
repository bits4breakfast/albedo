/**
 * @vitest-environment jsdom
 *
 * Transcript diffs start closed: the header -- path and counts -- and nothing
 * else, until clicked.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CollapsibleDiff } from './Diff';
import { diffStrings } from '../../lib/diff';

afterEach(cleanup);

const diff = diffStrings('one\ntwo\n', 'one\nthree\n', 'src/thing.ts');

describe('CollapsibleDiff', () => {
  it('shows only the header until opened, and closes again', () => {
    render(<CollapsibleDiff diff={diff} layout="unified" />);
    expect(screen.getByText('thing.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.queryByText('three')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand diff of thing.ts' }));
    expect(screen.getByText('three')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse diff of thing.ts' }));
    expect(screen.queryByText('three')).toBeNull();
  });

  it('opens on a click anywhere in the header row', () => {
    const { container } = render(<CollapsibleDiff diff={diff} layout="unified" />);
    fireEvent.click(container.querySelector('.tx-d-stat')!);
    expect(screen.getByText('three')).toBeTruthy();
  });
});
