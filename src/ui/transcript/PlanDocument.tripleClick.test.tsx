/**
 * @vitest-environment jsdom
 *
 * #451: a triple-clicked block of a plan offers Comment, with the bar at the
 * end of that block. A browser ends a triple click's range at the NEXT
 * block's first selectable position (#449), so PlanDocument reads the range
 * through `trimRange`, as PassageComments does.
 *
 * Every range here is one a browser was measured to produce: headless Chrome
 * 158, real triple clicks on the real PromptCard (a plan file with its
 * "Showing the first …" note, and Claude Code's own plan mode with none),
 * built with Vite against styles.css and transcript.css:
 *
 *  - the h1, followed by a paragraph: the end is `<P.tx-md-p>@0`;
 *  - a paragraph followed by an h2: `<DIV.tx-md-h>@0`;
 *  - a paragraph followed by a code block: `<DIV.tx-md-pre-line>@0`, after
 *    the block's "sh" label (`user-select: none`) and its copy button;
 *  - the last paragraph, with a note under the document: `<DIV.pc-doc-note>@0`;
 *  - the last paragraph, with no note: `<DIV.pc-doc-body>@1`, just after
 *    `.pc-doc-md`.
 *
 * And `Selection.toString()` there: the block's text and the browser's "\n"
 * or "\n\n" after it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PlanDocument } from './PlanDocument';
import { offsetOf } from './passages';
import { __resetPlanComments, planCommentsOf } from './planComments';

const { installUserSelectCss } = await import('./userSelectSheet.testing');

const KEY = 'plan-3-7-1700000000000';

const PLAN = [
  '# Plan: tags in setup_info',
  '',
  'Staff callers get a tags list in the setup block, read once per request.',
  '',
  '## Changes',
  '',
  '- SetupInfoTool: new dumpTags(), one line in the staff block.',
  '',
  'Run this before pushing:',
  '',
  '```sh',
  'npm test',
  '```',
  '',
  'Last paragraph of the plan, run the suite before pushing.',
].join('\n');

const NOTE = 'Showing the first 512 KB of 900 KB. Open shows all of it.';

function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
}

/** The blocks of the document, in order, as the stand-in layout stacks them. */
const BLOCKS = 'p, li, .tx-md-h, .tx-md-pre-line, .pc-doc-note';
/** The bottom of block `i` (document order), in the body's content. */
const bottomOf = (i: number) => 100 * (i + 1);

let rects: PropertyDescriptor | undefined;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  installStorage();
  __resetPlanComments();
  uninstall = installUserSelectCss();
  rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  // A stand-in layout: a range's last rect is on the block its end is in --
  // at that block's bottom, and at the text's right (400) when the end is in
  // text, or the empty rect at the block's left edge (20) when the end is at
  // an element's offset 0. Chrome gave that empty rect for the paragraph
  // before a code block (the bar at the code line's left, 13px too low);
  // for an end at a paragraph's or heading's start it gave none. The issue
  // reports it in the app's WebKit, which was not measured here.
  // promptCard.css sets no user-select, so the sheet below is all there is.
  Range.prototype.getClientRects = function (this: Range) {
    const end = this.endContainer;
    const el = end instanceof Element ? end : end.parentElement;
    const block = el?.closest(BLOCKS) ?? null;
    const all = [...document.querySelectorAll(BLOCKS)];
    const i = block ? all.indexOf(block) : -1;
    const right = end instanceof Element ? 20 : 400;
    return [{ left: 0, top: 0, right, bottom: i < 0 ? 0 : bottomOf(i), width: right, height: 20 }] as unknown as DOMRectList;
  };
});

