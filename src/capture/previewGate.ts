/**
 * The approval gate for mockups a session writes (#348): which `show_preview`
 * calls are waiting on the user, and the way their answer goes back.
 *
 * ## The pipe
 *
 *   the agent calls mcp__albedo__show_preview(path, title, question?, note?)
 *     albedo-mcp copies the page to ~/.albedo/previews/copy-<task>-<req>.html,
 *     appends a `show_preview` line to the task's inbox, and WAITS
 *       inbox.ts hands the line here; the copy is kept as one version
 *       (db/previews.ts), and the task is waiting on the user
 *         a click on the card writes ~/.albedo/previews/answer-<task>-<req>.json
 *           albedo-mcp reads it, deletes it, and returns its text as the result
 *
 * It mirrors the PermissionRequest hook (hookEvents.ts): one answer file per
 * request, named by an id only that call has, written only from a click,
 * and only while that exact call is still waiting. Nothing writes an answer
 * on its own, and the pty is never typed into.
 *
 * ## When a call stops waiting without an answer
 *
 *   - `notifications/cancelled` -- Esc in the terminal, or Claude Code's own
 *     timeout (about 28 h): the server records a `preview_cancelled` line;
 *   - the transcript records the call's result, an error for a cancel
 *     ({@link finishedPreviewCalls}, read by useTasks with the status);
 *   - the task's terminal exits ({@link endTaskPreviews});
 *   - the app starts: a call from an earlier run cannot still wait, its
 *     session ended with that run.
 *
 * Each settles the version once (`settlePreview` moves only a pending row),
 * so whichever arrives first decides, and a click after any of them is
 * refused before anything is written. The server, for its part, never reads
 * an answer for a call that is over: a late answer cannot apply.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Message, Preview } from '../types';
import { insertPreview, pendingPreviews, settlePreview } from '../db/previews';
import { toolResultIsErrorOf, toolResultTextOf, toolUseIdOf } from './adapter';
import { ALBEDO_DIR } from './hookEvents';
import { onPreviewLine, type PreviewLine } from './inbox';

/** The tool's name in a transcript. */
export const SHOW_PREVIEW_TOOL = 'mcp__albedo__show_preview';


export function copyFileName(taskId: number, requestId: string): string {
  return `copy-${taskId}-${requestId}.html`;
}

/** The file the waiting server polls for. Mirrors `preview::answer_name`. */
export function previewAnswerFileName(taskId: number, requestId: string): string {
  return `answer-${taskId}-${requestId}.json`;
}

/** The longest answer the server takes, in characters (`preview::MAX_ANSWER_CHARS`). */
export const MAX_ANSWER_CHARS = 64_000;

// ---------------------------------------------------------------------------
// What the transcript says about a call
// ---------------------------------------------------------------------------

export interface FinishedCall {
  error: boolean;
  text: string;
}

/**
 * The `show_preview` calls `messages` hold a result for, by tool_use id. A
 * result means the call is over, whichever way: an error is a cancel ("The
 * user doesn't want to proceed…", or the timeout), anything else the answer.
 */
export function finishedPreviewCalls(messages: readonly Message[]): Map<string, FinishedCall> {
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool_use' && m.toolName === SHOW_PREVIEW_TOOL) {
      const id = toolUseIdOf(m);
      if (id) calls.add(id);
    }
  }
  const out = new Map<string, FinishedCall>();
  for (const m of messages) {
    if (m.role !== 'tool_result') continue;
    const id = toolUseIdOf(m);
    // The tool_use row may be past the window read; a result row names its
    // tool too, when the adapter could pair it.
    if (!id || (!calls.has(id) && m.toolName !== SHOW_PREVIEW_TOOL)) continue;
    out.set(id, { error: toolResultIsErrorOf(m), text: toolResultTextOf(m) });
  }
  return out;
}

