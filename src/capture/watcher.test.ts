/**
 * The watcher's filesystem loop needs a running Tauri host, but its offset and
 * line-boundary arithmetic does not — and that arithmetic is exactly where a
 * bug silently loses history. Those helpers are tested here.
 */

import { describe, expect, it } from 'vitest';

import {
  isTranscriptPath,
  lastNewlineIndex,
  lineIndexAfter,
  sessionIdFromPath,
  watermarkFor,
} from './watcher';
import { countLines, parseTranscript, SEQ_STRIDE } from './adapter';

describe('lineIndexAfter / watermarkFor round-trip', () => {
  it('starts at line 0 when nothing has been ingested', () => {
    expect(lineIndexAfter(-1)).toBe(0);
    expect(watermarkFor(0)).toBe(-1);
  });

  it('recovers the next line index from the stored watermark', () => {
    for (const nextLine of [0, 1, 2, 17, 999, 100_000]) {
      expect(lineIndexAfter(watermarkFor(nextLine))).toBe(nextLine);
    }
  });

  it('recovers the next line even when the last lines produced no rows', () => {
    // 12 lines consumed, but only line 3 was a real message (seq 300).
    // Deriving the position from real rows would rewind to line 4 and reparse
    // lines 4..11 forever; the watermark keeps the file position honest.
    const watermark = watermarkFor(12);
    expect(lineIndexAfter(watermark)).toBe(12);
    expect(lineIndexAfter(300)).toBe(4); // what NOT to store
  });

  it('tolerates a corrupt watermark instead of parsing from a negative line', () => {
    expect(lineIndexAfter(Number.NaN)).toBe(0);
    expect(lineIndexAfter(-5000)).toBe(0);
  });
});

describe('lastNewlineIndex', () => {
  const enc = new TextEncoder();

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

describe('tailing arithmetic end to end', () => {
  const lines = [
    '{"type":"mode","mode":"default"}',
    '{"type":"user","sessionId":"s","timestamp":"2026-09-15T10:00:00.000Z","message":{"role":"user","content":"one"}}',
    '{"type":"last-prompt","prompt":"one"}',
    '{"type":"assistant","sessionId":"s","timestamp":"2026-09-15T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}',
    '{"type":"ai-title","aiTitle":"x"}',
    '{"type":"file-history-snapshot","snapshot":{}}',
  ];

  /** Replays what Capture.ingest does, without touching disk. */
  function tail(text: string, lastSeq: number) {
    const fromLine = lineIndexAfter(lastSeq);
    const rows = parseTranscript(text, fromLine);
    return { rows, lastSeq: watermarkFor(fromLine + countLines(text)) };
  }

  it('produces the same rows whether read in one pass or many', () => {
    const whole = lines.join('\n') + '\n';
    const oneShot = tail(whole, -1);

    let watermark = -1;
    const streamed = [];
    for (const line of lines) {
      const pass = tail(line + '\n', watermark);
      streamed.push(...pass.rows);
      watermark = pass.lastSeq;
    }

    expect(streamed.map((r) => r.seq)).toEqual(oneShot.rows.map((r) => r.seq));
    expect(streamed.map((r) => r.seq)).toEqual([100, 300]);
    expect(watermark).toBe(oneShot.lastSeq);
  });

  it('does not rewind when the tail is nothing but bookkeeping lines', () => {
    // lines 4 and 5 produce no rows at all
    const first = tail(lines.slice(0, 4).join('\n') + '\n', -1);
    const second = tail(lines.slice(4).join('\n') + '\n', first.lastSeq);
    expect(second.rows).toEqual([]);
    // next real line must be numbered 6, not 4
    expect(lineIndexAfter(second.lastSeq)).toBe(6);
    const third = tail(
      '{"type":"user","sessionId":"s","timestamp":"2026-09-15T10:00:02.000Z","message":{"role":"user","content":"three"}}\n',
      second.lastSeq,
    );
    expect(third.rows[0]?.seq).toBe(6 * SEQ_STRIDE);
  });

  it('holds back a partial line until its newline arrives', () => {
    const enc = new TextEncoder();
    const complete = lines[1] + '\n';
    const partial = '{"type":"user","sessi';

    const buf = enc.encode(complete + partial);
    const cut = lastNewlineIndex(buf);
    const consumed = cut + 1;
    expect(consumed).toBe(enc.encode(complete).length);

    const text = new TextDecoder().decode(buf.subarray(0, consumed));
    const pass = tail(text, -1);
    expect(pass.rows).toHaveLength(1);
    // position advanced past the complete line only, so the partial line is
    // re-read in full next time
    expect(lineIndexAfter(pass.lastSeq)).toBe(1);
  });
});

describe('path helpers', () => {
  it('recognises transcript files', () => {
    expect(isTranscriptPath('/a/b/c.jsonl')).toBe(true);
    expect(isTranscriptPath('/a/b/c.jsonl.tmp')).toBe(false);
    expect(isTranscriptPath('/a/b')).toBe(false);
  });

  it('falls back to the filename for a session id', () => {
    expect(sessionIdFromPath('/p/-Users-x-proj/abc-123.jsonl')).toBe('abc-123');
    expect(sessionIdFromPath('abc-123.jsonl')).toBe('abc-123');
  });
});
