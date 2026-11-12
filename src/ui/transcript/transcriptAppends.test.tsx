/**
 * @vitest-environment jsdom
 *
 * #362: a live append re-reads only what is new.
 *
 *  - The run's line and the row read an edit the same way (editPairsOf), and
 *    the line counts without building the diff, from a per-call cache.
 *  - A run whose rows are the same objects is not redrawn (sameRun).
 *  - A window reload keeps the row objects it already held (keepRowObjects),
 *    and grows from the rows on screen (grownLimit).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { parseLine } from '../../capture/adapter';
import { diffStrings, lineChangeCounts } from '../../lib/diff';
import type { Message } from '../../types';
import { MessageRow } from './MessageRow';
import { editPairsOf } from './editPairs';
import { linesChanged, runFacts } from './toolGroups';
import { foldToolRuns, groupRows, sameRun } from './TranscriptPane';
import { grownLimit, keepRowObjects } from './tail';

afterEach(cleanup);

let nextId = 1;
const at = (s: number) => new Date(Date.parse('2026-11-12T10:00:00.000Z') + s * 1000).toISOString();
function line(raw: Record<string, unknown>): Message {
  const id = nextId++;
  const [m] = parseLine(JSON.stringify({ sessionId: 's', uuid: `u${id}`, timestamp: at(id), ...raw }), id);
  return { ...m!, id, taskId: 1 };
}
function call(name: string, input: Record<string, unknown>, useId = `tu${nextId}`): Message {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name, input }] } });
}
function result(useId: string, text = 'ok'): Message {
  return line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text }] } });
}

/** The add and del lines diffStrings' hunks hold: what the counts must equal. */
function hunkCounts(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of diffStrings(a, b, 'f.ts').hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') added++;
      else if (l.kind === 'del') removed++;
    }
  }
  return { added, removed };
}

