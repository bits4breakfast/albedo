/**
 * src/db/touched.ts — the change-set view (M4).
 *
 * The transcript is chronological: a file edited five times appears five
 * times. This module answers the other question — "what does the change set
 * look like right now, before I commit?" — as one row per file.
 *
 * Two sources, deliberately:
 *
 *   1. `messages` grouped by `target_path`, which is already captured for
 *      every tool call, so this needs no new plumbing and no new column.
 *   2. `git status` in the task's worktree, because the agent can change files
 *      WITHOUT its edit tool (a Bash `sed -i`, a codegen script, a formatter
 *      run as part of a build). A transcript-only view silently under-reports
 *      exactly the changes a human is least likely to expect.
 *
 * Design rules follow src/git/worktree.ts: the merge and the path
 * normalisation are pure and exported, so they are unit-testable without a
 * database or a git process; only `touchedFiles` touches either.
 */

import type { TouchedFile, TouchedSource } from '../types';
import { getDb, getTask } from './index';
import { uncommittedChanges, type StatusEntry } from '../git/worktree';
import { isHandEdited } from '../lib/handEdited';

// ---------------------------------------------------------------------------
// Which tool calls count as a touch
// ---------------------------------------------------------------------------

/**
 * Tools whose calls WRITE to the file in `target_path`.
 *
 * `target_path` is set by the capture adapter for anything carrying a
 * `file_path` / `path` / `notebook_path` input, which includes `Read`, `Grep`
 * and `Glob`. Counting those as edits would make this view useless — a file
 * the agent read forty times while hunting a bug would outrank the file it
 * actually changed.
 *
 * ⚠️ THIS LIST IS THE THING TO UPDATE when Claude Code gains (or renames) an
 * edit tool. A new writing tool missing from here is invisible in this view
 * except through the git cross-check, which is the safety net, not the plan.
 */
export const WRITING_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] as const;

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export interface TouchedQuery {
  sql: string;
  binds: unknown[];
}

/**
 * One aggregate query, grouped in SQLite rather than in JS: a long task is
 * tens of thousands of rows and we want a few dozen back.
 *
 * Scoped by `task_id`, never by a single `session_id` — a task resumed after a
 * `--continue` writes a SECOND transcript file with a new session id, and both
 * sessions' rows carry this task's id once the watcher adopts them.
 */
export function buildTouchedQuery(taskId: number): TouchedQuery {
  const binds: unknown[] = [taskId];
  const slots = WRITING_TOOLS.map((t) => {
    binds.push(t);
    return `$${binds.length}`;
  });
  const sql =
    `SELECT target_path AS path,
            COUNT(*)    AS edit_count,
            MAX(ts)     AS last_touched_at
       FROM messages
      WHERE task_id = $1
        AND target_path IS NOT NULL
        AND role = 'tool_use'
        AND tool_name IN (${slots.join(', ')})
      GROUP BY target_path`;
  return { sql, binds };
}

interface TouchedRow {
  path: string;
  edit_count: number;
  last_touched_at: number | null;
}

// ---------------------------------------------------------------------------
// Path normalisation — the single most likely bug in this module
// ---------------------------------------------------------------------------

/**
 * Resolve `.` and `..` inside an already-split path. Leading `..` on a
 * relative path is kept (it is meaningful); `..` that would climb above `/` on
 * an absolute path is dropped, exactly as the kernel does.
 */
function resolveSegments(parts: readonly string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      const last = out[out.length - 1];
      if (last !== undefined && last !== '..') {
        out.pop();
      } else if (!absolute) {
        out.push('..');
      }
      continue;
    }
    out.push(part);
  }
  return out;
}

/** `/a//b/../c/` -> `/a/c`. Absolute input only. */
function normaliseAbsolute(p: string): string {
  return `/${resolveSegments(p.split('/'), true).join('/')}`;
}

/**
 * Put a path from either source into the SAME shape: worktree-relative, no
 * `./`, no duplicate slashes, `..` resolved.
 *
 * This is where a duplicate row comes from if it is skipped. The transcript
 * usually holds ABSOLUTE paths (Claude Code's edit tools require them), while
 * `git status --porcelain` output is ALWAYS relative to the worktree root — so
 * `/Users/me/agents/albedo/x/src/a.ts` and `src/a.ts` are the same file and a
 * naive merge lists it twice, once with an edit count and once with a git
 * status.
 *
 * A path that resolves OUTSIDE the worktree is returned absolute and
 * unchanged. It is not part of the change set, but the transcript says the
 * agent wrote to it, and under-reporting is the dangerous direction here —
 * such a row is honest about being elsewhere instead of being silently
 * dropped or, worse, rendered as if it were a file in this checkout.
 */
