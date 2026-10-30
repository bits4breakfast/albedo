/**
 * The runtime half of inbox.ts: reading task files as lines arrive, leaving a
 * half-written line for later, compacting by rename, never handing a request
 * on twice. The Tauri fs plugin is mapped onto node's fs over a temp HOME, so
 * the file handling runs for real.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fsx = vi.hoisted(() => ({
  home: '',
  watchCb: null as null | ((e: { paths: string[] }) => void),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => fsx.home }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => existsSync(p),
  mkdir: async (p: string) => void mkdirSync(p, { recursive: true }),
  readDir: async (p: string) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() })),
  readFile: async (p: string) => new Uint8Array(readFileSync(p)),
  rename: async (a: string, b: string) => renameSync(a, b),
  stat: async (p: string) => ({ size: statSync(p).size }),
  writeTextFile: async (p: string, d: string) => writeFileSync(p, d),
  watch: async (_p: string, cb: (e: { paths: string[] }) => void) => {
    fsx.watchCb = cb;
    return () => {};
  },
  readTextFile: async (p: string) => readFileSync(p, 'utf8'),
  open: vi.fn(),
  SeekMode: { Start: 0 },
}));

const { readInbox, startInbox, stopInbox } = await import('./inbox');
type Req = Parameters<Parameters<typeof startInbox>[0]>[0];

const inbox = () => join(fsx.home, '.albedo/inbox');
const file = (id: number) => join(inbox(), `task-${id}.jsonl`);
const line = (id: string, task = 5, message = `msg ${id}`) =>
  `${JSON.stringify({ v: 1, task, tool: 'notify_blocked', args: { message }, at: 1_000, id })}\n`;

let got: Req[] = [];

beforeAll(() => {
  fsx.home = mkdtempSync(join(tmpdir(), 'albedo-inbox-'));
});
afterAll(() => stopInbox());
beforeEach(async () => {
  await stopInbox();
  got = [];
});

describe('startInbox', () => {
  it('creates the inbox and hands on what arrived while Albedo was closed', async () => {
    mkdirSync(inbox(), { recursive: true });
    writeFileSync(file(5), line('early-1') + line('early-2'));
    await startInbox((r) => got.push(r));
    expect(got.map((r) => r.id)).toEqual(['early-1', 'early-2']);
    // Read whole, so compacted: renamed aside and emptied.
    expect(existsSync(file(5))).toBe(false);
    expect(readFileSync(`${file(5)}.old`, 'utf8')).toBe('');
  });

  it('reads a leftover renamed copy once at start (a crash between rename and empty)', async () => {
    mkdirSync(inbox(), { recursive: true });
    writeFileSync(`${file(6)}.old`, line('left-1', 6));
    await startInbox((r) => got.push(r));
    expect(got.map((r) => r.id)).toEqual(['left-1']);
    expect(readFileSync(`${file(6)}.old`, 'utf8')).toBe('');
  });
});

describe('reading as lines arrive', () => {
  it('waits for a half-written line, then reads it whole, once', async () => {
    await startInbox((r) => got.push(r));
    const whole = line('half-1');
    appendFileSync(file(5), whole.slice(0, 20));
    fsx.watchCb?.({ paths: [file(5)] });
    await readInbox();
    expect(got).toEqual([]);
    expect(existsSync(file(5))).toBe(true); // not compacted under a line being written
    appendFileSync(file(5), whole.slice(20));
    await readInbox();
    expect(got.map((r) => r.id)).toEqual(['half-1']);
    await readInbox();
    expect(got.map((r) => r.id)).toEqual(['half-1']);
  });

  it('drops a line from another task\'s file, and keeps reading after it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startInbox((r) => got.push(r));
    appendFileSync(file(5), line('spoof', 9) + 'garbage\n' + line('ok-1'));
    await readInbox();
    expect(got.map((r) => r.id)).toEqual(['ok-1']);
    expect(got[0]!.taskId).toBe(5);
    warn.mockRestore();
  });

  it('never hands the same id on twice, even if a line comes back', async () => {
    await startInbox((r) => got.push(r));
    appendFileSync(file(5), line('dup-1'));
    await readInbox();
    appendFileSync(file(5), line('dup-1'));
    await readInbox();
    expect(got.map((r) => r.id)).toEqual(['dup-1']);
  });

  it('a listener that throws does not stop the next request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startInbox((r) => {
      if (r.id === 'boom') throw new Error('x');
      got.push(r);
    });
    appendFileSync(file(5), line('boom') + line('after-boom'));
    await readInbox();
    expect(got.map((r) => r.id)).toEqual(['after-boom']);
    warn.mockRestore();
  });

  it('ignores files that are not a task\'s', async () => {
    await startInbox((r) => got.push(r));
    writeFileSync(join(inbox(), 'notes.jsonl'), line('stray'));
    await readInbox();
    expect(got).toEqual([]);
  });
});
