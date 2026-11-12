/**
 * Reading a file that grows, by byte offset: the pieces the transcript
 * watcher, the hook-event reader and the MCP inbox share. Format-free: bytes
 * and whole lines in, nothing parsed here.
 *
 * Each reader keeps its own policy on top -- where its offset lives, how much
 * it reads per pass, what a file shorter than its offset means:
 *
 *   watcher.ts     the offset is in SQLite; reads at most a chunk per pass,
 *                  growing the window until it holds a newline.
 *   hookEvents.ts  the offset is in memory; reads up to the size it just
 *                  stat'ed, and starts over (state too) when the file shrank.
 *   inbox.ts       the offset is in memory; reads the whole file, which is
 *                  emptied after every read, and starts from the top when it
 *                  shrank.
 */

import { open, SeekMode } from '@tauri-apps/plugin-fs';

/** Per-read staging buffer. */
const READ_BUFFER_BYTES = 256 * 1024;

/**
 * Index of the last `\n` in a UTF-8 buffer, or -1.
 *
 * Safe on raw bytes: 0x0A never occurs inside a multi-byte UTF-8 sequence, so
 * cutting here can never split a character. Cutting on the DECODED string
 * would not be safe, because a truncated trailing sequence decodes to U+FFFD
 * and the byte length of the prefix would no longer be recoverable.
 */
export function lastNewlineIndex(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) return i;
  }
  return -1;
}

/**
 * The complete lines at the head of `bytes`, and how many bytes they span.
 * Cut on the raw `\n` byte ({@link lastNewlineIndex}); a trailing partial
 * line waits for its end.
 */
export function completeLines(bytes: Uint8Array): { text: string; consumed: number } {
  const cut = lastNewlineIndex(bytes);
  if (cut < 0) return { text: '', consumed: 0 };
  return { text: new TextDecoder().decode(bytes.subarray(0, cut + 1)), consumed: cut + 1 };
}

/** `length` bytes of `path` from `offset`, or fewer at the end of the file. */
export async function readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
  const file = await open(path, { read: true });
  try {
    await file.seek(offset, SeekMode.Start);
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const buf = new Uint8Array(Math.min(READ_BUFFER_BYTES, length - filled));
      const n = await file.read(buf);
      if (n === null || n <= 0) break;
      out.set(buf.subarray(0, n), filled);
      filled += n;
    }
    return filled === length ? out : out.subarray(0, filled);
  } finally {
    await file.close();
  }
}

/**
 * A queue per key: work for one key runs after the work queued before it,
 * whether that succeeded or failed; different keys do not wait on each other.
 * Two reads of one file at once would apply its lines twice. Each reader has
 * its own queue: a hook-event read never waits on an inbox read.
 */
export function serialQueue<K>(): (key: K, work: () => Promise<void>) => Promise<void> {
  const queues = new Map<K, Promise<void>>();
  return (key, work) => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  };
}
