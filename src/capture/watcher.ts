/**
 * src/capture/watcher.ts
 *
 * Tails every Claude Code transcript under ~/.claude/projects/ into SQLite.
 *
 * This is the irreversible part of Albedo: history that is not captured while
 * it is being written cannot be backfilled later. The design consequences:
 *
 *  - Tail by BYTE OFFSET held in transcript_files.bytes_ingested. Re-reading a
 *    multi-megabyte transcript on every append event would make the app
 *    unusable within a day of real use.
 *  - Only complete lines are parsed. The offset only ever advances to a
 *    newline boundary, so a line being appended right now is simply left for
 *    the next pass.
 *  - Sessions with no matching task are captured with task_id NULL. A session
 *    started in a plain terminal is still history, and still searchable. This
 *    is an explicit spec requirement, not an edge case.
 *  - Backfill is incremental, newest file first, and yields to the event loop
 *    between files so the UI never freezes.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, open, readDir, SeekMode, stat, watch, type UnwatchFn } from '@tauri-apps/plugin-fs';

import { countLines, cwdOf, lastTitleIn, parseTranscript, SEQ_STRIDE } from './adapter';
import {
  adoptSessionIntoTask,
  findTaskByWorktreePath,
  getTranscriptFile,
  insertMessages,
  listTranscriptFilesNeedingTitle,
  setTranscriptTitle,
  touchTaskActivity,
  upsertTranscriptFile,
  type InsertableMessage,
} from '../db';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Claude Code appends in bursts; coalesce them per file. */
export const DEBOUNCE_MS = 150;

/** Path under $HOME that Claude Code writes transcripts to. */
export const PROJECTS_SUBPATH = '.claude/projects';

const TRANSCRIPT_EXT = '.jsonl';

/** Bytes pulled per pass. Bounds memory on the first import of a big file. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** Per-read staging buffer. */
const READ_BUFFER_BYTES = 256 * 1024;

/**
 * How deep to walk below ~/.claude/projects. Transcripts live at depth 2
 * (`<projectDir>/<uuid>.jsonl`) and subagent transcripts at depth 4
 * (`<projectDir>/<uuid>/subagents/<uuid>.jsonl`); the cap is slack for a
 * layout change, and a guard against ever following a symlink loop.
 */
const MAX_SCAN_DEPTH = 6;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface CaptureUpdate {
  sessionId: string;
  /**
   * The session's REAL working directory, read off the `cwd` field of a
   * transcript line. Never reconstructed from the slugified project directory
   * name, which is lossy (docs/TRANSCRIPT-FORMAT.md). The shell matches this
   * against Task.worktreePath to adopt a session, so a lossy value here would
   * silently mis-adopt or fail to adopt.
   */
  cwd: string | null;
  lastSeq: number;
}

export interface CaptureProgress {
  /**
   * `degraded` means the live filesystem watcher could not start. History
   * still backfills, but nothing will update until the app is restarted.
   */
  phase: 'backfill' | 'watching' | 'degraded';
  filesDone: number;
  filesTotal: number;
  currentPath: string | null;
  /** Set only on `degraded`. */
  error?: string;
}

const updateListeners = new Set<(u: CaptureUpdate) => void>();
const progressListeners = new Set<(p: CaptureProgress) => void>();

/** Fires whenever rows land, so the UI can refresh without polling. */
export function onCaptureUpdate(cb: (u: CaptureUpdate) => void): () => void {
  updateListeners.add(cb);
  return () => {
    updateListeners.delete(cb);
  };
}

/** Startup-backfill progress. Additive to docs/INTERFACES.md. */
export function onCaptureProgress(cb: (p: CaptureProgress) => void): () => void {
  progressListeners.add(cb);
  return () => {
    progressListeners.delete(cb);
  };
}

function emitUpdate(u: CaptureUpdate): void {
  for (const cb of [...updateListeners]) {
    try {
      cb(u);
    } catch {
      /* a broken subscriber must not stall ingestion */
    }
  }
}

