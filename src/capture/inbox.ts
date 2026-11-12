/**
 * Albedo's MCP inbox (#157): what a session asked Albedo for.
 *
 * ## A narrow channel, by decision
 *
 * CLAUDE.md, "Two channels": every session Albedo starts gets Albedo's MCP
 * server (`src-tauri/mcp`, a Rust binary bundled beside the app) through
 * `--mcp-config`, with `ALBEDO_TASK_ID` in its environment. It offers five
 * tools and nothing else -- `create_reminder`, `request_session`,
 * `notify_blocked`, `set_task_summary` (#262: one line shown under the
 * task's title, never acted on), and `show_preview` (#348, below) -- and a
 * call that passes its checks is
 * appended as one JSON line to `~/.albedo/inbox/task-<id>.jsonl`. This module reads those
 * files. It is the only file in the app that knows the line's shape, as
 * hookEvents.ts is for hook payloads.
 *
 *   spawn `claude --mcp-config <json>`      (sessionSpawn.ts, withMcpConfig)
 *     the agent calls mcp__albedo__<tool>
 *       albedo-mcp appends one line to ~/.albedo/inbox/task-<id>.jsonl
 *         this module reads it, checks it again, hands it on (requestQueue.ts,
 *         which writes a summary to tasks.summary rather than queueing it)
 *
 * Only the agent starts anything here; what the user starts goes through
 * Albedo directly. For four of the tools nothing flows back: the server
 * answers the agent at once, and never learns what the user did.
 *
 * ## The one that waits: `show_preview` (#348)
 *
 * A fifth tool shows the user an HTML mockup and waits for their answer. Its
 * line carries the title, question and note, and the call's transcript id;
 * the page itself the server has copied to `~/.albedo/previews` under the
 * line's id (`previewGate.ts` reads it). A second line,
 * `preview_cancelled`, is the server's record that such a call ended without
 * an answer. Both go to {@link onPreviewLine}, not to the request queue: the
 * answer goes back through a file only `previewGate.ts` writes.
 *
 * ## Nothing in a line is trusted
 *
 * The server runs inside the session, so each line is checked again here:
 * known version and tool, the task id in the line equal to the one in the
 * file name (the id Albedo itself put in the server's environment), every
 * field a string within the same caps the server applies, no control
 * characters where one line is meant. A line that fails is dropped whole.
 *
 * ## Reading
 *
 * As the hook files: only complete lines are consumed (a partial last line
 * waits for its newline), and a file is renamed aside before it is emptied,
 * so a line appended meanwhile lands in the renamed file and is read there.
 * Unlike the hook files, a line here is a one-off request, so once read the
 * file is compacted straight away: what was read is the queue's to keep.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { exists, mkdir, readDir, readFile, rename, stat, watch, writeTextFile, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { completeLines, serialQueue } from './fileTail';
import { ALBEDO_DIR } from './hookEvents';

// ---------------------------------------------------------------------------
// The line -- FORMAT KNOWLEDGE lives here and in src-tauri/mcp
// ---------------------------------------------------------------------------

/** The line format's version (`inbox::LINE_VERSION` in the server). */
export const INBOX_VERSION = 1;

/** The longest line, newline included (`inbox::MAX_LINE_BYTES`). */
export const MAX_LINE_BYTES = 65_536;

/** Field caps, in characters: the same as `src-tauri/mcp/src/tools.rs`. */
export const CAPS = {
  reminderText: 500,
  reminderSummary: 4_000,
  due: 64,
  title: 120,
  prompt: 16_000,
  reason: 1_000,
  project: 200,
  branch: 200,
  message: 1_000,
  taskSummary: 120,
  // show_preview (#348): `tools::MAX_PREVIEW_*`; the reason is `preview::clean_reason`'s.
  previewTitle: 120,
  previewQuestion: 1_000,
  previewNote: 200,
  cancelReason: 200,
} as const;

/** `request_session`'s `start` (`tools::START_BRIEF` / `START_FORK`). */
export type SessionStart = 'brief' | 'fork';

export type InboxTool = 'create_reminder' | 'request_session' | 'notify_blocked' | 'set_task_summary';