describe('counting an edit', () => {
  it('lineChangeCounts equals the diff the row draws, line for line', () => {
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    const words = ['a', 'b', 'c', 'foo bar', '', '  x', 'const y = 1;'];
    const text = () => Array.from({ length: rnd(30) }, () => words[rnd(words.length)]).join(rnd(5) === 0 ? '\r\n' : '\n') + (rnd(2) ? '\n' : '');
    for (let i = 0; i < 400; i++) {
      const a = text();
      const b = rnd(4) === 0 ? a : text();
      expect(lineChangeCounts(a, b)).toEqual(hunkCounts(a, b));
    }
    // Too different to diff precisely: both fall back to all-out, all-in.
    const big = (s: string) => Array.from({ length: 1500 }, (_, i) => `${s}${i}`).join('\n');
    expect(lineChangeCounts(big('a'), big('b'))).toEqual(hunkCounts(big('a'), big('b')));
  });

  it('a NotebookEdit with no old source counts nothing, as its row shows no diff (fails before #362)', () => {
    const nb = call('NotebookEdit', { notebook_path: '/n.ipynb', cell_id: 'c1', new_source: 'x = 1\ny = 2' });
    expect(editPairsOf(nb)).toBeNull();
    expect(linesChanged(nb)).toBeNull();
    const { container } = render(<MessageRow message={nb} result={result('none')} />);
    expect(container.querySelector('.tx-d')).toBeNull();
  });

  it('a NotebookEdit with both sources counts, and its row draws the diff', () => {
    const nb = call('NotebookEdit', { notebook_path: '/n.ipynb', old_source: 'x = 1', new_source: 'x = 2\ny = 3' });
    expect(linesChanged(nb)).toEqual({ added: 2, removed: 1 });
    expect(editPairsOf(nb)?.pairs).toEqual([{ oldText: 'x = 1', newText: 'x = 2\ny = 3' }]);
    const { container } = render(<MessageRow message={nb} result={result('none')} />);
    expect(container.querySelector('.tx-d')).not.toBeNull();
  });

  it('reads Write, Edit and MultiEdit as before', () => {
    expect(editPairsOf(call('Write', { file_path: '/w.ts', content: 'a\nb\n' }))).toEqual({
      path: '/w.ts',
      pairs: [{ oldText: '', newText: 'a\nb\n' }],
      absoluteLines: true,
    });
    expect(editPairsOf(call('Write', { file_path: '/w.ts' }))).toBeNull();
    expect(editPairsOf(call('Edit', { file_path: '/e.ts', old_string: 'a', new_string: 'b' }))?.absoluteLines).toBe(false);
    expect(editPairsOf(call('Edit', { file_path: '/e.ts', new_string: 'b' }))).toBeNull();
    const multi = call('MultiEdit', {
      file_path: '/m.ts',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c' }, 'junk', { old_string: 'd\ne', new_string: 'f' }],
    });
    expect(editPairsOf(multi)?.pairs).toEqual([
      { oldText: 'a', newText: 'b' },
      { oldText: 'd\ne', newText: 'f' },
    ]);
    expect(linesChanged(multi)).toEqual({ added: 2, removed: 3 });
    expect(editPairsOf(call('MultiEdit', { file_path: '/m.ts', edits: [] }))).toBeNull();
  });

  it('a cached count never answers for a changed row: a changed row is a new object', () => {
    const e = call('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' });
    expect(linesChanged(e)).toEqual({ added: 2, removed: 1 });
    expect(linesChanged({ ...e })).toEqual({ added: 2, removed: 1 });
    const changed = call('Edit', { file_path: '/a.ts', old_string: 'a\nb\nc', new_string: 'z' });
    expect(linesChanged({ ...e, rawJson: changed.rawJson })).toEqual({ added: 1, removed: 3 });
    // The same line read as another block or another tool is another count.
    expect(linesChanged({ ...e, toolName: 'Bash' })).toBeNull();
    expect(linesChanged(e)).toEqual({ added: 2, removed: 1 });
  });

  it('the run line sums the same numbers as before', () => {
    const msgs = [
      ...[call('Edit', { file_path: '/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }, 'e1'), result('e1')],
      ...[call('Write', { file_path: '/n.ts', content: 'one\ntwo\n' }, 'w1'), result('w1')],
    ];
    const items = foldToolRuns(groupRows(msgs));
    const run = items[0]!;
    expect(run.kind).toBe('tools');
    if (run.kind !== 'tools') return;
    const calls = run.rows.map((r) => r.message);
    const facts = runFacts(calls, new Map(run.rows.map((r) => [r.message.id, r.result] as const)));
    expect(facts.lines).toEqual({ added: 4, removed: 1 });
  });
});

describe('redrawing a run', () => {
  it('skips a run whose rows are the same objects, and redraws on any change', () => {
    const msgs = [call('Read', { file_path: '/a.ts' }, 'r1'), result('r1'), call('Read', { file_path: '/b.ts' }, 'r2')];
    const first = foldToolRuns(groupRows(msgs))[0]!;
    const again = foldToolRuns(groupRows([...msgs]))[0]!;
    if (first.kind !== 'tools' || again.kind !== 'tools') throw new Error('expected a run');
    expect(again.rows).not.toBe(first.rows);
    const props = (rows: typeof first.rows, live = true, reveal: number | null = null) => ({ rows, live, reveal });
    expect(sameRun(props(first.rows), props(again.rows))).toBe(true);
    expect(sameRun(props(first.rows), props(again.rows, false))).toBe(false);
    expect(sameRun(props(first.rows), props(again.rows, true, 3))).toBe(false);

    // The last call's result lands: the run must redraw (pending -> done).
    const done = foldToolRuns(groupRows([...msgs, result('r2')]))[0]!;
    if (done.kind !== 'tools') throw new Error('expected a run');
    expect(sameRun(props(first.rows), props(done.rows))).toBe(false);

    // A call joins the run.
    const longer = foldToolRuns(groupRows([...msgs, call('Bash', { command: 'ls' }, 'b1')]))[0]!;
    if (longer.kind !== 'tools') throw new Error('expected a run');
    expect(sameRun(props(first.rows), props(longer.rows))).toBe(false);

    // A row object swapped for an equal copy is a change to the memo (a reload
    // keeps objects, keepRowObjects, so this does not happen on an append).
    const copied = foldToolRuns(groupRows(msgs.map((m) => ({ ...m }))))[0]!;
    if (copied.kind !== 'tools') throw new Error('expected a run');
    expect(sameRun(props(first.rows), props(copied.rows))).toBe(false);
  });
});

describe('reloading the window', () => {
  const row = (id: number, body = `row ${id}`): Message => ({
    id,
    taskId: 1,
    sessionId: 's',
    seq: id * 100,
    role: 'assistant',
    toolName: null,
    targetPath: null,
    body,
    rawJson: `{"i":${id}}`,
    agentId: null,
    ts: id,
  });

  it('keeps the objects of rows it already held, and takes fresh ones for anything changed or new', () => {
    const prev = [row(3), row(4), row(5)];
    const next = [row(1), row(2), row(3), row(4, 'changed'), row(5)];
    const out = keepRowObjects(prev, next);
    expect(out.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(out[2]).toBe(prev[0]);
    expect(out[3]).toBe(next[3]);
    expect(out[3]!.body).toBe('changed');
    expect(out[4]).toBe(prev[2]);
    expect(out[0]).toBe(next[0]);
  });

  it('takes the fresh object when any field differs, task adoption included', () => {
    const prev = [row(1)];
    const adopted = { ...row(1), taskId: 9 };
    expect(keepRowObjects(prev, [adopted])[0]).toBe(adopted);
    const extra = { ...row(1), more: true } as unknown as Message;
    expect(keepRowObjects(prev, [extra])[0]).toBe(extra);
  });

  it('returns the list it held when nothing changed, and drops rows the window no longer has', () => {
    const prev = [row(1), row(2)];
    expect(keepRowObjects(prev, [row(1), row(2)])).toBe(prev);
    const fewer = keepRowObjects(prev, [row(2)]);
    expect(fewer).toEqual([row(2)]);
    expect(fewer[0]).toBe(prev[1]);
    expect(keepRowObjects([], [row(1)])).toEqual([row(1)]);
  });

  it('grows from the rows on screen when the live tail has added more than the window asked for', () => {
    expect(grownLimit(200, 150, 200)).toBe(400);
    expect(grownLimit(200, 450, 200)).toBe(650);
    expect(grownLimit(400, 400, 200)).toBe(600);
  });
});