function emitProgress(p: CaptureProgress): void {
  for (const cb of [...progressListeners]) {
    try {
      cb(p);
    } catch {
      /* ditto */
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no filesystem, no database)
// ---------------------------------------------------------------------------

/**
 * File line index the next chunk starts at, recovered from the stored
 * watermark. `-1` means nothing has been ingested yet.
 */
export function lineIndexAfter(lastSeq: number): number {
  if (!Number.isFinite(lastSeq) || lastSeq < 0) return 0;
  return Math.floor(lastSeq / SEQ_STRIDE) + 1;
}

/**
 * Watermark to store once `lineCount` lines have been consumed.
 *
 * It is the LAST seq of the last consumed line's block range, not the highest
 * seq actually written. Bookkeeping lines produce no rows at all, so a
 * watermark taken from real rows would rewind the file position and re-parse
 * the same lines forever.
 */
export function watermarkFor(nextLineIndex: number): number {
  return nextLineIndex * SEQ_STRIDE - 1;
}

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

/** `<session-uuid>.jsonl` -> `<session-uuid>`. Fallback identity only. */
export function sessionIdFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith(TRANSCRIPT_EXT) ? base.slice(0, -TRANSCRIPT_EXT.length) : base;
}

export function isTranscriptPath(path: string): boolean {
  return path.endsWith(TRANSCRIPT_EXT);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureHandle {
  stop(): Promise<void>;
  /**
   * Null when the live watcher is running; a message when it could not start.
   *
   * This is deliberately part of the handle rather than a silent log. The
   * watcher failing is not a minor degradation: transcripts, task status,
   * touched files and the usage panel then only update on restart, which the
   * user experiences as "the app just doesn't do anything" with no error
   * anywhere. It went undetected for exactly that reason.
   */
  readonly liveUpdatesError: string | null;
}

interface PendingFile {
  path: string;
  projectDir: string;
  mtime: number;
}

let active: Capture | null = null;

class Capture implements CaptureHandle {
  liveUpdatesError: string | null = null;
  private stopped = false;
  private unwatch: UnwatchFn | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One in-flight ingest per file; further events chain behind it. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async start(): Promise<void> {
    // Register the watcher FIRST, so appends that happen during the backfill
    // are not missed. Re-ingesting a range is idempotent, missing one is not.
    try {
      this.unwatch = await watch(
        this.root,
        (event) => {
          if (this.stopped) return;
          for (const p of event.paths) {
            if (isTranscriptPath(p)) this.schedule(p);
          }
        },
        { recursive: true, delayMs: DEBOUNCE_MS },
      );
    } catch (err) {
      // Degraded, NOT silent. The backfill below still makes history
      // searchable, so this is not fatal -- but live updates are the point of
      // the app, and a failure here must reach the user rather than the
      // console. Reported both on the handle (for the caller awaiting
      // startCapture) and as a progress event (for anyone already subscribed).
      const detail = err instanceof Error ? err.message : String(err);
      this.liveUpdatesError =
        `Live updates unavailable - transcripts will only refresh on restart (${detail})`;
      console.error('[capture] could not watch', this.root, err);
      emitProgress({
        phase: 'degraded',
        filesDone: 0,
        filesTotal: 0,
        currentPath: null,
        error: this.liveUpdatesError,
      });
    }

    // Deliberately NOT awaited: startCapture() must resolve as soon as the app
    // is observing changes. The backfill streams in behind it.
    void this.backfill();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.unwatch) {
      try {
        this.unwatch();
      } catch {
        /* already gone */
      }
      this.unwatch = null;
    }
    // Let queued work finish so we never stop mid-insert with a stale offset.
    await Promise.allSettled([...this.queues.values()]);
    this.queues.clear();
    if (active === this) active = null;
  }

  // -- event debouncing ----------------------------------------------------

  private schedule(path: string): void {
    const existing = this.timers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.enqueue(path, projectDirOf(this.root, path));
      }, DEBOUNCE_MS),
    );
  }

  /** Serialise ingests per file: two passes at once would double-read. */
  private enqueue(path: string, projectDir: string): Promise<void> {
    const prev = this.queues.get(path) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.ingest(path, projectDir))
      .catch((err: unknown) => {
        console.error('[capture] ingest failed', path, err);
      });
    this.queues.set(path, next);
    void next.then(() => {
      if (this.queues.get(path) === next) this.queues.delete(path);
    });
    return next;
  }

  // -- startup backfill ----------------------------------------------------

  private async backfill(): Promise<void> {
    let files: PendingFile[];
    try {
      files = await this.scan();
    } catch (err) {
      console.error('[capture] scan failed', err);
      return;
    }

    // Newest first: recent history becomes searchable immediately, and a user
    // who quits mid-backfill has lost only the oldest, least useful sessions.
    files.sort((a, b) => b.mtime - a.mtime);

    emitProgress({
      phase: 'backfill',
      filesDone: 0,
      filesTotal: files.length,
      currentPath: null,
    });

    let done = 0;
    for (const f of files) {
      if (this.stopped) return;
      await this.enqueue(f.path, f.projectDir);
      done += 1;
      emitProgress({
        phase: 'backfill',
        filesDone: done,
        filesTotal: files.length,
        currentPath: f.path,
      });
      // Hand the main thread back between files. Without this the whole
      // backfill runs as one microtask storm and the window locks up.
      await yieldToEventLoop();
    }

    // Only after live history is in: the title pass is a nicety, ingest is not.
    if (!this.stopped) {
      try {
        const titled = await backfillTranscriptTitles();
        if (titled > 0) console.info(`[capture] backfilled ${titled} session titles`);
      } catch (err) {
        console.error('[capture] title backfill failed', err);
      }
    }

    emitProgress({
      phase: 'watching',
      filesDone: done,
      filesTotal: files.length,
      currentPath: null,
    });
  }

  /**
   * Find every transcript under the projects root, RECURSIVELY.
   *
   * Claude Code nests subagent transcripts two levels deeper:
   *   <projectDir>/<session-uuid>/subagents/<uuid>.jsonl
   *
   * A scan that only walked `<projectDir>/*.jsonl` missed all of them. On this
   * machine that was 395 of 510 files -- 230 MB and 48,343 user/assistant
   * lines, every one of them `isSidechain: true`, and NONE of it duplicated in
   * the parent transcript. So more than half the user's history was invisible
   * to search while the recursive fs watcher happily ingested any subagent
   * file that happened to be appended to while the app was running. Captured
   * or not captured is a decision; captured-depending-on-timing is a bug.
   */
  private async scan(): Promise<PendingFile[]> {
    const out: PendingFile[] = [];
    await this.walk(this.root, '', 0, out);
    return out;
  }

  private async walk(
    dir: string,
    projectDir: string,
    depth: number,
    out: PendingFile[],
  ): Promise<void> {
    if (this.stopped || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return; // unreadable directory: skip it, never abort the whole scan
    }
    for (const entry of entries) {
      if (this.stopped) return;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        // The top-level entry names the project; everything below inherits it.
        await this.walk(path, depth === 0 ? entry.name : projectDir, depth + 1, out);
        continue;
      }
      if (!entry.isFile || !isTranscriptPath(entry.name)) continue;
      let mtime = 0;
      try {
        mtime = (await stat(path)).mtime?.getTime() ?? 0;
      } catch {
        /* keep it with mtime 0; it sorts last */
      }
      out.push({ path, projectDir, mtime });
    }
  }

  // -- the actual tail -----------------------------------------------------

  private async ingest(path: string, projectDir: string): Promise<void> {
    if (this.stopped) return;

    const record = await getTranscriptFile(path);
    let offset = record?.bytesIngested ?? 0;
    let lastSeq = record?.lastSeq ?? -1;
    let knownCwd = record?.cwd ?? null;
    let knownTitle = record?.title ?? null;
    let sessionId = record?.sessionId ?? sessionIdFromPath(path);
    let adopted = false;

    // Loop so one call drains a file that grew by more than MAX_CHUNK_BYTES.
    for (;;) {
      if (this.stopped) return;

      let info;
      try {
        info = await stat(path);
      } catch {
        return; // deleted between the event and now
      }
      if (!info.isFile) return;

      if (info.size < offset) {
        // Truncated or rewritten. Re-ingest from the top; INSERT OR IGNORE on
        // (session_id, seq) means already-captured rows cost one no-op insert
        // and nothing is duplicated.
        offset = 0;
        lastSeq = -1;
      }
      const remaining = info.size - offset;
      if (remaining <= 0) return;

      // Grow the read window until it contains a newline, so a single
      // pathologically long line (a huge tool_result) cannot wedge the file.
      let windowSize = Math.min(remaining, MAX_CHUNK_BYTES);
      let bytes = await readRange(path, offset, windowSize);
      let cut = lastNewlineIndex(bytes);
      while (cut < 0 && windowSize < remaining) {
        windowSize = Math.min(remaining, windowSize * 4);
        bytes = await readRange(path, offset, windowSize);
        cut = lastNewlineIndex(bytes);
      }
      if (cut < 0) return; // only a partial line so far: wait for the newline

      const consumed = cut + 1;
      const text = new TextDecoder().decode(bytes.subarray(0, consumed));

      const fromLine = lineIndexAfter(lastSeq);
      const rows = parseTranscript(text, fromLine);
      const nextLineIndex = fromLine + countLines(text);

      // Title lines are bookkeeping and produce no message rows, so they are
      // scanned separately. Latest in the chunk wins; a chunk with no title
      // leaves whatever was already recorded alone.
      const chunkTitle = lastTitleIn(text);
      if (chunkTitle !== null) knownTitle = chunkTitle;

      // Resolve identity from the rows themselves. sessionId can change
      // mid-file after a resume or compaction, so the LAST row wins and the
      // filename is only a fallback.
      const fallbackSession = sessionId;
      for (let i = rows.length - 1; i >= 0; i--) {
        const sid = rows[i]?.sessionId;
        if (sid !== undefined && sid.length > 0) {
          sessionId = sid;
          break;
        }
      }

      // cwd is fixed for the life of a session, so read it once and cache it.
      // Re-deriving it per row would JSON.parse every raw line a second time,
      // which on a first-import backfill is tens of thousands of wasted parses.
      let cwd = knownCwd;
      if (cwd === null) {
        for (const row of rows) {
          const rowCwd = cwdOf(row.rawJson);
          if (rowCwd !== null) {
            cwd = rowCwd;
            break;
          }
        }
      }

      const task = cwd === null ? null : await findTaskByWorktreePath(cwd);
      const taskId = task?.id ?? null;

      const insertable: InsertableMessage[] = rows.map((row) => ({
        ...row,
        // A line missing sessionId still has to be storable (session_id is NOT
        // NULL); fall back to the id the file is named after.
        sessionId: row.sessionId.length > 0 ? row.sessionId : fallbackSession,
        taskId,
      }));

      if (insertable.length > 0) {
        await insertMessages(insertable);
      }

      offset += consumed;
      lastSeq = watermarkFor(nextLineIndex);
      knownCwd = cwd;

      await upsertTranscriptFile({
        path,
        sessionId,
        projectDir,
        cwd,
        title: knownTitle,
        bytesIngested: offset,
        lastSeq,
        mtime: info.mtime?.getTime() ?? null,
      });

      if (task && insertable.length > 0) {
        if (!adopted) {
          // Rows captured before the task existed (a terminal session later
          // adopted by a task) get their task_id backfilled. Once per ingest
          // call: the rows written below already carry the task id.
          adopted = true;
          for (const sid of distinctSessionIds(insertable)) {
            await adoptSessionIntoTask(sid, task.id);
          }
        }
        let latestTs = 0;
        for (const row of insertable) if (row.ts > latestTs) latestTs = row.ts;
        // touchTaskActivity fires onTasksChanged itself, so the shell sees the
        // session adoption and the recency bump without a second refresh.
        await touchTaskActivity(task.id, sessionId, latestTs);
      }

      for (const [sid, maxSeq] of maxSeqPerSession(insertable)) {
        emitUpdate({ sessionId: sid, cwd, lastSeq: maxSeq });
      }

      if (offset >= info.size) return;
      await yieldToEventLoop(); // more to drain; do not hog the main thread
    }
  }
}

