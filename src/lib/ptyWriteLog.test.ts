/**
 * The debug log of what Albedo writes to a pty (#433): off unless its marker
 * exists, one line per write worth seeing, never more of the text than its
 * head, and never what is typed in the terminal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  flag: false,
  existsCalls: 0,
  mkdirCalls: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), Channel: class {} }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/someone/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async (p: string) => {
    fs.existsCalls += 1;
    return fs.flag && p === '/Users/someone/.albedo/debug-pty-writes';
  }),
  mkdir: vi.fn(async () => {
    fs.mkdirCalls += 1;
  }),
  stat: vi.fn(async (p: string) => {
    const f = fs.files.get(p);
    if (f === undefined) throw new Error('not found');
    return { size: f.length };
  }),
  rename: vi.fn(async (from: string, to: string) => {
    fs.files.set(to, fs.files.get(from) ?? '');
    fs.files.delete(from);
  }),
  writeTextFile: vi.fn(async (p: string, text: string, opts?: { append?: boolean }) => {
    fs.files.set(p, (opts?.append ? (fs.files.get(p) ?? '') : '') + text);
  }),
}));

const { FLAG_RECHECK_MS, HEAD_CHARS, MAX_LOG_BYTES, __resetPtyWriteLog, logPtyWrite, loggedHead, notePtyTask, ptyWriteLine, visibleHead } =
  await import('./ptyWriteLog');
const { writePty } = await import('./pty');

const LOG = '/Users/someone/.albedo/logs/pty-writes.jsonl';
const OLD = '/Users/someone/.albedo/logs/pty-writes.1.jsonl';
const T = Date.parse('2026-11-17T09:00:00.000Z');

/** Let the background appends finish. */
const settle = () => __resetPtyWriteLog();
const lines = (path = LOG) =>
  (fs.files.get(path) ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  fs.files.clear();
  fs.flag = false;
  fs.existsCalls = 0;
  fs.mkdirCalls = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  await settle();
});

describe('visibleHead', () => {
  it('makes every control character visible', () => {
    expect(visibleHead('\x1b[200~hi\x1b[201~')).toBe('\\e[200~hi\\e[201~');
    expect(visibleHead('\r')).toBe('\\r');
    expect(visibleHead('a\nb\tc\x7f\x03')).toBe('a\\nb\\tc\\x7f\\x03');
    expect(visibleHead('C:\\path')).toBe('C:\\\\path');
    expect(visibleHead('caffè ✓')).toBe('caffè ✓');
  });

  it(`keeps only the first ${HEAD_CHARS} characters, and says there was more`, () => {
    expect(visibleHead('x'.repeat(HEAD_CHARS + 25))).toBe(`${'x'.repeat(HEAD_CHARS)}\u2026`);
    expect(visibleHead('x'.repeat(HEAD_CHARS))).toBe('x'.repeat(HEAD_CHARS));
  });

  it('never splits a character in two', () => {
    expect(visibleHead('😀😀😀', 2)).toBe('😀😀\u2026');
    expect(visibleHead('a😀😀', 2)).toBe('a😀\u2026');
  });

  it('looks only at the start of a large write', () => {
    const big = 'y'.repeat(5_000_000);
    const from = vi.spyOn(Array, 'from');
    try {
      expect(visibleHead(big)).toBe(`${'y'.repeat(HEAD_CHARS)}\u2026`);
      expect(from).toHaveBeenCalledTimes(1);
      expect((from.mock.calls[0]![0] as string).length).toBeLessThanOrEqual(HEAD_CHARS * 2);
    } finally {
      from.mockRestore();
    }
  });
});

describe('what is logged', () => {
  it('Albedo’s own writes, whole heads', () => {
    expect(loggedHead('\x1b[200~ship it\x1b[201~', 'albedo')).toBe('\\e[200~ship it\\e[201~');
    expect(loggedHead('\r', 'albedo')).toBe('\\r');
  });

  it('from the terminal: escape sequences, never typed text', () => {
    expect(loggedHead('\x1b[?1;2c', 'terminal')).toBe('\\e[?1;2c');
    expect(loggedHead('\x1b[A', 'terminal')).toBe('\\e[A');
    expect(loggedHead('h', 'terminal')).toBeNull();
    expect(loggedHead('hunter2', 'terminal')).toBeNull();
    expect(loggedHead('\r', 'terminal')).toBeNull();
    // A paste into the terminal: its marker, none of its text.
    expect(loggedHead('\x1b[200~my secret password\x1b[201~', 'terminal')).toBe('\\e[200~<paste>');
  });

  it('a line has the time, the task, the length and the head -- not the rest of the text', () => {
    const body = '\x1b[200~please look at the flaky retry test in the queue worker\x1b[201~';
    const line = ptyWriteLine('pty-7', 3, body, 'albedo', T);
    expect(line).toEqual({
      at: '2026-11-17T09:00:00.000Z',
      taskId: 3,
      ptyId: 'pty-7',
      origin: 'albedo',
      len: body.length,
      head: '\\e[200~please look at the flaky retry tes\u2026',
    });
    expect(JSON.stringify(line)).not.toContain('queue worker');
  });
});

