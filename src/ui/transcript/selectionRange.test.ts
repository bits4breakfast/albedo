/**
 * @vitest-environment jsdom
 *
 * A selection's range, trimmed to the text it covers (#449): a triple click
 * ends at offset 0 of the next block; a drag is left as it is.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { trimRange } from './selectionRange';

afterEach(() => {
  document.body.innerHTML = '';
});

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function text(root: Element, data: string): Text {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if ((n as Text).data === data) return n as Text;
  throw new Error(`no text node ${data}`);
}

function range(sc: Node, so: number, ec: Node, eo: number): Range {
  const r = document.createRange();
  r.setStart(sc, so);
  r.setEnd(ec, eo);
  return r;
}

describe('trimRange', () => {
  it('moves an end at offset 0 of the next block back to the end of the text it covers', () => {
    const root = dom('<div id="a"><p>one <b>two</b></p></div><div id="b"><p>three</p></div>');
    const r = range(text(root, 'one '), 0, root.querySelector('#b')!, 0);
    const { range: t, cut } = trimRange(r);
    expect(cut).toBe(true);
    expect(t.endContainer).toBe(text(root, 'two'));
    expect(t.endOffset).toBe(3);
    expect(t.toString()).toBe('one two');
    // The range it was given is untouched.
    expect(r.endContainer).toBe(root.querySelector('#b'));
  });

  it('moves an end at offset 0 of the next block’s first text node back too', () => {
    const root = dom('<p>one</p><p>two</p>');
    const t = trimRange(range(text(root, 'one'), 0, text(root, 'two'), 0)).range;
    expect(t.endContainer).toBe(text(root, 'one'));
    expect(t.endOffset).toBe(3);
  });

  it('skips blank text between the blocks', () => {
    const root = dom('<p>one</p>\n  <p>two</p>');
    const t = trimRange(range(text(root, 'one'), 0, root, 2)).range;
    expect(t.endContainer).toBe(text(root, 'one'));
    expect(t.endOffset).toBe(3);
  });

  it('moves a start at the very end of the block before forward', () => {
    const root = dom('<p>one</p><p>two</p>');
    const { range: t, cut } = trimRange(range(text(root, 'one'), 3, text(root, 'two'), 3));
    expect(cut).toBe(true);
    expect(t.startContainer).toBe(text(root, 'two'));
    expect(t.startOffset).toBe(0);
    expect(t.toString()).toBe('two');
  });

  it('leaves a drag that starts and ends inside text as it is', () => {
    const root = dom('<p>one two</p><p>three four</p>');
    const r = range(text(root, 'one two'), 4, text(root, 'three four'), 5);
    const { range: t, cut } = trimRange(r);
    expect(cut).toBe(false);
    expect(t.compareBoundaryPoints(Range.START_TO_START, r)).toBe(0);
    expect(t.compareBoundaryPoints(Range.END_TO_END, r)).toBe(0);
    expect(t).not.toBe(r);
  });

  it('leaves a range inside one text node, and one with no text at all, as they are', () => {
    const root = dom('<p>one two</p><p> </p>');
    expect(trimRange(range(text(root, 'one two'), 1, text(root, 'one two'), 3)).cut).toBe(false);
    const blank = root.querySelectorAll('p')[1]!;
    const { range: t, cut } = trimRange(range(blank, 0, root, 2));
    expect(cut).toBe(false);
    expect(t.startContainer).toBe(blank);
    expect(t.endContainer).toBe(root);
  });
});