/**
 * Start capturing. Resolves once the filesystem watcher is live; the backfill
 * of existing history continues in the background and reports through
 * `onCaptureProgress`.
 */
export async function startCapture(): Promise<CaptureHandle> {
  if (active !== null) return active;

  const home = (await homeDir()).replace(/\/+$/, '');
  const root = `${home}/${PROJECTS_SUBPATH}`;

  const capture = new Capture(root);
  active = capture;

  if (!(await exists(root))) {
    // Claude Code has never run here. Nothing to watch yet; hand back a live
    // handle anyway so the caller's teardown path stays uniform.
    capture.liveUpdatesError = `No transcript directory at ${root} - nothing to capture yet.`;
    console.warn('[capture] no transcript directory at', root);
    return capture;
  }

  await capture.start();
  return capture;
}

// ---------------------------------------------------------------------------
// Filesystem plumbing
// ---------------------------------------------------------------------------

async function readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
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
 * First path segment below the projects root.
 *
 * Must not be the immediate parent: a subagent transcript's parent directory
 * is literally named `subagents`, which would file it under a project that
 * does not exist.
 */
export function projectDirOf(root: string, path: string): string {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) return '';
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? '' : rest.slice(0, slash);
}

function distinctSessionIds(rows: InsertableMessage[]): string[] {
  return [...new Set(rows.map((r) => r.sessionId))];
}