/** What a result's text says the user answered, for a call settled from the transcript. */
export function outcomeOfResult(r: FinishedCall): 'approved' | 'changes' | 'cancelled' {
  if (r.error) return 'cancelled';
  const t = r.text.trimStart().toLowerCase();
  if (t.startsWith('approved')) return 'approved';
  if (t.startsWith('changes requested')) return 'changes';
  return 'cancelled';
}

// ---------------------------------------------------------------------------
// Runtime: the versions waiting now
// ---------------------------------------------------------------------------

type Listener = (taskId: number) => void;

const listeners = new Set<Listener>();
/** Waiting versions, by request id. Only this run's calls can be in here. */
const waiting = new Map<string, Preview>();
let started: Promise<void> | null = null;
let startedAt = 0;
let cachedHome: string | null = null;
let unsubscribe: (() => void) | null = null;

/** Where the copies and answers live: `$HOME/.albedo/previews`, as `preview::dir_under`. */
async function previewsDir(): Promise<string> {
  if (cachedHome === null) cachedHome = (await homeDir()).replace(/\/+$/, '');
  return `${cachedHome}/${ALBEDO_DIR}/previews`;
}

function notify(taskId: number): void {
  for (const cb of [...listeners]) {
    try {
      cb(taskId);
    } catch {
      /* a broken subscriber must not stall the others */
    }
  }
}

/** Told when a task's waiting preview appears, changes or goes. */
export function onPreviewChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * The version the task is waiting on: the OLDEST still waiting, as the
 * prompt card shows the oldest prompt. Synchronous, from memory.
 */
export function pendingPreview(taskId: number): Preview | null {
  let first: Preview | null = null;
  for (const p of waiting.values()) {
    if (p.taskId === taskId && (first === null || p.createdAt < first.createdAt)) first = p;
  }
  return first;
}

/** Whether this exact call still waits for an answer. */
export function isPreviewWaiting(requestId: string): boolean {
  return waiting.has(requestId);
}

/** Every task with a version waiting. */
export function tasksWaitingOnPreview(): Set<number> {
  return new Set([...waiting.values()].map((p) => p.taskId));
}

async function retire(requestId: string, outcome: 'approved' | 'changes' | 'cancelled', answer: string | null): Promise<void> {
  const p = waiting.get(requestId);
  waiting.delete(requestId);
  try {
    await settlePreview(requestId, outcome, answer);
  } catch (err) {
    console.warn('[previews] could not record how a preview ended', err);
  }
  if (p) notify(p.taskId);
}

/** A `show_preview` line: keep its copy as a version; a call this run waits. */
async function received(line: Extract<PreviewLine, { tool: 'show_preview' }>): Promise<void> {
  let html = '';
  try {
    html = await readTextFile(`${await previewsDir()}/${copyFileName(line.taskId, line.id)}`);
  } catch (err) {
    // Shown as a version with nothing to show; the card says so, and the
    // answers still work: the session must not hang unseen.
    console.warn('[previews] could not read a preview copy', err);
  }
  // Written before this run started: its session ended with the last run.
  const live = line.at >= startedAt;
  const p = await insertPreview({
    taskId: line.taskId,
    requestId: line.id,
    toolUseId: line.toolUseId,
    title: line.title,
    html,
    question: line.question,
    note: line.note,
    createdAt: line.at,
    outcome: live ? 'pending' : 'cancelled',
  });
  if (p.outcome !== 'pending') return;
  waiting.set(p.requestId, p);
  notify(p.taskId);
}

/**
 * One line at a time, in order: a cancel read in the same batch as its call
 * must not be applied before the call is kept.
 */
let queue: Promise<void> = Promise.resolve();

function onLine(line: PreviewLine): void {
  const work =
    line.tool === 'show_preview'
      ? () => received(line).catch((err: unknown) => console.warn('[previews] could not keep a preview', err))
      : () => retire(line.request, 'cancelled', null);
  queue = queue.then(work, work);
}

/** Resolves once every line handed over so far is handled. For tests. */
export function previewLinesSettled(): Promise<void> {
  return queue;
}

