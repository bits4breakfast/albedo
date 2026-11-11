/**
 * The inbox line: what the app accepts from Albedo's MCP server (#157). The
 * fixture is written by the server's own code (src-tauri/mcp/tests/contract.rs),
 * so the two sides cannot drift apart unnoticed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const {
  CAPS,
  decodeStoredRequest,
  encodeRequest,
  inboxTaskOf,
  MAX_LINE_BYTES,
  parseAllLines,
  parseInboxLine,
  parseInboxLines,
  parsePreviewLine,
} = await import('./inbox');

const fixture = readFileSync(join(__dirname, 'fixtures/mcp-inbox.jsonl'), 'utf8');
const NOW = 1_793_692_800_000;

function line(over: Record<string, unknown> = {}, args: Record<string, unknown> = { message: 'Need the key' }): string {
  return JSON.stringify({ v: 1, task: 12, tool: 'notify_blocked', args, at: NOW, id: 'a-1', ...over });
}

describe('parseInboxLine: the server\'s own lines', () => {
  it('reads every line the server writes, field for field', () => {
    const reqs = parseInboxLines(fixture, 12);
    expect(reqs.map((r) => r.tool)).toEqual([
      'create_reminder',
      'request_session',
      'request_session',
      'notify_blocked',
      'set_task_summary',
    ]);
    expect(reqs[0]).toEqual({
      id: 'fixture-1',
      taskId: 12,
      at: NOW,
      tool: 'create_reminder',
      text: 'Check the staging deploy',
      due: '2026-11-03T10:30:00+01:00',
      dueMs: NOW + 1.5 * 3_600_000, // 09:30Z
      summary: 'Deployed build 41.\nNext: smoke test /checkout, then close the PR.',
    });
    expect(reqs[1]).toMatchObject({ project: 'albedo', branch: 'fix/flaky-export', start: 'fork' });
    expect(reqs[2]).toMatchObject({ title: 'Short one', project: null, branch: null, start: 'brief' });
    expect(reqs[3]).toMatchObject({ message: 'I need the staging database password to go on.' });
    expect(reqs[4]).toEqual({
      id: 'fixture-5',
      taskId: 12,
      at: NOW,
      tool: 'set_task_summary',
      summary: 'Import pictures from a URL',
    });
  });

  it('refuses them all from another task\'s file: the file name is the identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseInboxLines(fixture, 13)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  it('round-trips through storage unchanged', () => {
    for (const r of parseInboxLines(fixture, 12)) expect(decodeStoredRequest(encodeRequest(r))).toEqual(r);
    expect(decodeStoredRequest(42)).toBeNull();
    expect(decodeStoredRequest('{"task":"12"}')).toBeNull();
  });
});

describe('parseInboxLine: what is dropped', () => {
  it('a line from another version, without the task, or with a bad id or time', () => {
    expect(parseInboxLine(line(), 12)).not.toBeNull();
    expect(parseInboxLine(line({ v: 2 }), 12)).toBeNull();
    expect(parseInboxLine(line({ task: '12' }), 12)).toBeNull();
    expect(parseInboxLine(line({ task: undefined }), 12)).toBeNull();
    expect(parseInboxLine(line({ id: '../x y' }), 12)).toBeNull();
    expect(parseInboxLine(line({ id: '' }), 12)).toBeNull();
    expect(parseInboxLine(line({ at: 'now' }), 12)).toBeNull();
    expect(parseInboxLine(line({ at: -1 }), 12)).toBeNull();
    expect(parseInboxLine(line(), 0)).toBeNull();
  });

  it('an unknown tool, junk, or a line that is not an object', () => {
    expect(parseInboxLine(line({ tool: 'run_command' }), 12)).toBeNull();
    expect(parseInboxLine('{"v":1', 12)).toBeNull();
    expect(parseInboxLine('[1,2]', 12)).toBeNull();
    expect(parseInboxLine('null', 12)).toBeNull();
    expect(parseInboxLine('', 12)).toBeNull();
    expect(parseInboxLine(line({ args: 'x' }), 12)).toBeNull();
  });

  it('arguments the tool does not take, or of the wrong type', () => {
    expect(parseInboxLine(line({}, { message: 'm', extra: 1 }), 12)).toBeNull();
    expect(parseInboxLine(line({}, { message: 3 }), 12)).toBeNull();
    expect(parseInboxLine(line({}, {}), 12)).toBeNull();
  });

  it('fields over their caps, empty, untrimmed, or with control characters', () => {
    expect(parseInboxLine(line({}, { message: 'é'.repeat(CAPS.message) }), 12)).not.toBeNull();
    expect(parseInboxLine(line({}, { message: 'a'.repeat(CAPS.message + 1) }), 12)).toBeNull();
    expect(parseInboxLine(line({}, { message: '' }), 12)).toBeNull();
    expect(parseInboxLine(line({}, { message: ' padded' }), 12)).toBeNull();
    expect(parseInboxLine(line({}, { message: 'two\nlines\tok' }), 12)).not.toBeNull();
    expect(parseInboxLine(line({}, { message: 'esc \u001b[31m' }), 12)).toBeNull();
    const session = (title: string) =>
      line({ tool: 'request_session' }, { title, prompt: 'p', reason: 'r' });
    expect(parseInboxLine(session('one line'), 12)).not.toBeNull();
    expect(parseInboxLine(session('two\nlines'), 12)).toBeNull();
  });

  it('a branch that is not a plain name', () => {
    const session = (branch: string) =>
      line({ tool: 'request_session' }, { title: 't', prompt: 'p', reason: 'r', branch });
    expect(parseInboxLine(session('feat/x-1'), 12)).not.toBeNull();
    for (const bad of ['-rf', 'a b', 'a..b', 'x/', '/x', 'a;b']) expect(parseInboxLine(session(bad), 12)).toBeNull();
  });

  it('a session request\'s start: brief or fork, absent reads as brief (#332)', () => {
    const session = (extra: Record<string, unknown>) =>
      parseInboxLine(line({ tool: 'request_session' }, { title: 't', prompt: 'p', reason: 'r', ...extra }), 12);
    expect(session({})).toMatchObject({ start: 'brief' });
    expect(session({ start: 'brief' })).toMatchObject({ start: 'brief' });
    expect(session({ start: 'fork' })).toMatchObject({ start: 'fork' });
    for (const bad of ['Fork', 'copy', '', 1, null]) expect(session({ start: bad })).toBeNull();
    // Stored as given, and the default is not written out.
    const forked = session({ start: 'fork' })!;
    expect(JSON.parse(encodeRequest(forked)).args.start).toBe('fork');
    expect(JSON.parse(encodeRequest(session({})!)).args).not.toHaveProperty('start');
    expect(decodeStoredRequest(encodeRequest(forked))).toEqual(forked);
  });

  it('a reminder whose due time and milliseconds disagree', () => {
    const reminder = (due: string, dueMs: number) =>
      line({ tool: 'create_reminder' }, { text: 't', due, dueMs, summary: 's' });
    expect(parseInboxLine(reminder('2026-11-03T09:00:00+01:00', NOW), 12)).not.toBeNull();
    expect(parseInboxLine(reminder('2026-11-03T09:00:00+01:00', NOW + 3_600_000), 12)).toBeNull();
    expect(parseInboxLine(reminder('tomorrow', NOW), 12)).toBeNull();
  });

  it('a task summary: one line within its cap, and nothing but the summary (#262)', () => {
    const summary = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
      parseInboxLine(line({ tool: 'set_task_summary', ...over }, args), 12);
    expect(summary({ summary: 'Import pictures from a URL' })).toMatchObject({
      tool: 'set_task_summary',
      taskId: 12,
      summary: 'Import pictures from a URL',
    });
    expect(summary({ summary: 'é'.repeat(CAPS.taskSummary) })).not.toBeNull();
    expect(summary({ summary: 'a'.repeat(CAPS.taskSummary + 1) })).toBeNull();
    expect(summary({ summary: 'Import pictures\nfrom a URL' })).toBeNull();
    expect(summary({ summary: 'tab\tinside' })).toBeNull();
    expect(summary({ summary: 'esc \u001b[31m' })).toBeNull();
    expect(summary({ summary: ' padded' })).toBeNull();
    expect(summary({ summary: '' })).toBeNull();
    expect(summary({ summary: 3 })).toBeNull();
    expect(summary({})).toBeNull();
    // It can name no task but its own: no extra argument, and the file decides.
    expect(summary({ summary: 's', task: 4 })).toBeNull();
    expect(parseInboxLine(line({ tool: 'set_task_summary' }, { summary: 's' }), 13)).toBeNull();
  });

  it('a line as long as the server\'s cap or longer', () => {
    const long = line({ tool: 'request_session' }, { title: 't', prompt: 'x'.repeat(MAX_LINE_BYTES), reason: 'r' });
    expect(parseInboxLine(long, 12)).toBeNull();
  });
});

describe('inboxTaskOf', () => {
  it('reads the task from a file name or path, and nothing else', () => {
    expect(inboxTaskOf('task-12.jsonl')).toBe(12);
    expect(inboxTaskOf('/Users/m/.albedo/inbox/task-7.jsonl')).toBe(7);
    expect(inboxTaskOf('task-7.jsonl.old')).toBe(7);
    expect(inboxTaskOf('task-0.jsonl')).toBeNull();
    expect(inboxTaskOf('task-x.jsonl')).toBeNull();
    expect(inboxTaskOf('mytask-7.jsonl')).toBeNull();
    expect(inboxTaskOf('queue.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// show_preview (#348)
// ---------------------------------------------------------------------------

describe('preview lines', () => {
  it('reads the lines the server writes, field for field (src-tauri/mcp/tests/contract.rs)', () => {
    const text = readFileSync(join(__dirname, 'fixtures/mcp-preview.jsonl'), 'utf8');
    const { reqs, previews } = parseAllLines(text, 12);
    expect(reqs).toEqual([]);
    expect(previews).toEqual([
      {
        id: 'fixture-p1',
        taskId: 12,
        at: NOW,
        tool: 'show_preview',
        title: 'Proposed row',
        question: 'Does the popover read as attached to the row?\nBe blunt.',
        note: 'Buttons moved onto the row',
        toolUseId: 'toolu_01ABCdef',
      },
      { id: 'fixture-p2', taskId: 12, at: NOW + 1, tool: 'preview_cancelled', request: 'fixture-p1', reason: 'AbortError: user-cancel' },
    ]);
  });

  const show = (args: Record<string, unknown>, task = 4) =>
    JSON.stringify({ v: 1, task, tool: 'show_preview', args, at: 1_000, id: '12-1000-1' });

  it('reads a call with only the fields it was given', () => {
    expect(parsePreviewLine(show({ title: 'Proposed row' }), 4)).toEqual({
      id: '12-1000-1',
      taskId: 4,
      at: 1_000,
      tool: 'show_preview',
      title: 'Proposed row',
      question: null,
      note: null,
      toolUseId: null,
    });
    expect(
      parsePreviewLine(show({ title: 'T', question: 'Does it\nread?', note: 'Moved the buttons', toolUseId: 'toolu_01AB' }), 4),
    ).toMatchObject({ question: 'Does it\nread?', note: 'Moved the buttons', toolUseId: 'toolu_01AB' });
  });

  it('refuses another task, a path, a two-line note, or a strange tool_use id', () => {
    expect(parsePreviewLine(show({ title: 'T' }, 5), 4)).toBeNull();
    expect(parsePreviewLine(show({ title: 'T', path: '/etc/passwd' }), 4)).toBeNull();
    expect(parsePreviewLine(show({ title: 'T', note: 'a\nb' }), 4)).toBeNull();
    expect(parsePreviewLine(show({ title: 'T', toolUseId: '../x' }), 4)).toBeNull();
    expect(parsePreviewLine(show({ title: 'x'.repeat(121) }), 4)).toBeNull();
  });

  it('reads the server’s cancel record', () => {
    const line = JSON.stringify({
      v: 1,
      task: 4,
      tool: 'preview_cancelled',
      args: { request: '12-1000-1', reason: 'AbortError: user-cancel' },
      at: 2_000,
      id: '12-2000-2',
    });
    expect(parsePreviewLine(line, 4)).toMatchObject({ tool: 'preview_cancelled', request: '12-1000-1', reason: 'AbortError: user-cancel' });
    expect(parsePreviewLine(line.replace('12-1000-1', '../../x'), 4)).toBeNull();
  });

  it('keeps preview lines out of the request queue', () => {
    const text = `${show({ title: 'T' })}\n${JSON.stringify({ v: 1, task: 4, tool: 'notify_blocked', args: { message: 'm' }, at: 1, id: 'n-1' })}\n`;
    const all = parseAllLines(text, 4);
    expect(all.reqs.map((r) => r.tool)).toEqual(['notify_blocked']);
    expect(all.previews.map((p) => p.tool)).toEqual(['show_preview']);
    expect(parseInboxLine(show({ title: 'T' }), 4)).toBeNull();
  });
});