export function toWorktreeRelative(worktreePath: string, raw: string): string {
  const p = raw.trim();
  if (p === '') return '';

  if (!p.startsWith('/')) {
    // Already relative: still normalise, so `./src/a.ts` and `src/a.ts` merge.
    return resolveSegments(p.split('/'), false).join('/');
  }

  const abs = normaliseAbsolute(p);
  const root = normaliseAbsolute(worktreePath.trim() === '' ? '/' : worktreePath);
  if (abs === root) return '';
  // The trailing slash matters: `/wt-2/src/a.ts` must not match a `/wt` root.
  if (root === '/') return abs.slice(1);
  if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return abs;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** One row as the SQL aggregate produced it, before normalisation. */
export interface TranscriptTouch {
  /** Path exactly as the transcript recorded it; usually absolute. */
  path: string;
  editCount: number;
  lastTouchedAt: number | null;
}

export interface MergeTouchedInput {
  worktreePath: string;
  transcript: readonly TranscriptTouch[];
  /** `git status --porcelain` entries, as parsed by src/git/worktree.ts. */
  git: readonly StatusEntry[];
  /** `isHandEdited(taskId, relPath)` already bound to the task. */
  handEdited?: (relPath: string) => boolean;
}

/**
 * Fold both sources into one row per file.
 *
 * Pure: no database, no git, no clock. Everything interesting about this
 * module — normalisation, de-duplication, `source` classification and the
 * ordering — is decided here, so it can all be tested directly.
 */
export function mergeTouched(input: MergeTouchedInput): TouchedFile[] {
  const { worktreePath, transcript, git } = input;
  const rel = (p: string) => toWorktreeRelative(worktreePath, p);

  // A rename shows up in porcelain as the DESTINATION path plus the source
  // path. The transcript recorded edits under the source name, so without this
  // alias the same file appears twice: `old.ts` (transcript) and `new.ts`
  // (git). Fold the old name into the new one.
  const renamedTo = new Map<string, string>();
  for (const e of git) {
    if (e.origPath === null) continue;
    const from = rel(e.origPath);
    const to = rel(e.path);
    if (from !== '' && to !== '' && from !== to) renamedTo.set(from, to);
  }

  const byPath = new Map<string, TouchedFile>();
  const upsert = (path: string, source: TouchedSource): TouchedFile => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const created: TouchedFile = {
      path,
      editCount: 0,
      lastTouchedAt: null,
      source,
      gitStatus: null,
      handEdited: false,
    };
    byPath.set(path, created);
    return created;
  };

  for (const t of transcript) {
    const normalised = rel(t.path);
    if (normalised === '') continue; // the worktree root itself is not a file
    const path = renamedTo.get(normalised) ?? normalised;
    const row = upsert(path, 'transcript');
    row.editCount += Math.max(0, t.editCount);
    if (t.lastTouchedAt !== null) {
      row.lastTouchedAt = row.lastTouchedAt === null ? t.lastTouchedAt : Math.max(row.lastTouchedAt, t.lastTouchedAt);
    }
  }

  for (const e of git) {
    const path = rel(e.path);
    if (path === '') continue;
    const known = byPath.get(path);
    if (known) {
      // The transcript already knew about this file: both sources agree.
      known.gitStatus = `${e.x}${e.y}`;
      if (known.source === 'transcript') known.source = 'both';
    } else {
      // Git alone. A `sed -i`, a generator, a formatter — the row that exists
      // precisely because the transcript cannot be trusted to be complete.
      const row = upsert(path, 'git');
      row.gitStatus = `${e.x}${e.y}`;
    }
  }

  // A transcript row whose file git has nothing to say about stays
  // 'transcript': the edit was made and then reverted, or committed already.
  const files = [...byPath.values()];
  if (input.handEdited) {
    for (const f of files) {
      f.handEdited = input.handEdited(f.path);
    }
  }
  return files.sort(compareTouched);
}

/**
 * Most recently touched first. How a file was changed does not affect its
 * place: an edit made through Bash or a formatter is a change like any other
 * (the view gives uncommitted rows their file's modification time, so they
 * do not sink for lack of a transcript timestamp).
 */
export function compareTouched(a: TouchedFile, b: TouchedFile): number {
  const at = a.lastTouchedAt ?? -1;
  const bt = b.lastTouchedAt ?? -1;
  if (at !== bt) return bt - at;
  if (a.editCount !== b.editCount) return b.editCount - a.editCount;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The one impure entry point
// ---------------------------------------------------------------------------

/** Frozen contract, docs/INTERFACES.md. */
export async function touchedFiles(taskId: number): Promise<TouchedFile[]> {
  return (await touchedFilesDetailed(taskId)).files;
}

export interface TouchedFilesResult {
  files: TouchedFile[];
  /**
   * Why the git cross-check could not run (worktree deleted, not a repo, git
   * missing), or null when it did. The transcript rows are still returned --
   * half the view beats an error page -- but the UI has to be able to SAY that
   * the git half is missing, or the absence of `source: 'git'` rows reads as
   * "nothing changed outside the edit tool", which is a different claim.
   */
  gitError: string | null;
}

/** {@link touchedFiles} plus the reason the git half degraded, if it did. */
export async function touchedFilesDetailed(taskId: number): Promise<TouchedFilesResult> {
  const task = await getTask(taskId);
  if (task === null) throw new Error(`touchedFiles: no task with id ${taskId}`);

  const { sql, binds } = buildTouchedQuery(taskId);
  const db = await getDb();
  const rows = await db.select<TouchedRow[]>(sql, binds);

  let git: StatusEntry[] = [];
  let gitError: string | null = null;
  try {
    git = (await uncommittedChanges(task.worktreePath)).entries;
  } catch (err: unknown) {
    gitError = err instanceof Error ? err.message : String(err);
  }

  return {
    files: mergeTouched({
      worktreePath: task.worktreePath,
      transcript: rows.map((r) => ({
        path: r.path,
        editCount: Number(r.edit_count) || 0,
        lastTouchedAt: r.last_touched_at,
      })),
      git,
      // Owned by the editor workstream (src/lib/handEdited.ts). Keyed on the
      // worktree-RELATIVE path, which is the form mergeTouched hands it: the
      // module's own contract says callers must not invent another one.
      handEdited: (relPath) => isHandEdited(taskId, relPath),
    }),
    gitError,
  };
}