/**
 * Start listening for previews. Call before the inbox is read (inbox.ts
 * `startInbox`), so a line read at launch is not missed. Idempotent.
 */
export function startPreviewGate(now = Date.now()): Promise<void> {
  started ??= (async () => {
    startedAt = now;
    unsubscribe = onPreviewLine(onLine);
    // Nothing from an earlier run can still be waiting: its session is gone.
    try {
      for (const p of await pendingPreviews()) await settlePreview(p.requestId, 'cancelled', null, now);
    } catch (err) {
      console.warn('[previews] could not close earlier previews', err);
    }
  })();
  return started;
}

/** Test seam: forget everything. */
export function __resetPreviewGate(): void {
  unsubscribe?.();
  unsubscribe = null;
  started = null;
  startedAt = 0;
  waiting.clear();
  listeners.clear();
  cachedHome = null;
  queue = Promise.resolve();
}

/** The task's session is over (its pty exited, or the task is going): nothing of it waits. */
export async function endTaskPreviews(taskId: number): Promise<void> {
  const mine = [...waiting.values()].filter((p) => p.taskId === taskId);
  await Promise.all(mine.map((p) => retire(p.requestId, 'cancelled', null)));
}

/**
 * The transcript recorded results for some calls: those still waiting here
 * are over. Called with what the status refresh read (useTasks).
 */
export async function retireFinishedPreviews(taskId: number, finished: ReadonlyMap<string, FinishedCall>): Promise<void> {
  if (finished.size === 0) return;
  const done = [...waiting.values()].filter((p) => p.taskId === taskId && p.toolUseId !== null && finished.has(p.toolUseId));
  await Promise.all(
    done.map((p) => {
      const r = finished.get(p.toolUseId!)!;
      const outcome = outcomeOfResult(r);
      return retire(p.requestId, outcome, outcome === 'cancelled' ? null : r.text);
    }),
  );
}

// ---------------------------------------------------------------------------
// The answer: written only from a click
// ---------------------------------------------------------------------------

export type PreviewAnswerResult =
  /** Not written: the call was no longer waiting. */
  | 'refused'
  /** The server took it: Claude Code has the answer. */
  | 'taken'
  /** Written, not picked up: the call ended meanwhile (answered or cancelled in the terminal). */
  | 'untaken';

/** How long to wait for the server to take the answer. It looks every 250 ms. */
const TAKE_TIMEOUT_MS = 3_000;

/**
 * Hand the waiting call the user's answer. Call only from a click.
 *
 * Checks, when called and again just before the file appears, that this call
 * is still waiting. The file is written under a scratch name and renamed, so
 * the server never reads half of it. The server deletes it as it takes it,
 * so its disappearing is the acknowledgement; one left in place was never
 * read and never will be (no other call polls that name).
 */
export async function answerPreview(
  preview: Preview,
  outcome: 'approved' | 'changes',
  text: string,
): Promise<PreviewAnswerResult> {
  const body = text.trim();
  if (body.length === 0 || [...body].length > MAX_ANSWER_CHARS) return 'refused';
  if (!isPreviewWaiting(preview.requestId)) return 'refused';
  let final: string;
  try {
    final = `${await previewsDir()}/${previewAnswerFileName(preview.taskId, preview.requestId)}`;
    const tmp = `${final}.part`;
    await writeTextFile(tmp, JSON.stringify({ text: body }));
    // Last look: the write took a tick, and the terminal may have won it.
    if (!isPreviewWaiting(preview.requestId)) return 'refused';
    await rename(tmp, final);
  } catch (err) {
    console.warn('[previews] could not write the answer', err);
    return 'refused';
  }
  const until = Date.now() + TAKE_TIMEOUT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      if (!(await exists(final))) {
        await retire(preview.requestId, outcome, body);
        return 'taken';
      }
    } catch {
      /* unreadable this tick; try again */
    }
  }
  return 'untaken';
}
