/**
 * @vitest-environment jsdom
 *
 * A selection in a transcript diff's rows (#222): a code comment on the
 * file's lines when they are in the file as it is now, else a comment on the
 * passage that says why. Real Diff, real PassageComments; the file is a map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';

const added = vi.hoisted(() => [] as unknown[]);
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  addComment: vi.fn(async (c: unknown) => {
    added.push(c);
    return 1;
  }),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));

const { Diff } = await import('./Diff');
const { PassageComments, codeTarget } = await import('./PassageComments');
const { FilePathContext, FileTextContext } = await import('../editor/openFile');
const { __resetDrafts, commentsOf } = await import('./drafts');
const { diffStrings } = await import('../../lib/diff');

const OLD = 'alpha\nold beta\ngamma';
const NEW = 'alpha\nnew beta\nnew beta 2\ngamma';
let disk: string | null;

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  __resetDrafts();
  added.length = 0;
  disk = `header\n${NEW}\nfooter\n`;
});
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

function Pane() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <FileTextContext.Provider value={async () => disk}>
      <FilePathContext.Provider value={async (p) => (p.startsWith('/wt/') ? p.slice(4) : null)}>
        <div ref={scrollRef}>
          <div data-message-id="4">
            <div className="tx-content">
              <Diff diff={diffStrings(OLD, NEW, '/wt/src/a.ts')} expand={{ oldText: OLD, newText: NEW }} layout="unified" />
            </div>
          </div>
          <PassageComments taskId={1} scrollRef={scrollRef} messages={[]} />
        </div>
      </FilePathContext.Provider>
    </FileTextContext.Provider>
  );
}

function selectRows(from: string, to: string) {
  const cell = (t: string) => [...document.querySelectorAll('.tx-d-code')].find((c) => c.textContent === t)!;
  const range = document.createRange();
  range.setStart(cell(from), 0);
  range.setEnd(cell(to), cell(to).childNodes.length);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

const commentKey = () => fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });

describe('codeTarget', () => {
  const lines = [
    { line: 2, text: 'new beta' },
    { line: 3, text: 'new beta 2' },
  ];
  it('finds the lines in the file now and points at them there', () => {
    expect(codeTarget(lines, 'src/a.ts', `x\ny\n${NEW}`)).toEqual({
      kind: 'code', path: 'src/a.ts', lineStart: 4, lineEnd: 5, anchorText: 'new beta\nnew beta 2',
    });
  });
  it('otherwise the passage, saying why', () => {
    expect(codeTarget(lines, 'src/a.ts', 'moved on')).toMatchObject({ kind: 'passage', why: expect.stringMatching(/not in the file as it is now/) });
    expect(codeTarget([], null, null)).toMatchObject({ kind: 'passage', why: expect.stringMatching(/Deleted lines/) });
    expect(codeTarget([lines[0]!, { line: 9, text: 'far' }], 'src/a.ts', NEW)).toMatchObject({ why: expect.stringMatching(/two parts/) });
    expect(codeTarget(lines, null, NEW)).toMatchObject({ why: expect.stringMatching(/could not be read/) });
  });
});

describe('a selection in a transcript diff', () => {
  it('becomes a code comment on the file’s lines, worktree-relative, and joins the code queue', async () => {
    render(<Pane />);
    selectRows('new beta', 'new beta 2');
    act(() => void commentKey());
    expect(await screen.findByText('On a.ts:3–4, as a code comment')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Comment on the selected lines'), { target: { value: 'Name these.' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toEqual({ taskId: 1, path: 'src/a.ts', lineStart: 3, lineEnd: 4, anchorText: 'new beta\nnew beta 2', body: 'Name these.' });
    expect(commentsOf(1)).toEqual([]);
  });

  it('when the file has moved on, it comments on the passage and says why', async () => {
    disk = 'something else entirely\n';
    render(<Pane />);
    selectRows('new beta', 'new beta 2');
    act(() => void commentKey());
    expect(await screen.findByText(/not in the file as it is now, so this comments on the passage/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Comment on the selected passage'), { target: { value: 'Hm.' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(added).toHaveLength(0);
    expect(commentsOf(1).map((c) => c.comment)).toEqual(['Hm.']);
  });
});