interface Base {
  /** Unique per line; the server makes it from its pid, the time and a counter. */
  id: string;
  /** The task whose session asked: the file's, checked against the line's. */
  taskId: number;
  /** When the server wrote it, in ms. */
  at: number;
}

export type InboxRequest =
  | (Base & { tool: 'create_reminder'; text: string; due: string; dueMs: number; summary: string })
  | (Base & {
      tool: 'request_session';
      title: string;
      prompt: string;
      reason: string;
      project: string | null;
      branch: string | null;
      /**
       * How Claude suggests the new session begins (#332): a fresh session
       * from the brief, or a copy of this conversation. Absent reads as
       * 'brief'. Only a suggestion: New Task preselects it, the user picks.
       */
      start: SessionStart;
    })
  | (Base & { tool: 'notify_blocked'; message: string })
  | (Base & { tool: 'set_task_summary'; summary: string });

const ID = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
// Control characters: C0 and DEL, and the C1 range.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// The same, allowing newline and tab.
// eslint-disable-next-line no-control-regex
const CONTROL_MULTI = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

type Args = Record<string, unknown>;

/** A present, trimmed, non-empty string within `max` characters, or null. */
function text(args: Args, key: string, max: number, multiline: boolean): string | null {
  const v = args[key];
  if (typeof v !== 'string') return null;
  if (v !== v.trim() || v.length === 0) return null;
  if ([...v].length > max) return null;
  if ((multiline ? CONTROL_MULTI : CONTROL).test(v)) return null;
  return v;
}

function optionalText(args: Args, key: string, max: number): string | null | undefined {
  if (args[key] === undefined) return null;
  return text(args, key, max, false) ?? undefined;
}

function onlyKeys(args: Args, keys: readonly string[]): boolean {
  return Object.keys(args).every((k) => keys.includes(k));
}

function branchOk(b: string): boolean {
  return (
    BRANCH.test(b) &&
    !/^[-/.]/.test(b) &&
    !/[/.]$/.test(b) &&
    !b.includes('..') &&
    !b.includes('//')
  );
}

/**
 * A `show_preview` call (#348), or the server's record that one ended without
 * an answer. Not a queued request: see the module header.
 */
export type PreviewLine =
  | (Base & {
      tool: 'show_preview';
      title: string;
      question: string | null;
      note: string | null;
      /** Claude Code's id for the call in the transcript, when it gave one. */
      toolUseId: string | null;
    })
  | (Base & {
      tool: 'preview_cancelled';
      /** The `show_preview` line's id. */
      request: string;
      /** Claude Code's reason, e.g. "AbortError: user-cancel", or "session ended". */
      reason: string;
    });

/** The checks every line shares: version, the task's own file, id, time, args. */
function lineHead(line: string, fileTaskId: number): { base: Base; tool: unknown; a: Args } | null {
  if (line.length === 0 || new TextEncoder().encode(line).length >= MAX_LINE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== INBOX_VERSION) return null;
  // The identity rule: a line names the task whose file it is in, or it is not one.
  if (o.task !== fileTaskId || !Number.isSafeInteger(fileTaskId) || fileTaskId <= 0) return null;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at <= 0) return null;
  const args = o.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return { base: { id: o.id, taskId: fileTaskId, at: o.at }, tool: o.tool, a: args as Args };
}

const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * One preview line of `task-<fileTaskId>.jsonl`, or null when it is anything
 * but a well-formed `show_preview` or `preview_cancelled` from that task.
 */
export function parsePreviewLine(line: string, fileTaskId: number): PreviewLine | null {
  const head = lineHead(line, fileTaskId);
  if (!head) return null;
  const { base, tool, a } = head;
  if (tool === 'show_preview') {
    if (!onlyKeys(a, ['title', 'question', 'note', 'toolUseId'])) return null;
    const title = text(a, 'title', CAPS.previewTitle, false);
    const question = a.question === undefined ? null : text(a, 'question', CAPS.previewQuestion, true);
    const note = optionalText(a, 'note', CAPS.previewNote);
    if (title === null || (a.question !== undefined && question === null) || note === undefined) return null;
    const t = a.toolUseId;
    if (t !== undefined && (typeof t !== 'string' || !TOOL_USE_ID.test(t))) return null;
    return { ...base, tool: 'show_preview', title, question, note, toolUseId: typeof t === 'string' ? t : null };
  }
  if (tool === 'preview_cancelled') {
    if (!onlyKeys(a, ['request', 'reason'])) return null;
    const request = a.request;
    const reason = text(a, 'reason', CAPS.cancelReason, false);
    if (typeof request !== 'string' || !ID.test(request) || reason === null) return null;
    return { ...base, tool: 'preview_cancelled', request, reason };
  }
  return null;
}

