/**
 * The preview gate (#348) end to end on the app's side: inbox lines read from
 * a real file, versions kept in a real SQLite, the answer written to a real
 * file -- with a stand-in for albedo-mcp that takes it the way the server
 * does (read, then delete). The server's own side is tested in
 * src-tauri/mcp (tests/stdio.rs).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../db/testkit';

const h = vi.hoisted(() => ({ home: '', db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => h.db } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => h.home }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => existsSync(p),
  mkdir: async (p: string) => void mkdirSync(p, { recursive: true }),
  readDir: async (p: string) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() })),
  readFile: async (p: string) => new Uint8Array(readFileSync(p)),
  readTextFile: async (p: string) => readFileSync(p, 'utf8'),
  rename: async (a: string, b: string) => renameSync(a, b),
  stat: async (p: string) => ({ size: statSync(p).size }),
  writeTextFile: async (p: string, d: string) => writeFileSync(p, d),
  watch: async () => () => {},
  open: vi.fn(),
  SeekMode: { Start: 0 },
}));

const { resetDb } = await import('../db/index');
const { previewByRequest, previewVersions } = await import('../db/previews');
const { readInbox, startInbox, stopInbox } = await import('./inbox');
const gate = await import('./previewGate');
const { parseLine } = await import('./adapter');

const TASK = 7;
const inboxFile = () => join(h.home, '.albedo/inbox', `task-${TASK}.jsonl`);
const previews = () => join(h.home, '.albedo/previews');

/** What albedo-mcp does on a call: copy the page, then write the line. */
function call(id: string, html: string, extra: Record<string, unknown> = {}, at = Date.now()): void {
  mkdirSync(previews(), { recursive: true });
  writeFileSync(join(previews(), `copy-${TASK}-${id}.html`), html);
  mkdirSync(join(h.home, '.albedo/inbox'), { recursive: true });
  appendFileSync(
    inboxFile(),
    `${JSON.stringify({ v: 1, task: TASK, tool: 'show_preview', args: { title: 'Proposed row', ...extra }, at, id })}\n`,
  );
}

function cancelLine(id: string, request: string, reason = 'AbortError: user-cancel'): void {
  appendFileSync(
    inboxFile(),
    `${JSON.stringify({ v: 1, task: TASK, tool: 'preview_cancelled', args: { request, reason }, at: Date.now(), id })}\n`,
  );
}

async function read(): Promise<void> {
  await readInbox();
  await gate.previewLinesSettled();
}

/** The server taking an answer: read it, delete it. */
function serverTakes(request: string): { taken: () => string | null; stop: () => void } {
  let got: string | null = null;
  const path = join(previews(), `answer-${TASK}-${request}.json`);
  const t = setInterval(() => {
    if (existsSync(path)) {
      got = (JSON.parse(readFileSync(path, 'utf8')) as { text: string }).text;
      unlinkSync(path);
    }
  }, 20);
  return { taken: () => got, stop: () => clearInterval(t) };
}

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'albedo-previews-'));
  resetDb();
  h.db = createTestDb();
  gate.__resetPreviewGate();
  await stopInbox();
  await gate.startPreviewGate();
  await startInbox(() => {});
});

afterEach(async () => {
  await stopInbox();
  gate.__resetPreviewGate();
  rmSync(h.home, { recursive: true, force: true });
});

describe('a call waits on the user', () => {
  it('keeps the copy as a version and marks the task waiting', async () => {
    const changed: number[] = [];
    gate.onPreviewChange((id) => changed.push(id));
    call('r-1', '<p>v1</p>', { question: 'Does it read?', toolUseId: 'toolu_1' });
    await read();
    const p = gate.pendingPreview(TASK);
    expect(p).toMatchObject({ requestId: 'r-1', version: 1, html: '<p>v1</p>', question: 'Does it read?', toolUseId: 'toolu_1' });
    expect(gate.tasksWaitingOnPreview()).toEqual(new Set([TASK]));
    expect(changed).toEqual([TASK]);
  });

  it('freezes each call as the next version of its title', async () => {
    call('r-1', '<p>v1</p>');
    await read();
    // The session rewrites its file and calls again: v1 is untouched.
    call('r-2', '<p>v2</p>', { note: 'Buttons moved onto the row' });
    await read();
    const all = await previewVersions(TASK, 'Proposed row');
    expect(all.map((v) => [v.version, v.html, v.note])).toEqual([
      [1, '<p>v1</p>', null],
      [2, '<p>v2</p>', 'Buttons moved onto the row'],
    ]);
    // Another title counts from 1.
    call('r-3', '<p>x</p>', { title: 'Settings page' });
    await read();
    expect((await previewByRequest('r-3'))?.version).toBe(1);
  });

  it('closes, at launch, what an earlier run left waiting, and keeps lines from before launch as over', async () => {
    call('old-1', '<p>v1</p>', {}, 1_000);
    await read();
    expect(gate.pendingPreview(TASK)).toBeNull();
    expect((await previewByRequest('old-1'))?.outcome).toBe('cancelled');
  });
});

