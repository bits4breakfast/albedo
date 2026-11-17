/**
 * The debug log of what Albedo writes to a pty (#433): off unless its marker
 * exists, one line per write, and never more of the text than its head.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  flag: false,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), Channel: class {} }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/Users/someone/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async (p: string) => fs.flag && p === '/Users/someone/.albedo/debug-pty-writes'),
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async (p: string, text: string, opts?: { append?: boolean }) => {
    fs.files.set(p, (opts?.append ? (fs.files.get(p) ?? '') : '') + text);
  }),
}));

const { FLAG_RECHECK_MS, HEAD_CHARS, __resetPtyWriteLog, logPtyWrite, notePtyTask, ptyWriteLine, visibleHead } = await import('./ptyWriteLog');

const { writePty } = await import('./pty');

const LOG = '/Users/someone/.albedo/logs/pty-writes.jsonl';
const T = Date.parse('2026-11-17T09:00:00.000Z');

/** Let the background appends finish. */
const settle = () => __resetPtyWriteLog();
const lines = () => (fs.files.get(LOG) ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  fs.files.clear();
  fs.flag = false;
});
afterEach(async () => {
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
    const text = 'x'.repeat(HEAD_CHARS + 25);
    expect(visibleHead(text)).toBe(`${'x'.repeat(HEAD_CHARS)}\u2026`);
    expect(visibleHead('x'.repeat(HEAD_CHARS))).toBe('x'.repeat(HEAD_CHARS));
  });

  it('never splits a character in two', () => {
    expect(visibleHead('😀😀😀', 2)).toBe('😀😀\u2026');
  });
});

describe('ptyWriteLine', () => {
  it('has the time, the task, the length and the head -- not the rest of the text', () => {
    const body = `\x1b[200~${'please look at the flaky retry test in the queue worker'}\x1b[201~`;
    const line = ptyWriteLine('pty-7', 3, body, T);
    expect(line).toEqual({
      at: '2026-11-17T09:00:00.000Z',
      taskId: 3,
      ptyId: 'pty-7',
      len: body.length,
      head: '\\e[200~please look at the flaky retry tes\u2026',
    });
    expect(JSON.stringify(line)).not.toContain('queue worker');
  });
});

describe('logPtyWrite', () => {
  it('writes nothing while the marker is absent', async () => {
    logPtyWrite('pty-1', 'hello', T);
    await settle();
    expect(fs.files.size).toBe(0);
  });

  it('appends one line per write, in order, with the task the pty belongs to', async () => {
    fs.flag = true;
    notePtyTask('pty-1', 4);
    logPtyWrite('pty-1', '\x1b[200~first message\x1b[201~', T);
    logPtyWrite('pty-1', '\r', T + 300);
    logPtyWrite('pty-unknown', '\x1b[?1;2c', T + 400);
    await settle();
    expect(lines()).toEqual([
      { at: '2026-11-17T09:00:00.000Z', taskId: 4, ptyId: 'pty-1', len: 25, head: '\\e[200~first message\\e[201~' },
      { at: '2026-11-17T09:00:00.300Z', taskId: 4, ptyId: 'pty-1', len: 1, head: '\\r' },
      { at: '2026-11-17T09:00:00.400Z', taskId: null, ptyId: 'pty-unknown', len: 7, head: '\\e[?1;2c' },
    ]);
  });

  it('looks for the marker again only after a while: switched on without a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    try {
      logPtyWrite('pty-1', 'a', Date.now());
      await new Promise((r) => setImmediate(r));
      fs.flag = true;
      vi.setSystemTime(T + 1_000);
      logPtyWrite('pty-1', 'b', Date.now());
      vi.setSystemTime(T + FLAG_RECHECK_MS + 1_000);
      logPtyWrite('pty-1', 'c', Date.now());
      await settle();
      expect(lines().map((l) => l.head)).toEqual(['c']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('writePty', () => {
  it('notes every write it makes, when the log is on', async () => {
    fs.flag = true;
    notePtyTask('pty-9', 2);
    await writePty('pty-9', '\x1b[200~ship it\x1b[201~');
    await writePty('pty-9', '\r');
    await settle();
    expect(lines().map((l) => [l.taskId, l.head])).toEqual([
      [2, '\\e[200~ship it\\e[201~'],
      [2, '\\r'],
    ]);
  });
});
