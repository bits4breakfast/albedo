/**
 * The runtime half of hookEvents: reading the event file incrementally,
 * compacting it, ending a task, installing the script. The Tauri fs plugin is
 * mapped onto node's fs over a temp HOME, so the file handling runs for real.
 */
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fsx = vi.hoisted(() => ({
  home: '',
  watchCb: null as null | ((e: { paths: string[] }) => void),
  writes: [] as string[],
  renames: [] as Array<[string, string]>,
  reads: [] as string[],
  existsAsked: [] as string[],
}));

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => fsx.home }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  SeekMode: { Start: 0 },
  exists: async (p: string) => {
    fsx.existsAsked.push(p);
    return existsSync(p);
  },
  mkdir: async (p: string) => void mkdirSync(p, { recursive: true }),
  readTextFile: async (p: string) => {
    fsx.reads.push(p);
    return readFileSync(p, 'utf8');
  },
  writeTextFile: async (p: string, d: string) => {
    fsx.writes.push(p);
    writeFileSync(p, d);
  },
  rename: async (a: string, b: string) => {
    fsx.renames.push([a, b]);
    renameSync(a, b);
  },
  stat: async (p: string) => {
    const st = statSync(p);
    return { size: st.size, ino: st.ino, mtime: st.mtime };
  },
  watch: async (_p: string, cb: (e: { paths: string[] }) => void) => {
    fsx.watchCb = cb;
    return () => {};
  },
  open: async (p: string) => {
    const fd = openSync(p, 'r');
    let pos = 0;
    return {
      seek: async (o: number) => (pos = o),
      read: async (buf: Uint8Array) => {
        const n = readSync(fd, buf, 0, buf.length, pos);
        pos += n;
        return n;
      },
      close: async () => closeSync(fd),
    };
  },
}));

const {
  COMPACT_AT_BYTES,
  endTaskEvents,
  HOOK_SCRIPT,
  onStatusSnapshot,
  pendingPrompt,
  resetTaskEvents,
  startHookEvents,
  stopHookEvents,
} = await import('./hookEvents');

const events = () => join(fsx.home, '.albedo/events');
const file = (id: number) => join(events(), `task-${id}.jsonl`);
const line = (o: Record<string, unknown>) => `${JSON.stringify({ albedo_at: 1, ...o })}\n`;
const request = (req: string, command = 'ls') =>
  line({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command }, albedo_req: req });
const reqEnd = (req: string) => line({ hook_event_name: 'AlbedoReqEnd', albedo_req: req });

/** What the watcher would deliver for a change to this task's file. */
const touched = (id: number) => fsx.watchCb?.({ paths: [file(id)] });
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  fsx.home = mkdtempSync(join(tmpdir(), 'albedo-rt-'));
  await startHookEvents();
});
afterAll(() => stopHookEvents());

describe('startHookEvents: installing the script', () => {
  it('writes it by rename, and not at all when unchanged', async () => {
    const script = join(fsx.home, '.albedo/hook.sh');
    expect(readFileSync(script, 'utf8')).toBe(HOOK_SCRIPT);
    expect(fsx.renames.some(([a, b]) => b === script && a.endsWith('.tmp'))).toBe(true);
    // A second run (next app launch) with the same script touches nothing.
    await stopHookEvents();
    fsx.writes.length = 0;
    await startHookEvents();
    expect(fsx.writes.filter((p) => p.startsWith(script))).toEqual([]);
  });
});

