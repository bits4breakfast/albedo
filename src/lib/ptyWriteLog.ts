/**
 * A debug log of every write Albedo makes to a pty (#433), off by default.
 *
 * For catching the next occurrence of a send Claude Code did not take: one
 * line per `pty_write` -- keystrokes typed in the terminal, xterm's own
 * replies to the terminal's queries, the message box's pastes and Enters --
 * with when it was written, the task, its length, and its first
 * `HEAD_CHARS` characters with control characters made visible. Never more
 * of the text than that, and never anything the pty wrote: output is not
 * read, here or anywhere (CLAUDE.md).
 *
 * Switch it on with a marker file, and off by removing it; it is looked for
 * at most every `FLAG_RECHECK_MS`, so no restart is needed:
 *
 *     touch ~/.albedo/debug-pty-writes     # on
 *     rm ~/.albedo/debug-pty-writes        # off
 *
 * Lines go to `~/.albedo/logs/pty-writes.jsonl`, beside `sessions.jsonl`.
 * Keystrokes are logged too while it is on: the log stays on this machine,
 * but do not leave it on while typing anything secret in a terminal.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';

/** The marker that switches the log on, under `~/.albedo`. */
export const FLAG_FILE = 'debug-pty-writes';
/** The log, under `~/.albedo/logs`. */
export const LOG_FILE = 'pty-writes.jsonl';
/** How much of each write is kept. */
export const HEAD_CHARS = 40;
/** How often the marker is looked for again. */
export const FLAG_RECHECK_MS = 30_000;

/**
 * `data`'s first `max` characters, with every control character visible:
 * ESC as `\e`, CR `\r`, LF `\n`, tab `\t`, the rest as `\xNN`, and a
 * backslash doubled. A trailing `…` says there was more.
 */
export function visibleHead(data: string, max = HEAD_CHARS): string {
  const chars = Array.from(data);
  let out = '';
  for (const ch of chars.slice(0, max)) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (code === 0x1b) out += '\\e';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return chars.length > max ? `${out}…` : out;
}

export interface PtyWriteLine {
  at: string;
  taskId: number | null;
  ptyId: string;
  /** Characters written (UTF-16 code units, as `data.length`). */
  len: number;
  head: string;
}

/** The log line for one write. */
export function ptyWriteLine(ptyId: string, taskId: number | null, data: string, now = Date.now()): PtyWriteLine {
  return { at: new Date(now).toISOString(), taskId, ptyId, len: data.length, head: visibleHead(data) };
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
    return enabled;
  })();
  return checking;
}

/**
 * Note one write, if the log is on. Never throws and never delays the write:
 * the line is appended in the background, after the lines before it.
 */
export function logPtyWrite(ptyId: string, data: string, now = Date.now()): void {
  const line = ptyWriteLine(ptyId, tasks.get(ptyId) ?? null, data, now);
  const flag = flagFor(now);
  tail = tail
    .then(() => flag)
    .then(async (on) => {
      if (!on) return;
      const dir = `${await albedoDir()}/logs`;
      await mkdir(dir, { recursive: true });
      await writeTextFile(`${dir}/${LOG_FILE}`, `${JSON.stringify(line)}\n`, { append: true });
    })
    .catch(() => {
      /* a debug log failing must never touch the session */
    });
}

/** Test seam. */
export function __resetPtyWriteLog(): Promise<void> {
  const done = tail;
  tasks.clear();
  base = null;
  enabled = false;
  checkedAt = -Infinity;
  checking = null;
  tail = Promise.resolve();
  return done;
}
