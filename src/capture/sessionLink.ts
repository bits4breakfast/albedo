/**
 * Which Claude Code session a task is on -- the one place it changes.
 *
 * A task's `session_id` is what a restart resumes, so it must never be a
 * guess. It used to be: capture matched transcripts to tasks by folder and
 * every ingested line overwrote the id, so in a shared folder (the main
 * checkout) a restart resumed whichever session had been read last.
 *
 * Now it moves for exactly three reasons, each of them a fact rather than an
 * inference:
 *
 *  - **spawn**: Albedo chose the id itself (`--session-id`, or the one it is
 *    resuming / forking to). Recorded before `claude` starts, so the very
 *    first transcript line already finds its task.
 *  - **hook**: the task's own terminal reported a SessionStart with another
 *    id -- `/clear`, or `/resume` inside Claude Code. See hookEvents.ts.
 *  - **browser**: History attached a past session to a new task.
 *
 * Every change is logged, to the console and to `~/.albedo/logs/sessions.jsonl`,
 * so an odd restart can be traced instead of reconstructed.
 *
 * Owner: capture workstream.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, mkdir, readDir, writeTextFile } from '@tauri-apps/plugin-fs';
import { adoptSessionIntoTask, findTaskBySessionId, getTask, hasTranscriptForSession, updateTask } from '../db';
import { contextUsage } from './context';
import { ALBEDO_DIR } from './hookEvents';
import { PROJECTS_SUBPATH, reconsiderSession } from './watcher';

export type SessionLinkReason =
  | 'spawn:new'
  | 'spawn:reuse'
  | 'spawn:resume'
  | 'spawn:fork'
  | 'spawn:continue'
  | 'browser'
  | `hook:${string}`;

/** A UUID as Claude Code writes it. Anything else is not a session id. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID.test(v);
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Point the task at `sessionId`. Returns whether anything changed.
 *
 * Rows of that session captured before the link -- a `/clear` writes its first
 * line before the hook event is read -- are claimed for the task here, so the
 * transcript pane does not wait for the next line to show them.
 */
export async function linkTaskSession(
  taskId: number,
  sessionId: string,
  reason: SessionLinkReason,
): Promise<boolean> {
  if (!isSessionId(sessionId)) return false;
  const task = await getTask(taskId);
  if (!task || task.sessionId === sessionId) return false;
  // Another task already on this session (a `/resume` of another task's
  // conversation inside this terminal). The terminal running it wins, but it
  // is worth a line in the log: two tasks would otherwise show one transcript.
  const holder = await findTaskBySessionId(sessionId).catch(() => null);
  await updateTask(taskId, { sessionId });
  try {
    await adoptSessionIntoTask(sessionId, taskId);
    // Files capture passed over before the link (it did not know the id yet).
    await reconsiderSession(sessionId);
  } catch (err) {
    console.warn('[albedo:session] could not claim earlier rows', err);
  }
  logLink({ taskId, from: task.sessionId, to: sessionId, reason, alsoHeldBy: holder && holder.id !== taskId ? holder.id : null });
  return true;
}

/**
 * Does Claude Code have a transcript for this session? True, false, or null
 * when it cannot be told -- callers treat null as "probably", because the
 * alternative to resuming is starting over.
 *
 * Claude Code writes the file only once the first message is sent, so a task
 * spawned and closed before anyone typed has an id and no file; `--resume`
 * of it fails. Albedo's own record is checked first, then the disk: a resume
 * from another folder keeps writing under the folder the session began in, so
 * every project directory is looked in.
 */
export async function sessionTranscriptExists(sessionId: string): Promise<boolean | null> {
  try {
    if (await hasTranscriptForSession(sessionId)) return true;
    const root = `${(await homeDir()).replace(/\/+$/, '')}/${PROJECTS_SUBPATH}`;
    if (!(await exists(root))) return false;
    for (const dir of await readDir(root)) {
      if (!dir.isDirectory) continue;
      if (await exists(`${root}/${dir.name}/${sessionId}.jsonl`)) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * The model the session last answered with, for a resume with no stored
 * choice -- a `/model` typed in the terminal is otherwise lost on restart.
 * Only a real model id is returned; `<synthetic>` and the like are not.
 */
export async function lastModelOf(sessionId: string): Promise<string | null> {
  try {
    const model = (await contextUsage(sessionId))?.model ?? null;
    return model && /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(model) ? model : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

interface LinkEntry {
  taskId: number;
  from: string | null;
  to: string;
  reason: SessionLinkReason;
  alsoHeldBy: number | null;
}

let logDir: Promise<string> | null = null;

function logLink(entry: LinkEntry): void {
  const at = new Date().toISOString();
  console.info(
    `[albedo:session] task ${entry.taskId}: ${entry.from ?? '(none)'} -> ${entry.to} (${entry.reason})` +
      (entry.alsoHeldBy !== null ? `, also held by task ${entry.alsoHeldBy}` : ''),
  );
  void (async () => {
    try {
      logDir ??= (async () => {
        const dir = `${(await homeDir()).replace(/\/+$/, '')}/${ALBEDO_DIR}/logs`;
        await mkdir(dir, { recursive: true });
        return dir;
      })();
      const dir = await logDir;
      await writeTextFile(`${dir}/sessions.jsonl`, `${JSON.stringify({ at, ...entry })}\n`, { append: true });
    } catch {
      logDir = null; // the console line is the record; try the file again next time
    }
  })();
}