describe('reading the event file', () => {
  it('reads only appended bytes, holding back a partial line', async () => {
    await resetTaskEvents(1);
    appendFileSync(file(1), request('1-1700000000001', 'first'));
    touched(1);
    await vi.waitFor(() => expect(pendingPrompt(1)).toMatchObject({ requestId: '1-1700000000001' }));
    // Half a line: nothing changes yet.
    const end = reqEnd('1-1700000000001');
    appendFileSync(file(1), end.slice(0, 10));
    touched(1);
    await settle();
    expect(pendingPrompt(1)).toMatchObject({ requestId: '1-1700000000001' });
    appendFileSync(file(1), end.slice(10));
    touched(1);
    await vi.waitFor(() => expect(pendingPrompt(1)).toBeNull());
  });

  it('keeps several requests and shows the oldest until each ends', async () => {
    await resetTaskEvents(2);
    appendFileSync(file(2), request('1-1700000000001', 'a') + request('2-1700000000002', 'b'));
    touched(2);
    await vi.waitFor(() => expect(pendingPrompt(2)).toMatchObject({ summary: 'Bash: a' }));
    appendFileSync(file(2), reqEnd('1-1700000000001'));
    touched(2);
    await vi.waitFor(() => expect(pendingPrompt(2)).toMatchObject({ summary: 'Bash: b' }));
  });

  it('compacts a quiet file past the threshold, keeping lines written after it', async () => {
    await resetTaskEvents(3);
    const filler = line({ hook_event_name: 'PostToolUse', tool_use_id: 'x'.repeat(500) });
    appendFileSync(file(3), filler.repeat(Math.ceil(COMPACT_AT_BYTES / filler.length) + 1) + line({ hook_event_name: 'Stop' }));
    touched(3);
    await vi.waitFor(() => expect(existsSync(file(3))).toBe(false));
    expect(statSync(`${file(3)}.old`).size).toBe(0);
    // The next hook creates a fresh file, read from its start.
    appendFileSync(file(3), request('3-1700000000003'));
    touched(3);
    await vi.waitFor(() => expect(pendingPrompt(3)).toMatchObject({ requestId: '3-1700000000003' }));
  });

  it('does not compact while a request is open', async () => {
    await resetTaskEvents(4);
    const filler = line({ hook_event_name: 'PostToolUse', tool_use_id: 'y'.repeat(500) });
    appendFileSync(file(4), request('4-1700000000004') + filler.repeat(Math.ceil(COMPACT_AT_BYTES / filler.length) + 1));
    touched(4);
    await vi.waitFor(() => expect(pendingPrompt(4)).not.toBeNull());
    expect(existsSync(file(4))).toBe(true);
  });
});

describe('endTaskEvents: the pty exited', () => {
  it('clears the prompt, empties the file, and stops reading it', async () => {
    await resetTaskEvents(5);
    appendFileSync(file(5), request('5-1700000000005'));
    touched(5);
    await vi.waitFor(() => expect(pendingPrompt(5)).not.toBeNull());
    await endTaskEvents(5);
    expect(pendingPrompt(5)).toBeNull();
    expect(readFileSync(file(5), 'utf8')).toBe('');
    // A late line (or watch event) cannot bring the card back.
    appendFileSync(file(5), request('6-1700000000006'));
    touched(5);
    await settle();
    expect(pendingPrompt(5)).toBeNull();
  });
});

describe('the 2 s sweep (#365)', () => {
  const status = (id: number) => join(events(), `status-${id}.json`);
  /** As the hook writes it: a temporary file renamed over the old one. */
  const replaceStatus = (id: number, pct: number) => {
    const tmp = `${status(id)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ albedo_at: 1_700_000_000 + pct, five_pct: pct, session_id: 'a' }));
    renameSync(tmp, status(id));
  };

  it('reads a status file again only once it has been replaced, and the event file with one stat', async () => {
    await stopHookEvents();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const seen: number[] = [];
    const off = onStatusSnapshot((id, snap) => {
      if (id === 40) seen.push(snap.fiveHour?.usedPct ?? -1);
    });
    try {
      await startHookEvents();
      await resetTaskEvents(40);
      replaceStatus(40, 11);
      const sweep = async () => {
        vi.advanceTimersByTime(2_000);
        await settle();
      };
      fsx.reads.length = 0;
      fsx.existsAsked.length = 0;
      await sweep();
      expect(fsx.reads.filter((p) => p === status(40))).toHaveLength(1);
      expect(seen).toEqual([11]);
      // Unchanged: stat only, no read.
      await sweep();
      await sweep();
      expect(fsx.reads.filter((p) => p === status(40))).toHaveLength(1);
      // Replaced, even with the same size: read, and published.
      replaceStatus(40, 12);
      await sweep();
      expect(fsx.reads.filter((p) => p === status(40))).toHaveLength(2);
      expect(seen).toEqual([11, 12]);
      // The event file is asked once per sweep, by stat; never `exists` first.
      expect(fsx.existsAsked.filter((p) => p === file(40))).toEqual([]);
      appendFileSync(file(40), request('40-1700000000040'));
      await sweep();
      expect(pendingPrompt(40)).toMatchObject({ requestId: '40-1700000000040' });
    } finally {
      off();
      await endTaskEvents(40);
      await stopHookEvents();
      vi.useRealTimers();
      await startHookEvents();
    }
  });

  it('still reads a status file the watcher reports, whatever the sweep saw', async () => {
    const seen: number[] = [];
    const off = onStatusSnapshot((id, snap) => {
      if (id === 41) seen.push(snap.fiveHour?.usedPct ?? -1);
    });
    try {
      replaceStatus(41, 30);
      fsx.watchCb?.({ paths: [status(41)] });
      await vi.waitFor(() => expect(seen).toEqual([30]));
      replaceStatus(41, 31);
      fsx.watchCb?.({ paths: [status(41)] });
      await vi.waitFor(() => expect(seen).toEqual([30, 31]));
    } finally {
      off();
    }
  });
});