describe('logPtyWrite', () => {
  it('writes nothing while the marker is absent', async () => {
    logPtyWrite('pty-1', 'hello', 'albedo', T);
    await settle();
    expect(fs.files.size).toBe(0);
  });

  it('builds nothing while off and looked for lately', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    logPtyWrite('pty-1', 'a', 'albedo', T);
    await new Promise((r) => setImmediate(r));
    const json = vi.spyOn(JSON, 'stringify');
    const from = vi.spyOn(Array, 'from');
    try {
      logPtyWrite('pty-1', 'b'.repeat(100_000), 'albedo', T + 1_000);
      expect(from).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
      json.mockRestore();
    }
  });

  it.each([false, true])('looks for the marker at most once per 30 s (on: %s)', async (on) => {
    fs.flag = on;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    logPtyWrite('pty-1', '\r', 'albedo', T);
    await new Promise((r) => setImmediate(r));
    for (let i = 1; i < 50; i++) {
      vi.setSystemTime(T + i * 100);
      logPtyWrite('pty-1', '\r', 'albedo', T + i * 100);
      await new Promise((r) => setImmediate(r));
    }
    expect(fs.existsCalls).toBe(1);
    vi.setSystemTime(T + FLAG_RECHECK_MS + 10);
    logPtyWrite('pty-1', '\r', 'albedo', T + FLAG_RECHECK_MS + 10);
    await new Promise((r) => setImmediate(r));
    expect(fs.existsCalls).toBe(2);
  });

  it('appends one line per write, in order, with the task the pty belongs to; the folder is made once', async () => {
    fs.flag = true;
    notePtyTask('pty-1', 4);
    logPtyWrite('pty-1', '\x1b[200~first message\x1b[201~', 'albedo', T);
    logPtyWrite('pty-1', 'typed', 'terminal', T + 100);
    logPtyWrite('pty-1', '\r', 'albedo', T + 300);
    logPtyWrite('pty-unknown', '\x1b[?1;2c', 'terminal', T + 400);
    await settle();
    expect(lines().map((l) => [l.at, l.taskId, l.origin, l.len, l.head])).toEqual([
      ['2026-11-17T09:00:00.000Z', 4, 'albedo', 25, '\\e[200~first message\\e[201~'],
      ['2026-11-17T09:00:00.300Z', 4, 'albedo', 1, '\\r'],
      ['2026-11-17T09:00:00.400Z', null, 'terminal', 7, '\\e[?1;2c'],
    ]);
    expect(fs.mkdirCalls).toBe(1);
  });

  it('a write made while it was off is not logged once it is on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    logPtyWrite('pty-1', 'a', 'albedo', T);
    await new Promise((r) => setImmediate(r));
    fs.flag = true;
    vi.setSystemTime(T + 1_000);
    logPtyWrite('pty-1', 'b', 'albedo', T + 1_000);
    vi.setSystemTime(T + FLAG_RECHECK_MS + 1_000);
    logPtyWrite('pty-1', 'c', 'albedo', T + FLAG_RECHECK_MS + 1_000);
    await settle();
    expect(lines().map((l) => l.head)).toEqual(['c']);
  });

  it(`moves the log aside past ${MAX_LOG_BYTES} bytes`, async () => {
    fs.flag = true;
    fs.files.set(LOG, 'x'.repeat(MAX_LOG_BYTES - 10) + '\n');
    logPtyWrite('pty-1', '\r', 'albedo', T);
    logPtyWrite('pty-1', '\x1b[A', 'terminal', T + 1);
    await settle();
    expect(fs.files.get(OLD)?.length).toBe(MAX_LOG_BYTES - 9);
    expect(lines().map((l) => l.head)).toEqual(['\\r', '\\e[A']);
  });
});

describe('writePty', () => {
  it('notes its writes by origin, when the log is on', async () => {
    fs.flag = true;
    notePtyTask('pty-9', 2);
    await writePty('pty-9', '\x1b[200~ship it\x1b[201~', 'albedo');
    await writePty('pty-9', 'p');
    await writePty('pty-9', '\r', 'albedo');
    await settle();
    expect(lines().map((l) => [l.taskId, l.head])).toEqual([
      [2, '\\e[200~ship it\\e[201~'],
      [2, '\\r'],
    ]);
  });
});