/**
 * One line of `task-<fileTaskId>.jsonl`, or null when it is anything but a
 * well-formed request from that task. Never throws.
 */
export function parseInboxLine(line: string, fileTaskId: number): InboxRequest | null {
  const head = lineHead(line, fileTaskId);
  if (!head) return null;
  const { base, a } = head;

  switch (head.tool) {
    case 'create_reminder': {
      if (!onlyKeys(a, ['text', 'due', 'dueMs', 'summary'])) return null;
      const t = text(a, 'text', CAPS.reminderText, false);
      const due = text(a, 'due', CAPS.due, false);
      const summary = text(a, 'summary', CAPS.reminderSummary, true);
      const dueMs = a.dueMs;
      if (t === null || due === null || summary === null) return null;
      if (typeof dueMs !== 'number' || !Number.isSafeInteger(dueMs)) return null;
      // The two must agree: the server computed one from the other.
      const parsed = Date.parse(due);
      if (!Number.isFinite(parsed) || Math.abs(parsed - dueMs) >= 1000) return null;
      return { ...base, tool: 'create_reminder', text: t, due, dueMs, summary };
    }
    case 'request_session': {
      if (!onlyKeys(a, ['title', 'prompt', 'reason', 'project', 'branch', 'start'])) return null;
      const title = text(a, 'title', CAPS.title, false);
      const prompt = text(a, 'prompt', CAPS.prompt, true);
      const reason = text(a, 'reason', CAPS.reason, true);
      const project = optionalText(a, 'project', CAPS.project);
      const branch = optionalText(a, 'branch', CAPS.branch);
      if (title === null || prompt === null || reason === null) return null;
      if (project === undefined || branch === undefined) return null;
      if (branch !== null && !branchOk(branch)) return null;
      // Absent is the default; anything but the two values is not a request.
      const start = a.start === undefined ? 'brief' : a.start;
      if (start !== 'brief' && start !== 'fork') return null;
      return { ...base, tool: 'request_session', title, prompt, reason, project, branch, start };
    }
    case 'notify_blocked': {
      if (!onlyKeys(a, ['message'])) return null;
      const message = text(a, 'message', CAPS.message, true);
      if (message === null) return null;
      return { ...base, tool: 'notify_blocked', message };
    }
    case 'set_task_summary': {
      if (!onlyKeys(a, ['summary'])) return null;
      const summary = text(a, 'summary', CAPS.taskSummary, false);
      if (summary === null) return null;
      return { ...base, tool: 'set_task_summary', summary };
    }
    default:
      return null;
  }
}

/** Every well-formed line in `text`, in order: requests, and preview lines. */
export function parseAllLines(text: string, fileTaskId: number): { reqs: InboxRequest[]; previews: PreviewLine[] } {
  const reqs: InboxRequest[] = [];
  const previews: PreviewLine[] = [];
  for (const line of text.split('\n')) {
    const req = parseInboxLine(line, fileTaskId);
    if (req) {
      reqs.push(req);
      continue;
    }
    const p = parsePreviewLine(line, fileTaskId);
    if (p) previews.push(p);
    else if (line.trim().length > 0) console.warn(`[inbox] dropped a malformed line from task ${fileTaskId}`);
  }
  return { reqs, previews };
}

/** Every well-formed request in `text`, in order. */
export function parseInboxLines(text: string, fileTaskId: number): InboxRequest[] {
  return parseAllLines(text, fileTaskId).reqs;
}

/**
 * A request back in its line form, for keeping it across a restart
 * (requestQueue.ts stores these). Read back with {@link decodeStoredRequest},
 * which checks it exactly as a line from the inbox.
 */