describe('the answer', () => {
  it('goes to the waiting call as a file the server takes, and settles the version', async () => {
    call('r-1', '<p>v1</p>');
    await read();
    const p = gate.pendingPreview(TASK)!;
    const server = serverTakes('r-1');
    try {
      const r = await gate.answerPreview(p, 'changes', 'changes requested on v1:\n1. Make Approve the primary button.');
      expect(r).toBe('taken');
      expect(server.taken()).toBe('changes requested on v1:\n1. Make Approve the primary button.');
    } finally {
      server.stop();
    }
    expect(gate.pendingPreview(TASK)).toBeNull();
    const kept = await previewByRequest('r-1');
    expect(kept).toMatchObject({ outcome: 'changes', answer: 'changes requested on v1:\n1. Make Approve the primary button.' });
  });

  it('is never written once the call was cancelled, so a late click cannot apply', async () => {
    call('r-1', '<p>v1</p>');
    await read();
    const shown = gate.pendingPreview(TASK)!;
    cancelLine('c-1', 'r-1');
    await read();
    expect(gate.pendingPreview(TASK)).toBeNull();
    expect((await previewByRequest('r-1'))?.outcome).toBe('cancelled');
    expect(await gate.answerPreview(shown, 'approved', 'approved')).toBe('refused');
    expect(existsSync(join(previews(), `answer-${TASK}-r-1.json`))).toBe(false);
  });

  it('says so when nobody takes it, and leaves the version waiting for the cancel to settle it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      call('r-1', '<p>v1</p>');
      await read();
      const p = gate.pendingPreview(TASK)!;
      const done = gate.answerPreview(p, 'approved', 'approved');
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await done).toBe('untaken');
    } finally {
      vi.useRealTimers();
    }
    expect((await previewByRequest('r-1'))?.outcome).toBe('pending');
  });

  it('settles once: a cancel after the answer changes nothing', async () => {
    call('r-1', '<p>v1</p>');
    await read();
    const server = serverTakes('r-1');
    try {
      expect(await gate.answerPreview(gate.pendingPreview(TASK)!, 'approved', 'approved')).toBe('taken');
    } finally {
      server.stop();
    }
    cancelLine('c-1', 'r-1');
    await read();
    expect((await previewByRequest('r-1'))?.outcome).toBe('approved');
  });
});

describe('retiring the card', () => {
  const toolUse = (id: string) =>
    parseLine(
      JSON.stringify({
        type: 'assistant',
        sessionId: 's',
        uuid: 'a1',
        timestamp: '2026-11-11T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: gate.SHOW_PREVIEW_TOOL, input: { path: '/x.html', title: 'Proposed row' } }] },
      }),
      0,
    );
  const result = (id: string, text: string, isError: boolean) =>
    parseLine(
      JSON.stringify({
        type: 'user',
        sessionId: 's',
        uuid: 'u1',
        timestamp: '2026-11-11T10:01:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
      }),
      1,
    );
  const rows = (...parsed: ReturnType<typeof parseLine>[]) =>
    parsed.flat().map((m, i) => ({ ...m, id: i + 1, taskId: TASK }));

  it('on the transcript recording the error result Esc leaves', async () => {
    call('r-1', '<p>v1</p>', { toolUseId: 'toolu_9' });
    await read();
    const finished = gate.finishedPreviewCalls(
      rows(toolUse('toolu_9'), result('toolu_9', "The user doesn't want to proceed with this tool use.", true)),
    );
    expect(finished.get('toolu_9')).toMatchObject({ error: true });
    await gate.retireFinishedPreviews(TASK, finished);
    expect(gate.pendingPreview(TASK)).toBeNull();
    expect((await previewByRequest('r-1'))?.outcome).toBe('cancelled');
  });

  it('ignores results of other tools and calls', async () => {
    call('r-1', '<p>v1</p>', { toolUseId: 'toolu_9' });
    await read();
    await gate.retireFinishedPreviews(TASK, gate.finishedPreviewCalls(rows(toolUse('toolu_other'), result('toolu_other', 'x', true))));
    expect(gate.pendingPreview(TASK)?.requestId).toBe('r-1');
  });

  it('when the task’s terminal exits', async () => {
    call('r-1', '<p>v1</p>');
    await read();
    await gate.endTaskPreviews(TASK);
    expect(gate.pendingPreview(TASK)).toBeNull();
    expect((await previewByRequest('r-1'))?.outcome).toBe('cancelled');
  });

  it('reads the outcome of a result it did not see answered', () => {
    expect(gate.outcomeOfResult({ error: false, text: 'approved' })).toBe('approved');
    expect(gate.outcomeOfResult({ error: false, text: 'changes requested on v2:\n1. x' })).toBe('changes');
    expect(gate.outcomeOfResult({ error: true, text: 'MCP server "albedo" tool "show_preview" timed out' })).toBe('cancelled');
  });
});
