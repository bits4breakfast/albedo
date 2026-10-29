/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { FileOpenContext } from '../editor/openFile';
import { PathLink } from './Diff';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function setup(lookup = false) {
  const open = vi.fn();
  render(
    <FileOpenContext.Provider value={open}>
      <p id="prose">Some earlier reply text the reader selected.</p>
      <PathLink path={lookup ? 'Factory.php' : 'src/Factory.php'} line={12} lookup={lookup} />
    </FileOpenContext.Provider>,
  );
  return { open, link: screen.getByRole('link') };
}

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('a path link and the selection', () => {
  it('opens even while text elsewhere is selected', () => {
    // A line-number link is user-select: none, so clicking it leaves an
    // earlier selection in place; that swallowed every click (#110).
    const { open, link } = setup();
    select(document.getElementById('prose')!);
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith({ path: 'src/Factory.php', line: 12 }, undefined);
  });

  it('does not open when the click ends a selection of the link itself', () => {
    const { open, link } = setup();
    select(link);
    fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
  });

  it('asks for a lookup when the link holds a bare name', () => {
    const { open, link } = setup(true);
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith({ path: 'Factory.php', line: 12 }, { lookup: true });
  });
});