function maxSeqPerSession(rows: InsertableMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const current = out.get(r.sessionId);
    if (current === undefined || r.seq > current) out.set(r.sessionId, r.seq);
  }
  return out;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}


// ---------------------------------------------------------------------------
// One-time title backfill
// ---------------------------------------------------------------------------

/**
 * Populate `transcript_files.title` for files that were already ingested.
 *
 * WHY THIS IS NECESSARY, and why the same shape will recur:
 *
 * Ingest tails from `bytes_ingested`. Once a file is fully ingested the
 * watcher never reads it again -- that is the design, and it is what keeps the
 * app usable on a 432 MB corpus. So a column added by a later migration is
 * populated only for transcripts written AFTER it shipped. `title` arrived in
 * v4, by which point all 115 of the user's transcripts were fully ingested:
 * without this pass the session browser would have shown an empty title on
 * 100% of the user's actual 41.8 days of history and looked correct only on
 * sessions started afterwards.
 *
 * The scan is cheap by design: it reads each file in bounded chunks and
 * rejects ~99% of lines with a substring test before any JSON.parse, and it
 * only touches files whose title is still NULL. A file with no title line is
 * marked with '' so it is never re-read.
 *
 * @returns how many files gained a title.
 */
export async function backfillTranscriptTitles(
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const pending = await listTranscriptFilesNeedingTitle();
  if (pending.length === 0) return 0;

  let found = 0;
  let done = 0;
  for (const file of pending) {
    let title: string | null = null;
    try {
      title = await scanFileForTitle(file.path);
    } catch {
      // Deleted, unreadable, or permission-denied. Leave the row NULL so a
      // later run retries rather than marking it permanently titleless.
      done += 1;
      onProgress?.(done, pending.length);
      continue;
    }
    // '' marks "scanned, nothing found" so the next launch skips it.
    await setTranscriptTitle(file.path, title);
    if (title !== null) found += 1;
    done += 1;
    onProgress?.(done, pending.length);
    await yieldToEventLoop();
  }
  return found;
}

/**
 * Last title line in a file, read in bounded chunks so memory does not track
 * file size. Only complete lines are scanned; a partial line at a chunk
 * boundary is carried into the next chunk.
 */
async function scanFileForTitle(path: string): Promise<string | null> {
  const info = await stat(path);
  if (!info.isFile || info.size === 0) return null;

  let offset = 0;
  let carry = '';
  let title: string | null = null;

  while (offset < info.size) {
    const want = Math.min(MAX_CHUNK_BYTES, info.size - offset);
    const bytes = await readRange(path, offset, want);
    if (bytes.length === 0) break;

    const isLastChunk = offset + bytes.length >= info.size;
    const cut = isLastChunk ? bytes.length - 1 : lastNewlineIndex(bytes);
    if (cut < 0) {
      // No line break in a whole chunk: skip past it rather than spinning.
      offset += bytes.length;
      carry = '';
      continue;
    }

    const consumed = cut + 1;
    const text = carry + new TextDecoder().decode(bytes.subarray(0, consumed));
    const chunkTitle = lastTitleIn(text);
    if (chunkTitle !== null) title = chunkTitle;

    carry = isLastChunk ? '' : new TextDecoder().decode(bytes.subarray(consumed));
    offset += bytes.length;
  }

  return title;
}
