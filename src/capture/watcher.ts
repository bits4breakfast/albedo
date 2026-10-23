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
 *  - Only sessions Albedo has a reason to hold are captured: those whose cwd
 *    is a task's worktree, and those the user imported from History. Every
 *    other transcript is left on disk for Claude Code to own -- the database
 *    used to mirror all of them and grew to 2x the size of its source. A file
 *    is "held" once it has a `transcript_files` row; deleting a task removes
 *    the row, and importing writes one. (This replaces the earlier rule that
 *    every session is captured with task_id NULL.)
 *  - Backfill is incremental, newest file first, and yields to the event loop
 *    between files so the UI never freezes.
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists, open, readDir, SeekMode, stat, watch, type UnwatchFn } from '@tauri-apps/plugin-fs';

import { countLines, cwdOf, lastTitleIn, parseTranscript, permissionModesIn, queueFactsIn, SEQ_STRIDE } from './adapter';
import { recordPermissionModes } from './permissionMode';
import { recordQueueOperations, seedQueue } from './queue';
import {
  adoptSessionIntoTask,
  findTaskBySessionId,
  findTaskByWorktreePath,
  getTranscriptFile,
  listTranscriptFiles,
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

/** How often the safety-net poll compares disk against what was ingested. */
export const POLL_MS = 30_000;

/**
 * A file that grew less than this long ago is not yet evidence of a dead
 * watcher: the event may simply still be in flight (debounce + ingest).
 */
export const POLL_GRACE_MS = 5_000;

/** The first `cwd` carried by a line of transcript text, or null. Pure. */
export function firstCwdIn(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const cwd = cwdOf(line);
    if (cwd !== null) return cwd;
  }
  return null;
}

/** How much of a file's start is read to learn its cwd. */
const HEAD_BYTES = 64 * 1024;

/**
 * The cwd from the start of a transcript, or null if no complete line has one.
 *
 * Starts at {@link HEAD_BYTES} and grows like ingest's window does: the first
 * line carrying a cwd is the first user message, and a pasted screenshot makes
 * that one line hundreds of KB. A fixed head cut it mid-line, saw only the
 * bookkeeping lines before it, and answered "cannot tell yet" on every append
 * for the life of the session -- so the session was never captured at all.
 */
async function headCwd(path: string, size: number): Promise<string | null> {
  let windowSize = Math.min(size, HEAD_BYTES);
  for (;;) {
    const head = await readRange(path, 0, windowSize);
    const cut = lastNewlineIndex(head);
    const cwd = cut < 0 ? null : firstCwdIn(new TextDecoder().decode(head.subarray(0, cut + 1)));
    if (cwd !== null || windowSize >= size || windowSize >= MAX_CHUNK_BYTES) return cwd;
    windowSize = Math.min(size, MAX_CHUNK_BYTES, windowSize * 4);
  }
}

/** How much of a file's end is read to find its latest title. */
const TAIL_BYTES = 256 * 1024;

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
   * `degraded` means the live filesystem watcher could not start; `polling`
   * means it started but is inert (or absent) and a slower poll is carrying
   * the load. Either way `error` says so. History still backfills.
   */
  phase: 'backfill' | 'watching' | 'degraded' | 'polling';
  filesDone: number;
  filesTotal: number;
  currentPath: string | null;
  /** Set on `degraded` and `polling`. */
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

/** Startup-backfill progress. */
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

export interface DiskFile {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Compare disk against what ingest last saw, to detect appends the watcher
 * never reported.
 *
 * `missed` are files that differ from the last size ingest observed AND have
 * been quiet for `graceMs`, with no ingest pending -- a working watcher would
 * already have delivered them. `recent` differ too but are inside the grace
 * window; they are not evidence yet and the next poll will decide.
 *
 * Compared against the size ingest STAT'ed, not the bytes it consumed: a
 * trailing partial line leaves bytes_ingested short of the size forever, and
 * that must not read as a dead watcher.
 */
export function findUnreportedGrowth(
  files: readonly DiskFile[],
  seen: ReadonlyMap<string, number>,
  now: number,
  graceMs: number,
  isPending: (path: string) => boolean,
): { missed: string[]; recent: string[] } {
  const missed: string[] = [];
  const recent: string[] = [];
  for (const f of files) {
    if (seen.get(f.path) === f.size) continue;
    if (isPending(f.path)) continue;
    (now - f.mtime >= graceMs ? missed : recent).push(f.path);
  }
  return { missed, recent };
}

/** `<session-uuid>.jsonl` -> `<session-uuid>`. Fallback identity only. */
export function sessionIdFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith(TRANSCRIPT_EXT) ? base.slice(0, -TRANSCRIPT_EXT.length) : base;
}

