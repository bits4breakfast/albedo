/**
 * @vitest-environment jsdom
 *
 * Expanding a diff with context from the file it edited.
 *
 * The behaviour worth pinning is not "lines appear" -- it is WHEN THEY DO NOT.
 * A diff is history and the worktree is the present, so context is offered
 * only once the hunk's own lines are found verbatim in the file. Half of the
 * Edit calls in the live corpus fail that check, and every one of them would
 * otherwise have rendered a file that never existed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Diff } from './Diff';
import { FileTextContext } from '../editor/openFile';
import { diffStrings } from '../../lib/diff';

afterEach(cleanup);

/** 10 lines before the edit, 10 after, so both directions have something. */
const before = Array.from({ length: 10 }, (_, i) => `before ${i + 1}`);
const after = Array.from({ length: 10 }, (_, i) => `after ${i + 1}`);
const OLD = 'target old';
const NEW = 'target new';
const fileNow = [...before, NEW, ...after].join('\n');

function renderDiff(text: string | null) {
  const read = vi.fn(async () => text);
  const diff = diffStrings(OLD, NEW, 'src/thing.ts');
  render(
    <FileTextContext.Provider value={read}>
      <Diff diff={diff} expand={{ oldText: OLD, newText: NEW }} layout="unified" />
    </FileTextContext.Provider>,
  );
  return read;
}

describe('diff context expansion', () => {
  it('offers context before the file has been read', () => {
    // Whether anything surrounds the hunk is not knowable without reading the
    // file, and reading one per diff in a long transcript is the wrong trade.
    renderDiff(fileNow);
    expect(screen.getAllByRole('button', { name: /more context/ }).length).toBe(2);
  });

  it('reveals the lines above and below once anchored', async () => {
    const read = renderDiff(fileNow);
    fireEvent.click(screen.getAllByRole('button', { name: /more context/ })[0]!);

    await waitFor(() => expect(screen.getByText('before 10')).toBeTruthy());
    expect(read).toHaveBeenCalledWith('src/thing.ts');
    // 10 available, one step of 20 covers them all, so the bar retires.
    expect(screen.getByText('before 1')).toBeTruthy();
  });

  it('says the file has changed rather than showing lines around a stale hunk', async () => {
    // The hunk's own content is gone: anything rendered around it would be a
    // splice of the present onto the past.
    renderDiff([...before, 'something else entirely', ...after].join('\n'));
    fireEvent.click(screen.getAllByRole('button', { name: /more context/ })[0]!);

    await waitFor(() => expect(screen.getByText(/this file has changed since/)).toBeTruthy());
    expect(screen.queryByText('before 10')).toBeNull();
  });

  it('shows nothing extra when the file cannot be read', async () => {
    renderDiff(null);
    fireEvent.click(screen.getAllByRole('button', { name: /more context/ })[0]!);
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
  });
});
