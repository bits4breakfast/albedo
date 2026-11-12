/**
 * The byte-offset pieces the watcher, the hook-event reader and the inbox
 * share (#367). Line cuts on raw bytes, ranged reads in bounded passes, and
 * one queue per key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsx = vi.hoisted(() => ({
  bytes: new Uint8Array(0),
  /** The length each `read` asked for. */
  asks: [] as number[],
  /** Most bytes one read hands back; a real read may return fewer than asked. */
  maxPerRead: Infinity,
  seekedTo: -1,
  closed: 0,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  SeekMode: { Start: 0 },
  open: async () => {
    let pos = 0;
    return {
      seek: async (offset: number) => {
        fsx.seekedTo = offset;
        pos = offset;
      },
      read: async (buf: Uint8Array) => {
        fsx.asks.push(buf.length);
        const n = Math.min(buf.length, fsx.maxPerRead, Math.max(0, fsx.bytes.length - pos));
        if (n === 0) return null;
        buf.set(fsx.bytes.subarray(pos, pos + n));
        pos += n;
        return n;
      },
      close: async () => {
        fsx.closed += 1;
      },
    };
  },
}));

const { completeLines, lastNewlineIndex, readRange, serialQueue } = await import('./fileTail');

const enc = new TextEncoder();

beforeEach(() => {
  fsx.bytes = new Uint8Array(0);
  fsx.asks = [];
  fsx.maxPerRead = Infinity;
  fsx.seekedTo = -1;
  fsx.closed = 0;
});

describe('lastNewlineIndex', () => {
  it('finds the final newline', () => {
    expect(lastNewlineIndex(enc.encode('a\nb\n'))).toBe(3);
    expect(lastNewlineIndex(enc.encode('a\nb'))).toBe(1);
  });

  it('returns -1 when no line is complete yet', () => {
    expect(lastNewlineIndex(enc.encode(''))).toBe(-1);
    expect(lastNewlineIndex(enc.encode('{"type":"user"'))).toBe(-1);
  });

  it('never cuts a multi-byte character in half', () => {
    // The last byte of the buffer is the middle of a 3-byte sequence, which is
    // what a mid-append read looks like. Cutting at the newline must yield a
    // prefix that decodes cleanly.
    const full = enc.encode('{"t":"é 日本"}\n{"t":"partial 日');
    const truncated = full.subarray(0, full.length - 1);
    const cut = lastNewlineIndex(truncated);
    expect(cut).toBeGreaterThan(0);
    const prefix = new TextDecoder('utf-8', { fatal: true }).decode(truncated.subarray(0, cut + 1));
    expect(prefix).toBe('{"t":"é 日本"}\n');
  });
});

describe('completeLines', () => {
  it('holds back a trailing partial line, and cuts on bytes, not characters', () => {
    expect(completeLines(enc.encode('{"a":1}\n{"b":'))).toEqual({ text: '{"a":1}\n', consumed: 8 });
    expect(completeLines(enc.encode('{"b":'))).toEqual({ text: '', consumed: 0 });
    const multi = enc.encode('"é"\n');
    expect(completeLines(multi).consumed).toBe(multi.length);
  });

  it('is nothing for nothing', () => {
    expect(completeLines(new Uint8Array(0))).toEqual({ text: '', consumed: 0 });
  });
});

describe('readRange', () => {
  it('reads the range from its offset, in passes of at most 256 KiB, and closes the file', async () => {
    const size = 600 * 1024;
    fsx.bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const got = await readRange('/f', 10, size - 10);
    expect(fsx.seekedTo).toBe(10);
    expect(got).toEqual(fsx.bytes.subarray(10));
    expect(fsx.asks).toEqual([256 * 1024, 256 * 1024, size - 10 - 512 * 1024]);
    expect(fsx.closed).toBe(1);
  });

  it('keeps reading when a read returns fewer bytes than asked', async () => {
    fsx.bytes = enc.encode('abcdefghij');
    fsx.maxPerRead = 3;
    expect(new TextDecoder().decode(await readRange('/f', 0, 10))).toBe('abcdefghij');
  });

  it('returns fewer bytes at the end of the file', async () => {
    fsx.bytes = enc.encode('abc\n');
    const got = await readRange('/f', 1, 100);
    expect(new TextDecoder().decode(got)).toBe('bc\n');
    expect(got.length).toBe(3);
    expect(fsx.closed).toBe(1);
  });
});

describe('serialQueue', () => {
  // Work that rejects also runs the next in line (`then(work, work)`), but
  // leaves the `finally` that tidies the map rejected and unhandled, as both
  // copies did; every caller catches inside its work, so it is not tested here.
  it('runs one key’s work in order, and other keys alongside', async () => {
    const serial = serialQueue<number>();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a1 = serial(1, async () => {
      log.push('a1 start');
      await gate;
      log.push('a1 end');
    });
    const a2 = serial(1, async () => {
      log.push('a2');
    });
    const b1 = serial(2, async () => {
      log.push('b1');
    });
    await b1;
    expect(log).toEqual(['a1 start', 'b1']);
    release();
    await a1;
    await a2;
    expect(log).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
  });

  it('gives each queue its own keys: one reader never waits on another', async () => {
    const hooks = serialQueue<number>();
    const inbox = serialQueue<number>();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = hooks(1, async () => {
      await gate;
      log.push('hook');
    });
    await inbox(1, async () => {
      log.push('inbox');
    });
    expect(log).toEqual(['inbox']);
    release();
    await held;
    expect(log).toEqual(['inbox', 'hook']);
  });
});