/**
 * The session a transcript file belongs to: its own name, or for a subagent
 * file (`<session-uuid>/subagents/<agent>.jsonl`) the parent session's.
 */
export function owningSessionOfPath(path: string): string {
  const m = /\/([^/]+)\/subagents\/[^/]+$/.exec(path);
  return m ? m[1]! : sessionIdFromPath(path);
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
  size: number;
}

let active: Capture | null = null;

class Capture implements CaptureHandle {
  liveUpdatesError: string | null = null;
  private stopped = false;
  private unwatch: UnwatchFn | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One in-flight ingest per file; further events chain behind it. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Size of each file as of the last time ingest looked at it. */
  private readonly seen = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private backfilled = false;
  private pollInFlight = false;
  /**
   * Transcripts already judged not worth holding (no task owns their cwd).
   * Remembered for the life of the process so a busy unrelated session does
   * not cost a head read on every append. Cleared per path by an import.
   */
  private readonly ignored = new Set<string>();
  /** Files whose queue history has been replayed this run (see `seedQueueFrom`). */
  private readonly queueSeeded = new Set<string>();
  /** `${taskId}\0${sessionId}` pairs whose earlier rows were already backfilled. */
  private readonly adopted = new Set<string>();

  constructor(private readonly root: string) {}

  /**
   * Should a transcript with no `transcript_files` row be captured?
   *
   * Yes when it is a live task's session -- known from the file name, with no
   * read at all. Otherwise only when its cwd is a worktree Albedo cut for one
   * task (a session someone started there by hand), decided from the file's
   * head (see {@link headCwd}), so an unrelated multi-megabyte session costs
   * one small read rather than a parse. A shared folder such as the main
   * checkout never qualifies: every session started there would be captured
   * and filed under whichever task sits in it.
   *
   * `null` means "cannot tell yet" (no complete line with a cwd) and is NOT
   * cached, so it is asked again when the file grows. A `false` is cached, and
   * {@link reconsider} undoes it when a task is linked to the session later.
   */
  private async wants(path: string): Promise<boolean | null> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return null;
    }
    if (size === 0) return null;
    // Live tasks only: an archived task's history was purged on archive, and
    // re-holding it would capture the whole session again from byte 0.
    if ((await findTaskBySessionId(owningSessionOfPath(path), { liveOnly: true })) !== null) return true;
    const cwd = await headCwd(path, size);
    if (cwd === null) return null;
    return (await findTaskByWorktreePath(cwd, { liveOnly: true, ownedOnly: true })) !== null;
  }

  /**
   * A task was just linked to `sessionId`: read its files even if they were
   * passed over. A `/clear` writes its new file a moment before the hook event
   * naming it is read, and {@link wants} said no in between.
   */
  async reconsider(sessionId: string): Promise<void> {
    for (const path of [...this.ignored]) {
      if (owningSessionOfPath(path) !== sessionId) continue;
      this.ignored.delete(path);
      await this.enqueue(path, projectDirOf(this.root, path));
    }
  }

  /** Hold a transcript from byte 0 and read it now. See {@link importTranscripts}. */
  async importFiles(paths: string[]): Promise<number> {
    let n = 0;
    for (const path of paths) {
      this.ignored.delete(path);
      if ((await getTranscriptFile(path)) === null) {
        await upsertTranscriptFile({
          path,
          sessionId: sessionIdFromPath(path),
          projectDir: projectDirOf(this.root, path),
          cwd: null,
          title: null,
          bytesIngested: 0,
          lastSeq: -1,
          mtime: null,
        });
      }
      await this.enqueue(path, projectDirOf(this.root, path));
      n += 1;
    }
    return n;
  }

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
      // No watcher at all: the poll is the only live path, so say so.
      this.enterPolling(`Live updates are slower than usual: the file watcher could not start, so Albedo is checking every 30 seconds instead (${detail})`);
    }

    // Always on, because a watcher that starts and never fires is silent. The
    // poll is cheap (one stat per transcript) and is what makes that case
    // detectable; it only ingests when disk disagrees with what was captured.
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);

    // Deliberately NOT awaited: startCapture() must resolve as soon as the app
    // is observing changes. The backfill streams in behind it.
    void this.backfill();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
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

  // -- polling safety net --------------------------------------------------

  private enterPolling(message: string): void {
    if (this.polling) return;
    this.polling = true;
    this.liveUpdatesError = message;
    console.warn('[capture]', message);
    emitProgress({
      phase: 'polling',
      filesDone: 0,
      filesTotal: 0,
      currentPath: null,
      error: message,
    });
  }

  private async poll(): Promise<void> {
    // Not during the backfill (it is reading the same files), and never two
    // polls at once if a scan outlasts the interval.
    if (this.stopped || !this.backfilled || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const found = await this.scan();
      const pending = (p: string) => this.timers.has(p) || this.queues.has(p);
      const { missed, recent } = findUnreportedGrowth(
        found.map((f) => ({
          path: f.path,
          size: f.size,
          mtime: f.mtime,
        })),
        this.seen,
        Date.now(),
        POLL_GRACE_MS,
        pending,
      );
      // Once the watcher is known inert, do not wait out the grace window.
      const toIngest = this.polling ? [...missed, ...recent] : missed;
      if (missed.length > 0) {
        this.enterPolling(
          'Live updates are slower than usual: the file watcher missed changes to ' +
            `${missed.length} transcript${missed.length === 1 ? '' : 's'}, so Albedo is checking every 30 seconds instead.`,
        );
      }
      const byPath = new Map(found.map((f) => [f.path, f]));
      for (const path of toIngest) {
        const f = byPath.get(path);
        if (f) void this.enqueue(f.path, f.projectDir);
      }
    } catch (err) {
      console.error('[capture] poll failed', err);
    } finally {
      this.pollInFlight = false;
    }
  }

  // -- startup backfill ----------------------------------------------------

  private async backfill(): Promise<void> {
    let files: PendingFile[];
    try {
      files = await this.scan();
    } catch (err) {
      console.error('[capture] scan failed', err);
      this.backfilled = true; // let the poll retry rather than never start
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

    this.backfilled = true;
    emitProgress({
      phase: this.polling ? 'polling' : 'watching',
      error: this.polling ? (this.liveUpdatesError ?? undefined) : undefined,
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
      let size = -1; // unknown: never equals a recorded size, so it is re-checked
      try {
        const info = await stat(path);
        mtime = info.mtime?.getTime() ?? 0;
        size = info.size;
      } catch {
        /* keep it with mtime 0; it sorts last */
      }
      out.push({ path, projectDir, mtime, size });
    }
  }

  // -- the actual tail -----------------------------------------------------

  private async ingest(path: string, projectDir: string): Promise<void> {
    if (this.stopped) return;
    // Note the size on EVERY path in, including files that are skipped below.
    // The poll compares disk against this, and a file never recorded looks like
    // growth nobody reported -- which is how every skipped transcript was
    // flagged as a missed change.
    try {
      this.seen.set(path, (await stat(path)).size);
    } catch {
      /* gone: handled below and by the next scan */
    }
    if (this.ignored.has(path)) return;

    const record = await getTranscriptFile(path);
    if (record === null) {
      const wanted = await this.wants(path);
      if (wanted === false) this.ignored.add(path);
      if (wanted !== true) return;
    }
    let offset = record?.bytesIngested ?? 0;
    let lastSeq = record?.lastSeq ?? -1;
    let knownCwd = record?.cwd ?? null;
    let knownTitle = record?.title ?? null;
    let sessionId = record?.sessionId ?? sessionIdFromPath(path);

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
      this.seen.set(path, info.size);

      if (info.size < offset) {
        // Truncated or rewritten. Re-ingest from the top; INSERT OR IGNORE on
        // (session_id, seq) means already-captured rows cost one no-op insert
        // and nothing is duplicated.
        offset = 0;
        lastSeq = -1;
      }
      const remaining = info.size - offset;
      if (remaining <= 0) return;

      // The queue lives in memory, so after a restart a session that is busy
      // right now has entries this run never saw being added. Replay the
      // file's history once, the first time it grows -- a queue only exists
      // while a turn runs, and a running turn writes lines.
      if (!this.queueSeeded.has(path)) {
        this.queueSeeded.add(path);
        if (offset > 0) await seedQueueFrom(path, offset, sessionId);
      }

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

      // Queue lines are bookkeeping too: no rows, only "waiting" state. The
      // prompts and turn ends among the rows reconcile it (see queue.ts).
      recordQueueOperations(queueFactsIn(text));
      // So is the permission mode, kept in memory for the composer's label.
      recordPermissionModes(permissionModesIn(text));

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

      // cwd is NOT fixed for the life of a session: `claude --resume` from
      // another folder carries on in the same file with the new cwd (a deleted
      // worktree resumed in the main checkout). The LAST row with a cwd wins,
      // like sessionId above -- scanning backwards, so a chunk usually costs
      // one extra parse, not one per row. It is what History shows as the
      // session's folder; it no longer decides the task (see below).
      let cwd = knownCwd;
      for (let i = rows.length - 1; i >= 0; i--) {
        const rowCwd = cwdOf(rows[i]!.rawJson);
        if (rowCwd !== null) {
          cwd = rowCwd;
          break;
        }
      }

      // Which task: the one on this session, exactly (sessionLink.ts keeps
      // that true). Failing that, a worktree Albedo cut for a single task --
      // a session started there by hand is that task's work too. Never a
      // shared folder, and never by changing the task's session: that was the
      // restart bug, where the main checkout's newest file became the task's.
      // Live tasks only: archiving drops a task's rows but keeps its session
      // id, so a session brought back from History would otherwise land on a
      // task nobody can open, and History would offer only "Open Task".
      let task = await findTaskBySessionId(sessionId, { liveOnly: true });
      if (task === null && cwd !== null) {
        task = await findTaskByWorktreePath(cwd, { liveOnly: true, ownedOnly: true });
      }
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
        // Rows captured before the task existed (a terminal session later
        // adopted by a task) get their task_id backfilled. Once per session
        // and task for the life of the watcher, not per ingest call: every
        // row written from then on already carries the task id, and an ingest
        // call is one fs event -- a live session makes hundreds.
        for (const sid of distinctSessionIds(insertable)) {
          const key = `${task.id}\u0000${sid}`;
          if (this.adopted.has(key)) continue;
          await adoptSessionIntoTask(sid, task.id);
          this.adopted.add(key);
        }
        let latestTs = 0;
        for (const row of insertable) if (row.ts > latestTs) latestTs = row.ts;
        // touchTaskActivity fires onTasksChanged itself, so the shell sees the
        // session adoption and the recency bump without a second refresh.
        await touchTaskActivity(task.id, latestTs);
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
// Sessions on disk that Albedo is not holding
// ---------------------------------------------------------------------------

/** A Claude Code session file, as the filesystem describes it. */
export interface DiskSession {
  sessionId: string;
  path: string;
  projectDir: string;
  /** Real working directory, from the file's first lines. Null if not found. */
  cwd: string | null;
  /** Latest session title near the end of the file, if any. */
  title: string | null;
  mtime: number;
  size: number;
  /** True when Albedo already holds it (it has a `transcript_files` row). */
  held: boolean;
}

/** How many of the newest session files {@link listDiskSessions} describes. */
const DISK_LIST_LIMIT = 150;

/**
 * Claude Code's session files that Albedo is NOT holding, newest first.
 *
 * Read straight from the filesystem, never from the database: the point is to
 * reach sessions the database does not contain. Only top-level session files
 * are listed (subagent transcripts ride along with their parent on import).
 * Each costs one head read (cwd) and one tail read (title), both bounded.
 */
export async function listDiskSessions(): Promise<DiskSession[]> {
  const root = `${(await homeDir()).replace(/\/+$/, '')}/${PROJECTS_SUBPATH}`;
  if (!(await exists(root))) return [];

  const held = new Set((await listTranscriptFiles()).map((f) => f.path));
  const files: Array<{ path: string; projectDir: string; mtime: number; size: number }> = [];
  for (const dir of await readDir(root)) {
    if (!dir.isDirectory) continue;
    let entries;
    try {
      entries = await readDir(`${root}/${dir.name}`);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile || !isTranscriptPath(e.name)) continue;
      const path = `${root}/${dir.name}/${e.name}`;
      if (held.has(path)) continue;
      try {
        const info = await stat(path);
        files.push({ path, projectDir: dir.name, mtime: info.mtime?.getTime() ?? 0, size: info.size });
      } catch {
        /* vanished between readDir and stat */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: DiskSession[] = [];
  for (const f of files.slice(0, DISK_LIST_LIMIT)) {
    let cwd: string | null = null;
    let title: string | null = null;
    try {
      cwd = await headCwd(f.path, f.size);
      const from = Math.max(0, f.size - TAIL_BYTES);
      const tail = await readRange(f.path, from, f.size - from);
      title = lastTitleIn(new TextDecoder().decode(tail));
    } catch {
      /* unreadable: still listable, just unlabeled */
    }
    out.push({
      sessionId: sessionIdFromPath(f.path),
      path: f.path,
      projectDir: f.projectDir,
      cwd,
      title,
      mtime: f.mtime,
      size: f.size,
      held: false,
    });
    await yieldToEventLoop();
  }
  return out;
}

/**
 * Import a session from Claude Code's files: hold it from byte 0 and ingest
 * it, together with its subagent transcripts
 * (`<projectDir>/<session-uuid>/subagents/*.jsonl`).
 *
 * Resolves once the rows are written. Throws if capture is not running.
 */
/** See {@link Capture.reconsider}. A no-op while capture is not running. */
export async function reconsiderSession(sessionId: string): Promise<void> {
  await active?.reconsider(sessionId);
}

export async function importTranscripts(sessionFilePath: string): Promise<number> {
  if (active === null) throw new Error('Capture is not running, so nothing can be imported.');
  const paths = [sessionFilePath];
  const subDir = `${sessionFilePath.replace(/\.jsonl$/, '')}/subagents`;
  try {
    for (const e of await readDir(subDir)) {
      if (e.isFile && isTranscriptPath(e.name)) paths.push(`${subDir}/${e.name}`);
    }
  } catch {
    /* no subagents directory: the common case */
  }
  return active.importFiles(paths);
}

// ---------------------------------------------------------------------------
// Filesystem plumbing
// ---------------------------------------------------------------------------

/** How much history `seedQueueFrom` replays. Queues are short-lived; this is generous. */
const QUEUE_SEED_BYTES = 8 * 1024 * 1024;

/**
 * Rebuild a session's queue from the part of its transcript already ingested.
 * Bounded: past `QUEUE_SEED_BYTES` only the tail is read, starting at the
 * first whole line. A dequeue whose enqueue fell before the window then pops
 * a later entry, which can hide one queued message until it is taken -- the
 * price of not reading a huge file on startup.
 */
async function seedQueueFrom(path: string, upTo: number, sessionId: string): Promise<void> {
  try {
    const start = Math.max(0, upTo - QUEUE_SEED_BYTES);
    let text = new TextDecoder().decode(await readRange(path, start, upTo - start));
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    seedQueue([sessionId], queueFactsIn(text));
  } catch {
    /* a queue we cannot rebuild just starts empty */
  }
}

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
