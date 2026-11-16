/**
 * @vitest-environment jsdom
 *
 * #387: a Write is read by what its result says it did.
 *
 *  - Replaced a file: the row diffs against the file as it was, and the
 *    run's line counts the same changed lines.
 *  - Created one: the whole listing, as before, tagged "New File".
 *  - Failed: the error first, the content folded, "Not Written", no counts.
 *  - No result, or one that does not say: as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { parseLine, writeResultOf } from '../../capture/adapter';
import type { Message } from '../../types';
import { MessageRow } from './MessageRow';
import { WRITE_DIFF_MAX_CHARS, editPairsOf, writeOutcomeOf } from './editPairs';
import { linesChanged, runFacts } from './toolGroups';

afterEach(cleanup);

let nextId = 1;
const at = (s: number) => new Date(Date.parse('2026-11-16T10:00:00.000Z') + s * 1000).toISOString();
function line(raw: Record<string, unknown>): Message {
  const id = nextId++;
  const [m] = parseLine(JSON.stringify({ sessionId: 's', uuid: `u${id}`, timestamp: at(id), ...raw }), id);
  return { ...m!, id, taskId: 1 };
}
function write(path: string, content: string, useId = `tu${nextId}`): Message {
  return line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'Write', input: { file_path: path, content } }] },
  });
}
function result(useId: string, text: string, extra: Record<string, unknown> = {}, isError = false): Message {
  return line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text, is_error: isError }] },
    ...extra,
  });
}
/** The result Claude Code writes for a Write that replaced `path`. */
function updated(useId: string, path: string, originalFile: string, content: string): Message {
  return result(useId, `The file ${path} has been updated successfully.`, {
    toolUseResult: { type: 'update', filePath: path, content, originalFile, structuredPatch: [], userModified: false },
  });
}
function created(useId: string, path: string, content: string): Message {
  return result(useId, `File created successfully at: ${path}`, {
    toolUseResult: { type: 'create', filePath: path, content, originalFile: null, structuredPatch: [], userModified: false },
  });
}
function failed(useId: string): Message {
  return result(useId, '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>', {
    toolUseResult: 'Error: File has not been read yet. Read it first before writing to it.',
  }, true);
}

/** A 40-line file, and the same file with lines 10 and 30 changed and one added after 20. */
const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const after = before.replace('line 10\n', 'line ten\n').replace('line 20\n', 'line 20\nline 20b\n').replace('line 30\n', 'line thirty\n');

function headCounts(container: HTMLElement): string {
  return container.querySelector('.tx-d-head .tx-d-stat')?.textContent ?? '';
}

describe('the adapter reads a Write result', () => {
  it('update, create, and nothing for any other shape', () => {
    const u = updated('a', '/f.ts', 'old\n', 'new\n');
    expect(writeResultOf(u.rawJson)).toEqual({ kind: 'update', content: 'new\n', originalFile: 'old\n' });
    expect(writeResultOf(created('b', '/f.ts', 'x\n').rawJson)).toEqual({ kind: 'create', content: 'x\n', originalFile: null });
    expect(writeResultOf(failed('c').rawJson)).toBeNull();
    expect(writeResultOf(result('d', 'ok').rawJson)).toBeNull();
    // An Edit's result has originalFile too, but no type: not a Write's.
    expect(writeResultOf(result('e', 'ok', { toolUseResult: { filePath: '/f.ts', originalFile: 'a', oldString: 'a', newString: 'b' } }).rawJson)).toBeNull();
    // An update that lost its old file says nothing.
    expect(writeResultOf(result('f', 'ok', { toolUseResult: { type: 'update', content: 'x', originalFile: null } }).rawJson)).toBeNull();
  });
});

