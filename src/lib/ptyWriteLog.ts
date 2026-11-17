/**
 * A debug log of the writes Albedo makes to a pty (#433), off by default.
 *
 * For catching the next occurrence of a send Claude Code did not take: one
 * line per `pty_write` worth seeing, with when it was written, the task, its
 * length, and its first `HEAD_CHARS` characters with control characters made
 * visible. Never more of the text than that, and never anything the pty
 * wrote: output is not read, here or anywhere (CLAUDE.md).
 *
 * What is logged:
 *  - everything Albedo writes itself (`origin: 'albedo'`): the message box's
 *    pastes and Enters, a note typed into the prompt;
 *  - from the terminal, only escape sequences: xterm's replies to the
 *    terminal's queries and special keys. A paste into the terminal is
 *    logged as its marker alone (`\e[200~<paste>`), and plain typed
 *    keystrokes not at all, so nothing typed there -- a password -- is kept.
 *
 * Switch it on with a marker file, and off by removing it; it is looked for
 * at most every `FLAG_RECHECK_MS`, so no restart is needed:
 *
 *     touch ~/.albedo/debug-pty-writes     # on
 *     rm ~/.albedo/debug-pty-writes        # off
 *
 * Lines go to `~/.albedo/logs/pty-writes.jsonl`, beside `sessions.jsonl`.
 * Past `MAX_LOG_BYTES` the file is moved to `pty-writes.1.jsonl`, replacing
 * the one before, and a new one is started.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, mkdir, rename, stat, writeTextFile } from '@tauri-apps/plugin-fs';

/** Who made a write: Albedo itself, or the terminal (keystrokes, xterm's replies). */
export type PtyWriteOrigin = 'albedo' | 'terminal';

/** The marker that switches the log on, under `~/.albedo`. */
export const FLAG_FILE = 'debug-pty-writes';
/** The log, under `~/.albedo/logs`, and where it goes when full. */
export const LOG_FILE = 'pty-writes.jsonl';
export const OLD_LOG_FILE = 'pty-writes.1.jsonl';
/** How big the log may grow before it is moved aside. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** How much of each write is kept. */
export const HEAD_CHARS = 40;
/** How often the marker is looked for again. */
export const FLAG_RECHECK_MS = 30_000;
/** A terminal write longer than this, not a paste, is typed text rather than a key or a reply. */
const TERMINAL_SEQUENCE_MAX = 64;

/**
 * `data`'s first `max` characters, with every control character visible:
 * ESC as `\e`, CR `\r`, LF `\n`, tab `\t`, the rest as `\xNN`, and a
 * backslash doubled. A trailing `…` says there was more. Only the start of
 * `data` is ever looked at.
 */
export function visibleHead(data: string, max = HEAD_CHARS): string {
  // `max` characters take at most 2 * max code units; a surrogate pair cut
  // at the end of the slice lies past the first `max` characters.
  const chars = Array.from(data.slice(0, max * 2)).slice(0, max);
  let out = '';
  let used = 0;
  for (const ch of chars) {
    used += ch.length;
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (code === 0x1b) out += '\\e';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return used < data.length ? `${out}…` : out;
}

/**
 * What the log keeps of a write, or null for one it never logs: a plain
 * keystroke, or typed text, from the terminal.
 */
export function loggedHead(data: string, origin: PtyWriteOrigin): string | null {
  if (origin === 'albedo') return visibleHead(data);
  if (data.startsWith('\x1b[200~')) return '\\e[200~<paste>';
  if (data.length > TERMINAL_SEQUENCE_MAX || !data.includes('\x1b')) return null;
  return visibleHead(data);
}

export interface PtyWriteLine {
  at: string;
  taskId: number | null;
  ptyId: string;
  origin: PtyWriteOrigin;
  /** Characters written (UTF-16 code units, as `data.length`). */
  len: number;
  head: string;
}

/** The log line for one write, or null when it is not logged (`loggedHead`). */
export function ptyWriteLine(
  ptyId: string,
  taskId: number | null,
  data: string,
  origin: PtyWriteOrigin,
  now = Date.now(),
): PtyWriteLine | null {
  const head = loggedHead(data, origin);
  if (head === null) return null;
  return { at: new Date(now).toISOString(), taskId, ptyId, origin, len: data.length, head };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const tasks = new Map<string, number>();

/** Which task a pty belongs to, for the log (Terminal.tsx, as it registers one). */
export function notePtyTask(ptyId: string, taskId: number): void {
  tasks.set(ptyId, taskId);
}

let base: Promise<string> | null = null;
let enabled = false;
let checkedAt = -Infinity;
let checking: Promise<boolean> | null = null;
/** The logs folder, made once. */
let logDir: Promise<string> | null = null;
/** The log's size as last known; null until read. */
let size: number | null = null;
/** Appends in order, one after the other. */
let tail: Promise<void> = Promise.resolve();

function albedoDir(): Promise<string> {
  base ??= homeDir().then((h) => `${h.replace(/\/+$/, '')}/.albedo`);
  return base;
}

/**
 * Whether the log is on for a write made at `now`: the last look at the
 * marker, or a new one if that is older than `FLAG_RECHECK_MS`. Decided per
 * write, so a write made while it was off is never logged once it is on.
 */
function flagFor(now: number): Promise<boolean> {
  if (now - checkedAt < FLAG_RECHECK_MS) return Promise.resolve(enabled);
  checking ??= (async () => {
    try {
      enabled = await exists(`${await albedoDir()}/${FLAG_FILE}`);
    } catch {
      enabled = false; // not inside Tauri, or no access: off
      base = null;
    } finally {
      checkedAt = Date.now();
      checking = null;
    }
    if (!enabled) size = null; // read again when it is next switched on
    return enabled;
  })();
  return checking;
}

async function append(line: PtyWriteLine): Promise<void> {
  logDir ??= albedoDir().then(async (dir) => {
    await mkdir(`${dir}/logs`, { recursive: true });
    return `${dir}/logs`;
  });
  let dir: string;
  try {
    dir = await logDir;
  } catch (err) {
    logDir = null; // try again next time
    throw err;
  }
  const path = `${dir}/${LOG_FILE}`;
  const text = `${JSON.stringify(line)}\n`;
  if (size === null) {
    try {
      size = (await stat(path)).size;
    } catch {
      size = 0; // not there yet
    }
  }
  if (size > 0 && size + text.length > MAX_LOG_BYTES) {
    await rename(path, `${dir}/${OLD_LOG_FILE}`);
    size = 0;
  }
  await writeTextFile(path, text, { append: true });
  size += text.length;
}

/**
 * Note one write, if the log is on. Never throws and never delays the write:
 * the line is appended in the background, after the lines before it. Off,
 * and looked for lately, it does nothing at all.
 */
export function logPtyWrite(ptyId: string, data: string, origin: PtyWriteOrigin, now = Date.now()): void {
  if (!enabled && now - checkedAt < FLAG_RECHECK_MS) return;
  const line = ptyWriteLine(ptyId, tasks.get(ptyId) ?? null, data, origin, now);
  if (line === null) return;
  const flag = flagFor(now);
  tail = tail
    .then(() => flag)
    .then((on) => (on ? append(line) : undefined))
    .catch(() => {
      /* a debug log failing must never touch the session */
    });
}

/** Test seam: wait for what is being written, then forget everything. */
export function __resetPtyWriteLog(): Promise<void> {
  const done = tail;
  tasks.clear();
  base = null;
  enabled = false;
  checkedAt = -Infinity;
  checking = null;
  logDir = null;
  size = null;
  tail = Promise.resolve();
  return done;
}
