/**
 * @vitest-environment jsdom
 *
 * #358: runs of tool calls folded into one line -- which calls fold, what the
 * line says, and the line itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { parseLine } from '../../capture/adapter';
import type { Message } from '../../types';
import { findRuns, foldable, linesChanged, runFacts, runSummary } from './toolGroups';
import { ToolRunGroup, foldToolRuns, groupRows } from './TranscriptPane';

afterEach(cleanup);

let nextId = 1;
const at = (s: number) => new Date(Date.parse('2026-11-11T10:00:00.000Z') + s * 1000).toISOString();

function line(raw: Record<string, unknown>): Message {
  const id = nextId++;
  const [m] = parseLine(JSON.stringify({ sessionId: 's', uuid: `u${id}`, timestamp: at(id), ...raw }), id);
  return { ...m!, id, taskId: 1 };
}
function call(name: string, input: Record<string, unknown>, useId = `tu${nextId}`): Message {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name, input }] } });
}
function result(useId: string, text = 'ok', isError = false): Message {
  return line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text, is_error: isError }] } });
}
function said(text: string): Message {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function thought(): Message {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } });
}
/** A call and its result. */
function done(name: string, input: Record<string, unknown>, text = 'ok', isError = false): Message[] {
  const id = `tu${nextId}`;
  return [call(name, input, id), result(id, text, isError)];
}

describe('what folds', () => {
  it('folds two or more calls in a row, never one', () => {
    const msgs = [said('a'), ...done('Read', { file_path: '/a.ts' }), said('b'), ...done('Read', { file_path: '/b.ts' }), ...done('Bash', { command: 'ls' }), said('c')];
    const items = foldToolRuns(groupRows(msgs));
    expect(items.map((i) => i.kind)).toEqual(['row', 'row', 'row', 'tools', 'row']);
  });

  it('keeps a thinking block between two calls in the run, and leaves one at either end out', () => {
    const msgs = [thought(), ...done('Read', { file_path: '/a.ts' }), thought(), ...done('Bash', { command: 'ls' }), thought(), said('x')];
    const items = foldToolRuns(groupRows(msgs));
    expect(items.map((i) => i.kind)).toEqual(['row', 'tools', 'row', 'row']);
    const run = items[1]!;
    expect(run.kind === 'tools' && run.rows.length).toBe(3);
  });

  it('never folds what waits on you or runs in the background, and they split the run', () => {
    expect(foldable(call('AskUserQuestion', {}))).toBe(false);
    expect(foldable(call('ExitPlanMode', {}))).toBe(false);
    expect(foldable(call('mcp__albedo__show_preview', { path: '/x.html', title: 't' }))).toBe(false);
    expect(foldable(call('mcp__albedo__request_session', {}))).toBe(false);
    expect(foldable(call('Bash', { command: 'sleep 9', run_in_background: true }))).toBe(false);
    expect(foldable(call('Agent', { prompt: 'p', run_in_background: true }))).toBe(false);
    expect(foldable(call('Bash', { command: 'ls' }))).toBe(true);

    const msgs = [...done('Read', { file_path: '/a.ts' }), ...done('Bash', { command: 'x', run_in_background: true }), ...done('Read', { file_path: '/b.ts' })];
    expect(findRuns(groupRows(msgs))).toEqual([]);
  });
});

describe('what the line says', () => {
  it('names verbs with counts in the order they first happened, files once each', () => {
    const calls = [
      call('Read', { file_path: '/a.ts' }),
      call('Bash', { command: 'ls' }),
      call('Read', { file_path: '/b.ts' }),
      call('Read', { file_path: '/a.ts' }),
      call('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      call('Grep', { pattern: 'p' }),
      call('Bash', { command: 'pwd' }),
      call('ToolSearch', { query: 'q' }),
    ];
    expect(runSummary(calls)).toBe('Read 2 files, ran 2 commands, edited a file, searched once, used a tool');
  });

  it('counts the lines added and removed, and only by calls that succeeded', () => {
    expect(linesChanged(call('Edit', { file_path: '/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }))).toEqual({ added: 2, removed: 1 });
    expect(linesChanged(call('Write', { file_path: '/n.ts', content: 'one\ntwo\n' }))).toEqual({ added: 2, removed: 0 });
    expect(linesChanged(call('Bash', { command: 'ls' }))).toBeNull();

    const ok = done('Write', { file_path: '/n.ts', content: 'one\ntwo\n' });
    const bad = done('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y\nz' }, 'String not found', true);
    const facts = runFacts([ok[0]!, bad[0]!], new Map([[ok[0]!.id, ok[1]!], [bad[0]!.id, bad[1]!]]));
    expect(facts).toMatchObject({ lines: { added: 2, removed: 0 }, failed: 1, pending: 0 });
    // Nothing changed: no counts at all.
    const read = done('Read', { file_path: '/a.ts' });
    expect(runFacts([read[0]!], new Map([[read[0]!.id, read[1]!]])).lines).toBeNull();
  });
});

describe('the line', () => {
  function runOf(msgs: Message[]) {
    const items = foldToolRuns(groupRows(msgs));
    const run = items.find((i) => i.kind === 'tools');
    if (!run || run.kind !== 'tools') throw new Error('no run');
    return run.rows;
  }

  it('says what was done, opens to the same rows, and its parts are separate', () => {
    const rows = runOf([
      ...done('Read', { file_path: '/a.ts' }),
      ...done('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' }),
      ...done('Bash', { command: 'npx tsc' }, 'error TS1', true),
    ]);
    render(<ToolRunGroup rows={rows} live={false} reveal={null} />);
    const head = screen.getByRole('button', { expanded: false });
    const parts = [...head.children].map((el) => el.textContent?.trim()).filter(Boolean);
    expect(parts).toEqual(['Read a file, edited a file, ran a command', '+2−1', '· 1 failed']);
    expect(document.querySelector('[data-message-id]')).toBeNull();
    act(() => fireEvent.click(head));
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.tx-toolrun-body [data-message-id]').length).toBe(3);
  });

  it('says what is running while it is the newest thing and a call has no result', () => {
    const first = done('Read', { file_path: '/a.ts' });
    const rows = runOf([...first, call('Bash', { command: 'npx vitest run' })]);
    const { rerender } = render(<ToolRunGroup rows={rows} live reveal={null} />);
    expect(screen.getByText('npx vitest run')).toBeTruthy();
    expect(document.querySelector('.tx-toolrun-live')?.textContent).toContain('running');
    // Not the newest any more (an interrupted turn): nothing claims to run.
    rerender(<ToolRunGroup rows={rows} live={false} reveal={null} />);
    expect(document.querySelector('.tx-toolrun-live')).toBeNull();
  });

  it('opens itself when a row inside it is asked for, so the pane can scroll to it', () => {
    const rows = runOf([...done('Read', { file_path: '/a.ts' }), ...done('Bash', { command: 'ls' })]);
    const target = rows[1]!.message.id;
    const { rerender } = render(<ToolRunGroup rows={rows} live={false} reveal={target} />);
    expect(document.querySelector(`[data-message-id="${target}"]`)).not.toBeNull();
    // And stays open once the reveal is done.
    rerender(<ToolRunGroup rows={rows} live={false} reveal={null} />);
    expect(document.querySelector(`[data-message-id="${target}"]`)).not.toBeNull();
  });
});