afterEach(() => {
  cleanup();
  uninstall?.();
  if (rects) Object.defineProperty(Range.prototype, 'getClientRects', rects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  __resetPlanComments();
});

/** The plan inside the transcript pane, where the prompt card is drawn. */
function show(note: string | null): HTMLElement {
  render(
    <div className="tx-pane">
      <div className="tx-prompt">
        <PlanDocument name="Claude’s Plan" folder={null} onOpen={null} text={PLAN} note={note} commentKey={KEY} locked={false} />
      </div>
    </div>,
  );
  return document.querySelector<HTMLElement>('.pc-doc-md')!;
}

function textIn(el: Element, word = ''): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes(word)) return n as Text;
  throw new Error(`no text "${word}" in ${el.outerHTML}`);
}

/** The selection a browser leaves, and its text as the browser reads it. */
function selectRange(range: Range, text: string): void {
  vi.spyOn(document.getSelection()!, 'toString').mockReturnValue(text);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** A triple click on `block`: from its first text to `end`, as measured. */
function tripleClick(block: Element, end: [Node, number], text: string): Range {
  const range = document.createRange();
  range.setStart(textIn(block), 0);
  range.setEnd(end[0], end[1]);
  selectRange(range, text);
  return range;
}

const blockIndex = (block: Element) => [...document.querySelectorAll(BLOCKS)].indexOf(block);

const docBody = () => document.querySelector<HTMLElement>('.pc-doc-body')!;

/** Each block and the end a browser gave its triple click. */
const CASES: Array<{
  name: string;
  note: string | null;
  block: () => Element;
  end: () => [Node, number];
  line: string;
  text: string;
}> = [
  {
    name: 'the first block (the h1), ending at the next paragraph’s start',
    note: null,
    block: () => document.querySelector('.pc-doc-md .tx-md-h1')!,
    end: () => [document.querySelectorAll('.pc-doc-md p')[0]!, 0],
    line: 'Plan: tags in setup_info',
    text: 'Plan: tags in setup_info\n',
  },
  {
    name: 'a middle paragraph, ending at the next heading’s start',
    note: null,
    block: () => document.querySelectorAll('.pc-doc-md p')[0]!,
    end: () => [document.querySelector('.pc-doc-md .tx-md-h2')!, 0],
    line: 'Staff callers get a tags list in the setup block, read once per request.',
    text: 'Staff callers get a tags list in the setup block, read once per request.\n\n',
  },
  {
    name: 'a middle paragraph, ending in the code block after its label and copy button',
    note: null,
    block: () => document.querySelectorAll('.pc-doc-md p')[1]!,
    end: () => [document.querySelector('.pc-doc-md .tx-md-pre-line')!, 0],
    line: 'Run this before pushing:',
    text: 'Run this before pushing:\n\n',
  },
  {
    name: 'the last block, ending in the note under the document',
    note: NOTE,
    block: () => document.querySelectorAll('.pc-doc-md p')[2]!,
    end: () => [document.querySelector('.pc-doc-note')!, 0],
    line: 'Last paragraph of the plan, run the suite before pushing.',
    text: 'Last paragraph of the plan, run the suite before pushing.\n\n',
  },
  {
    name: 'the last block, with no note, ending just after the document',
    note: null,
    block: () => document.querySelectorAll('.pc-doc-md p')[2]!,
    end: () => [docBody(), 1],
    line: 'Last paragraph of the plan, run the suite before pushing.',
    text: 'Last paragraph of the plan, run the suite before pushing.',
  },
];

describe('a triple-clicked block of the plan (#451)', () => {
  it('the fixture is what the browser saw: selection on in the pane, off on the code block’s label', async () => {
    show(NOTE);
    const label = await waitFor(() => {
      const l = document.querySelector('.pc-doc-md .tx-md-pre-lang');
      if (!l) throw new Error('no code block yet');
      return l;
    });
    expect(label.textContent).toBe('sh');
    expect(getComputedStyle(document.body).getPropertyValue('user-select')).toBe('none');
    expect(getComputedStyle(document.querySelector('.tx-pane')!).getPropertyValue('user-select')).toBe('text');
    expect(getComputedStyle(label).getPropertyValue('user-select')).toBe('none');
    // The label comes before the first code line: in the range a triple click makes.
    const line = document.querySelector('.pc-doc-md .tx-md-pre-line')!;
    expect(label.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The note and the bar's place are outside the document's text.
    expect(document.querySelector('.pc-doc-md')!.contains(document.querySelector('.pc-doc-note'))).toBe(false);
    expect(docBody().childNodes[0]).toBe(document.querySelector('.pc-doc-md'));
  });

  for (const c of CASES) {
    it(`${c.name}: Comment is offered, the bar sits at the block’s end, the quote is the block`, async () => {
      const md = show(c.note);
      await waitFor(() => expect(document.querySelector('.pc-doc-md .tx-md-pre-line')).not.toBeNull());
      const block = c.block();
      const end = c.end();
      tripleClick(block, end, c.text);

      const bar = await screen.findByRole('toolbar', { name: 'Selected text' });
      expect(screen.getByRole('button', { name: /^Comment/ })).toBeTruthy();
      // The block's own bottom and its text's right, not the next block's left edge.
      expect(bar.style.top).toBe(`${bottomOf(blockIndex(block)) + 4}px`);
      expect(bar.style.left).toBe('400px');
      // The live selection is the user's, untouched.
      expect(document.getSelection()!.getRangeAt(0).endContainer).toBe(end[0]);
      expect(document.getSelection()!.getRangeAt(0).endOffset).toBe(end[1]);

      fireEvent.click(screen.getByRole('button', { name: /^Comment/ }));
      expect(document.querySelector('.pc-cbox-quote')?.textContent).toBe(c.line);
      // The box opens under the block, not under the next one.
      expect(document.querySelector<HTMLElement>('.pc-cbox')!.style.top).toBe(`${bottomOf(blockIndex(block)) + 6}px`);
      const field = screen.getByRole('textbox', { name: 'Comment on the selected passage' });
      fireEvent.change(field, { target: { value: 'why?' } });
      fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
      const whole = document.createRange();
      whole.selectNodeContents(block);
      expect(planCommentsOf(KEY)).toEqual([expect.objectContaining({ quote: c.line, offset: offsetOf(md, whole), comment: 'why?' })]);
    });
  }

  it('a drag inside one block is read as it always was', async () => {
    const md = show(NOTE);
    const para = document.querySelectorAll('.pc-doc-md p')[0]!;
    const text = textIn(para, 'callers');
    // Measured: a drag from "callers" to before "setup" ends inside the text.
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('callers'));
    range.setEnd(text, text.data.indexOf('setup'));
    selectRange(range, 'callers get a tags list in the ');

    const bar = await screen.findByRole('toolbar', { name: 'Selected text' });
    expect(bar.style.top).toBe(`${bottomOf(blockIndex(para)) + 4}px`);
    expect(bar.style.left).toBe('400px');
    fireEvent.click(screen.getByRole('button', { name: /^Comment/ }));
    expect(document.querySelector('.pc-cbox-quote')?.textContent).toBe('callers get a tags list in the');
    const field = screen.getByRole('textbox', { name: 'Comment on the selected passage' });
    fireEvent.change(field, { target: { value: 'ok' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(planCommentsOf(KEY)).toEqual([expect.objectContaining({ quote: 'callers get a tags list in the', offset: offsetOf(md, range) })]);
  });

  it('a selection that really runs past the document still offers nothing', async () => {
    show(NOTE);
    const range = document.createRange();
    range.setStart(textIn(document.querySelectorAll('.pc-doc-md p')[2]!), 0);
    range.setEnd(textIn(document.querySelector('.pc-doc-note')!), 7);
    selectRange(range, 'Last paragraph of the plan, run the suite before pushing.\n\nShowing');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('toolbar', { name: 'Selected text' })).toBeNull();
  });
});