describe('a Write that replaced a file', () => {
  it('diffs against the file as it was: the changed hunks, real line numbers, +3 −2 (all-added before #387)', () => {
    const call = write('/src/f.ts', after, 'w1');
    const res = updated('w1', '/src/f.ts', before, after);
    const { container } = render(<MessageRow message={call} result={res} />);
    expect(headCounts(container)).toBe('+3-2');
    fireEvent.click(screen.getByRole('button', { name: 'Expand diff of f.ts' }));
    const hunks = [...container.querySelectorAll('.tx-d-hunk-head')].map((h) => h.textContent);
    expect(hunks.length).toBe(3);
    const dels = [...container.querySelectorAll('.tx-d-row.tx-d-del')].map((r) => r.textContent);
    expect(dels.some((t) => t.includes('10') && t.includes('line 10'))).toBe(true);
    expect(dels.some((t) => t.includes('30') && t.includes('line 30'))).toBe(true);
    // Not tagged: it replaced a file.
    expect(container.querySelector('.tx-chip-tag')).toBeNull();
  });

  it('counts the same lines on the run line as the row shows', () => {
    const call = write('/src/f.ts', after, 'w2');
    const res = updated('w2', '/src/f.ts', before, after);
    expect(linesChanged(call, res)).toEqual({ added: 3, removed: 2 });
    expect(runFacts([call], new Map([[call.id, res]])).lines).toEqual({ added: 3, removed: 2 });
    const { container } = render(<MessageRow message={call} result={res} />);
    expect(headCounts(container)).toBe('+3-2');
  });

  it('counts again when its result arrives after the call was counted', () => {
    const call = write('/src/f.ts', after, 'w3');
    expect(linesChanged(call)).toEqual({ added: 41, removed: 0 });
    const res = updated('w3', '/src/f.ts', before, after);
    expect(linesChanged(call, res)).toEqual({ added: 3, removed: 2 });
  });

  it('redraws as a diff when the result arrives after the row was drawn', () => {
    const call = write('/src/f.ts', after, 'w7');
    const { container, rerender } = render(<MessageRow message={call} result={null} />);
    expect(headCounts(container)).toBe('+41');
    rerender(<MessageRow message={call} result={updated('w7', '/src/f.ts', before, after)} />);
    expect(headCounts(container)).toBe('+3-2');
  });

  it('redraws when a new result says more though its text is the same (the memo reads the result, not only its text)', () => {
    const call = write('/src/f.ts', after, 'w8');
    const text = 'The file /src/f.ts has been updated successfully.';
    const { container, rerender } = render(<MessageRow message={call} result={result('w8', text)} />);
    expect(headCounts(container)).toBe('+41');
    rerender(<MessageRow message={call} result={updated('w8', '/src/f.ts', before, after)} />);
    expect(headCounts(container)).toBe('+3-2');
  });

  it('opens the whole file under the diff', () => {
    const call = write('/src/f.ts', after, 'w4');
    const { container } = render(<MessageRow message={call} result={updated('w4', '/src/f.ts', before, after)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand diff of f.ts' }));
    const show = screen.getByRole('button', { name: 'Show Whole File (41 Lines)' });
    expect(container.querySelector('.tx-d-whole')).toBeNull();
    act(() => fireEvent.click(show));
    const listing = container.querySelector('.tx-d-whole');
    expect(listing?.querySelectorAll('.tx-md-pre-line').length).toBe(42);
    expect(listing?.textContent).toContain('line 20b');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Whole File' }));
    expect(container.querySelector('.tx-d-whole')).toBeNull();
  });

  it('past the size cap, reads as before: the whole content as added', () => {
    const big = 'x'.repeat(WRITE_DIFF_MAX_CHARS / 2) + '\n';
    const bigger = big + 'y\n';
    const call = write('/src/big.txt', bigger, 'w5');
    const res = updated('w5', '/src/big.txt', big, bigger);
    expect(writeOutcomeOf(call, res)).toEqual({ kind: 'unknown' });
    expect(linesChanged(call, res)).toEqual({ added: 2, removed: 0 });
    // Just under it, diffed.
    const small = 'x'.repeat(100) + '\n';
    const call2 = write('/src/small.txt', small + 'y\n', 'w6');
    expect(linesChanged(call2, updated('w6', '/src/small.txt', small, small + 'y\n'))).toEqual({ added: 1, removed: 0 });
  });
});

describe('a Write that created a file', () => {
  it('shows its content as before, counted as added, tagged New File', () => {
    const content = 'alpha\nbeta\ngamma\n';
    const call = write('/src/new.ts', content, 'c1');
    const res = created('c1', '/src/new.ts', content);
    const { container } = render(<MessageRow message={call} result={res} />);
    expect(container.querySelector('.tx-chip-tag')?.textContent).toBe('New File');
    expect(headCounts(container)).toBe('+3');
    expect(linesChanged(call, res)).toEqual({ added: 3, removed: 0 });
    expect(editPairsOf(call, res)).toEqual(editPairsOf(call));
    // The content written renders: every line, numbered from 1.
    fireEvent.click(screen.getByRole('button', { name: 'Expand diff of new.ts' }));
    const rows = [...container.querySelectorAll('.tx-d-row.tx-d-add')].map((r) => r.textContent ?? '');
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('alpha');
    expect(rows[2]).toContain('gamma');
    expect(screen.queryByRole('button', { name: /Show Whole File/ })).toBeNull();
  });
});

describe('a Write that failed', () => {
  it('shows the error first, folds the content, says Not Written, and counts nothing', () => {
    const content = Array.from({ length: 91 }, (_, i) => `row ${i}`).join('\n') + '\n';
    const call = write('/src/f.ts', content, 'f1');
    const res = failed('f1');
    const { container } = render(<MessageRow message={call} result={res} />);
    expect(container.querySelector('.tx-chip-tag')?.textContent).toBe('Not Written');
    // No diff, so no +91 on the row.
    expect(container.querySelector('.tx-d')).toBeNull();
    const error = container.querySelector('.tx-write-error');
    // The message, without Claude Code's <tool_use_error> wrapper.
    expect(error?.textContent).toBe('File has not been read yet. Read it first before writing to it.');
    const show = screen.getByRole('button', { name: /Show Content \(91 Lines\)/ });
    // Error before the fold.
    expect(error!.compareDocumentPosition(show) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain('row 50');
    act(() => fireEvent.click(show));
    expect(container.textContent).toContain('row 50');

    // Opened, the chip does not say the error again.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Write details' })));
    expect(container.textContent!.split('File has not been read yet').length - 1).toBe(1);
    expect(container.querySelector('.tx-chip-body')).not.toBeNull();
    expect([...container.querySelectorAll('.tx-chip-label')].map((h) => h.textContent)).not.toContain('Error');

    expect(editPairsOf(call, res)).toBeNull();
    expect(linesChanged(call, res)).toBeNull();
    expect(runFacts([call], new Map([[call.id, res]]))).toMatchObject({ lines: null, failed: 1 });
  });
});

describe('a Write with no result, or one that does not say', () => {
  it('reads as before: the whole content as added, no tag', () => {
    const content = 'a\nb\n';
    for (const res of [null, result('m1', 'ok')]) {
      const call = write('/src/m.ts', content, 'm1');
      cleanup();
      const { container } = render(<MessageRow message={call} result={res} />);
      expect(container.querySelector('.tx-chip-tag')).toBeNull();
      expect(headCounts(container)).toBe('+2');
      expect(linesChanged(call, res)).toEqual({ added: 2, removed: 0 });
      expect(editPairsOf(call, res)).toEqual({ path: '/src/m.ts', pairs: [{ oldText: '', newText: content }], absoluteLines: true });
    }
  });
});

describe('the chip', () => {
  it('a Write that succeeded still shows its Result when opened', () => {
    const call = write('/src/new.ts', 'a\n', 'k1');
    const { container } = render(<MessageRow message={call} result={created('k1', '/src/new.ts', 'a\n')} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Write details' })));
    expect(screen.getByText('Result')).toBeTruthy();
    expect(container.querySelector('.tx-chip-body')?.textContent).toContain('File created successfully at:');
  });

  it("counts a Write's lines as its diff does: a final line break starts no line", () => {
    const summary = (content: string) => {
      cleanup();
      const { container } = render(<MessageRow message={write('/src/s.ts', content)} result={null} />);
      return container.querySelector('.tx-chip-summary')?.textContent;
    };
    expect(summary('a\nb\n')).toBe('2 lines');
    expect(summary('a\nb')).toBe('2 lines');
    expect(summary('a\r\nb\r\n')).toBe('2 lines');
    expect(summary('only\n')).toBe('1 line');
    // The same number the diff header and the run's line say.
    const { container } = render(<MessageRow message={write('/src/s.ts', 'a\nb\nc\n')} result={null} />);
    expect(container.querySelector('.tx-chip-summary')?.textContent).toBe('3 lines');
    expect(headCounts(container)).toBe('+3');
  });
});