export function encodeRequest(r: InboxRequest): string {
  const { id, taskId, at, tool } = r;
  const args =
    r.tool === 'create_reminder'
      ? { text: r.text, due: r.due, dueMs: r.dueMs, summary: r.summary }
      : r.tool === 'request_session'
        ? {
            title: r.title,
            prompt: r.prompt,
            reason: r.reason,
            ...(r.project !== null ? { project: r.project } : {}),
            ...(r.branch !== null ? { branch: r.branch } : {}),
            ...(r.start !== 'brief' ? { start: r.start } : {}),
          }
        : r.tool === 'notify_blocked'
          ? { message: r.message }
          : { summary: r.summary };
  return JSON.stringify({ v: INBOX_VERSION, task: taskId, tool, args, at, id });
}

/** A stored request, or null when it is not one. */
export function decodeStoredRequest(line: unknown): InboxRequest | null {
  if (typeof line !== 'string') return null;
  try {
    const task = (JSON.parse(line) as { task?: unknown }).task;
    return typeof task === 'number' ? parseInboxLine(line, task) : null;
  } catch {
    return null;
  }
}

const TASK_FILE = /(?:^|\/)task-(\d+)\.jsonl(\.old)?$/;

/** The task id a path in the inbox names, or null. */
export function inboxTaskOf(path: string): number | null {
  const m = TASK_FILE.exec(path);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Where the server is
// ---------------------------------------------------------------------------

let serverPath: Promise<string | null> | null = null;

/**
 * The server binary's absolute path, or null when this build has none
 * (`src-tauri/src/mcp.rs`). Asked once per run. Never throws: a session
 * without the server is a session as it was before #157.
 */
export function mcpServerPath(): Promise<string | null> {
  serverPath ??= invoke<string | null>('mcp_server_path')
    .then((p) => {
      if (!p) console.warn('[inbox] no albedo-mcp beside the app: sessions start without Albedo\'s MCP server');
      return p ?? null;
    })
    .catch((err: unknown) => {
      console.warn('[inbox] could not locate albedo-mcp', err);
      return null;
    });
  return serverPath;
}

// ---------------------------------------------------------------------------
// Runtime: watch the inbox, hand each request on once
// ---------------------------------------------------------------------------

export type InboxListener = (req: InboxRequest) => void;
export type PreviewListener = (line: PreviewLine) => void;

let listener: InboxListener | null = null;
const previewListeners = new Set<PreviewListener>();

/**
 * Preview lines (#348), each once, in the order they were written. Subscribe
 * before {@link startInbox} so a line read at launch is not missed.
 */
export function onPreviewLine(cb: PreviewListener): () => void {
  previewListeners.add(cb);
  return () => {
    previewListeners.delete(cb);
  };
}
let started: Promise<void> | null = null;
let unwatch: UnwatchFn | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let base: string | null = null;

/** How far each task's file has been read. */
const offsets = new Map<number, number>();

/**
 * Ids already handed on this run. A crash between reading a file and
 * emptying its renamed copy would hand the same lines on again at the next
 * read; the queue drops ids it has seen too (requestQueue.ts).
 */
const seen = new Set<string>();
const SEEN_MAX = 2_000;

function firstTime(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  return true;
}

function deliver(read: { reqs: readonly InboxRequest[]; previews: readonly PreviewLine[] }): void {
  for (const r of read.reqs) {
    if (!firstTime(r.id)) continue;
    try {
      listener?.(r);
    } catch (err) {
      console.warn('[inbox] a request could not be handled', err);
    }
  }
  for (const p of read.previews) {
    if (!firstTime(p.id)) continue;
    for (const cb of [...previewListeners]) {
      try {
        cb(p);
      } catch (err) {
        console.warn('[inbox] a preview line could not be handled', err);
      }
    }
  }
}

/** The complete lines of `path` past `offset`: what they hold, and the new offset. */
async function readPast(
  path: string,
  offset: number,
  taskId: number,
): Promise<{ reqs: InboxRequest[]; previews: PreviewLine[]; offset: number }> {
  const bytes = await readFile(path);
  const from = bytes.length < offset ? 0 : offset; // emptied under us: from the top
  const { text, consumed } = completeLines(bytes.subarray(from));
  return { ...parseAllLines(text, taskId), offset: from + consumed };
}

/** Per-task queue, its own: two reads of one file at once would hand its lines on twice. */
const serial = serialQueue<number>();

/**
 * Read a task's file and, when nothing is left half-written, compact it:
 * rename it aside (a server appending now creates a fresh file), read
 * whatever reached the renamed copy since, then empty the copy.
 */
function readTask(taskId: number): Promise<void> {
  return serial(taskId, async () => {
    if (base === null) return;
    const path = `${base}/task-${taskId}.jsonl`;
    try {
      if (!(await exists(path))) {
        offsets.delete(taskId);
        return;
      }
      const first = await readPast(path, offsets.get(taskId) ?? 0, taskId);
      offsets.set(taskId, first.offset);
      deliver(first);
      const size = (await stat(path)).size;
      if (size === 0 || first.offset !== size) return; // a line is being written: next time
      const aside = `${path}.old`;
      await rename(path, aside);
      offsets.delete(taskId);
      try {
        const rest = await readPast(aside, first.offset, taskId);
        deliver(rest);
      } finally {
        await writeTextFile(aside, '');
      }
    } catch (err) {
      // Unreadable this time; the next read retries from the same offset.
      console.warn(`[inbox] could not read task ${taskId}'s inbox`, err);
    }
  });
}

/** A copy left by a crash between renaming and emptying: read it once, then empty it. */
async function readLeftover(path: string, taskId: number): Promise<void> {
  try {
    const read = await readPast(path, 0, taskId);
    deliver(read);
    if (read.reqs.length + read.previews.length > 0) await writeTextFile(path, '');
  } catch {
    /* nothing to recover */
  }
}

/** Read every task's file now. Exported for tests and for a manual refresh. */
export async function readInbox(): Promise<void> {
  if (base === null) return;
  let names: string[] = [];
  try {
    names = (await readDir(base)).filter((e) => e.isFile).map((e) => e.name);
  } catch {
    return;
  }
  const work: Promise<void>[] = [];
  for (const name of names) {
    const id = inboxTaskOf(name);
    if (id === null || name.endsWith('.old')) continue;
    work.push(readTask(id));
  }
  await Promise.all(work);
}

/** How often the inbox is read even without a watch event: a watcher can go quiet. */
export const INBOX_POLL_MS = 3_000;

/**
 * Start reading the inbox and hand every request to `onRequest`, once.
 * Idempotent; a later call replaces the listener. Requests that arrived while
 * Albedo was closed are handed on at the first read, with their own `at`.
 */
export async function startInbox(onRequest: InboxListener): Promise<void> {
  listener = onRequest;
  started ??= (async () => {
    const dir = `${(await homeDir()).replace(/\/+$/, '')}/${ALBEDO_DIR}/inbox`;
    await mkdir(dir, { recursive: true });
    base = dir;
    try {
      for (const e of await readDir(dir)) {
        const id = e.isFile && e.name.endsWith('.old') ? inboxTaskOf(e.name) : null;
        if (id !== null) await readLeftover(`${dir}/${e.name}`, id);
      }
    } catch {
      /* an empty inbox */
    }
    await readInbox();
    try {
      unwatch = await watch(
        dir,
        (event) => {
          for (const p of event.paths) {
            const id = p.endsWith('.old') ? null : inboxTaskOf(p);
            if (id !== null) void readTask(id);
          }
        },
        { delayMs: 100 },
      );
    } catch (err) {
      console.warn('[inbox] watch unavailable, polling only', err);
    }
    timer = setInterval(() => void readInbox(), INBOX_POLL_MS);
  })();
  try {
    await started;
  } catch (err) {
    started = null;
    throw err;
  }
}

export async function stopInbox(): Promise<void> {
  if (timer !== null) clearInterval(timer);
  timer = null;
  try {
    unwatch?.();
  } catch {
    /* already gone */
  }
  unwatch = null;
  started = null;
  listener = null;
  base = null;
  offsets.clear();
  seen.clear();
}
