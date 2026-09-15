/**
 * The change-set view (M4).
 *
 * The transcript is chronological: a file edited five times appears five
 * times. This is the other axis — one row per file, the current state of the
 * change set, which is the view you want in front of you before committing.
 *
 * Two sources, merged in src/db/touched.ts: the transcript's own tool calls,
 * and `git status` in the worktree. Rows git alone knows about are lifted to
 * the top and marked, because "something changed here that the agent never
 * told you about" is the most valuable line on this screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { OpenFileRequest, Task, TouchedFile } from '../types';
import { touchedFilesDetailed } from '../db/touched';
import { onCaptureUpdate } from '../capture';
import { onHandEditedChange } from '../lib/handEdited';
import { useOpenFile } from './editor/openFile';
import { relativeTime } from './TaskList';
import './touched.css';

/** Capture fires per batch of rows; coalesce bursts into one reload. */
const REFRESH_DEBOUNCE_MS = 300;
/** Re-render cadence for the "3m ago" column. Nothing is re-queried. */
const CLOCK_MS = 30_000;

export interface TouchedFilesProps {
  task: Task;
}

export default function TouchedFiles({ task }: TouchedFilesProps): ReactNode {
  const [files, setFiles] = useState<TouchedFile[]>([]);
  const [gitError, setGitError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  const openFile = useSafeOpenFile();

  // --- load -----------------------------------------------------------------
  useEffect(() => {
    let live = true;
    setLoading(true);
    void touchedFilesDetailed(task.id)
      .then((res) => {
        if (!live) return;
        setFiles(res.files);
        setGitError(res.gitError);
        setError(null);
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (!live) return;
        // Show what actually failed. A change-set view that silently renders
        // empty reads as "nothing has changed", which is a different claim.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!live) return;
        setLoading(false);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [task.id, reloadKey]);

  // Reset between tasks so the previous task's rows never flash in the new one.
  useEffect(() => {
    setFiles([]);
    setGitError(null);
    setError(null);
    setLoaded(false);
  }, [task.id]);

  // --- refresh when the transcript advances --------------------------------
  // Driven by capture, never polled. A Bash `sed` still produces a tool_use
  // row, so a git-only change lands here on the same signal.
  const sessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    sessionsRef.current = new Set(task.sessionId === null ? [] : [task.sessionId]);
  }, [task.id, task.sessionId]);

  useEffect(() => {
    let timer = 0;
    const off = onCaptureUpdate((u) => {
      // A resumed task writes a SECOND transcript with a new session id, so
      // the task's own sessionId is not enough: match the worktree cwd too,
      // and remember any session that matched it.
      const known = sessionsRef.current.has(u.sessionId);
      const mine = known || (u.cwd !== null && samePath(u.cwd, task.worktreePath));
      if (!mine) return;
      if (!known) sessionsRef.current.add(u.sessionId);
      if (timer !== 0) return;
      timer = window.setTimeout(() => {
        timer = 0;
        setReloadKey((k) => k + 1);
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [task.id, task.worktreePath]);

  // --- hand-edited marker ---------------------------------------------------
  // Saving in the built-in editor writes to the worktree without going through
  // a tool call, so no capture update follows it.
  useEffect(() => {
    let off: (() => void) | null = null;
    try {
      off = onHandEditedChange(() => setReloadKey((k) => k + 1));
    } catch {
      off = null; // the editor workstream is optional to this view
    }
    return () => {
      try {
        off?.();
      } catch {
        /* nothing we can do about a broken unsubscribe */
      }
    };
  }, []);

  // --- clock ----------------------------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  const gitOnly = useMemo(() => files.filter((f) => f.source === 'git').length, [files]);
  const edits = useMemo(() => files.reduce((n, f) => n + f.editCount, 0), [files]);

  const onOpen = useCallback(
    (file: TouchedFile) => {
      openFile({ path: file.path });
    },
    [openFile],
  );

  return (
    <div className="tf-pane">
      <div className="tf-head">
        <span className="tf-head-title">Touched files</span>
        <span className="tf-head-count">
          {files.length} file{files.length === 1 ? '' : 's'}
          {edits > 0 ? ` · ${edits} edit${edits === 1 ? '' : 's'}` : ''}
        </span>
        <button
          type="button"
          className="tf-btn"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          title="Re-read the transcript and git status"
        >
          {loading ? 'reading…' : 'refresh'}
        </button>
      </div>

      {error !== null ? (
        <div className="tf-error">
          <span className="tf-error-label">Could not build the change set</span>
          <pre className="tf-error-detail">{error}</pre>
        </div>
      ) : null}

      {gitError !== null ? (
        <div className="tf-warn" title={gitError}>
          git status is unavailable, so only files the transcript mentions are listed —{' '}
          <span className="tf-warn-detail">{firstLine(gitError)}</span>
        </div>
      ) : null}

      {gitOnly > 0 ? (
        <div className="tf-legend">
          {gitOnly} file{gitOnly === 1 ? '' : 's'} changed in the worktree but not through an edit
          tool — a Bash command, a generator or a formatter.
        </div>
      ) : null}

      <div className="tf-scroll">
        {files.map((f) => (
          <FileRow key={f.path} file={f} now={now} onOpen={onOpen} />
        ))}

        {files.length === 0 && loaded && error === null ? (
          <div className="tf-empty">
            Nothing touched yet.
            <span className="tf-empty-hint">
              Files appear here as the agent edits them, and whenever git sees a change in{' '}
              <span className="tf-mono">{task.worktreePath}</span>.
            </span>
          </div>
        ) : null}

        {!loaded && loading ? <div className="tf-empty">reading the change set…</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function FileRow({
  file,
  now,
  onOpen,
}: {
  file: TouchedFile;
  now: number;
  onOpen: (f: TouchedFile) => void;
}): ReactNode {
  const cut = file.path.lastIndexOf('/');
  // The trailing slash is its own element: `.tf-dir` clips from the FRONT
  // (direction: rtl), and a path ending in a neutral character like `/` would
  // be reordered by the bidi algorithm and render as `/src/ui`.
  const dir = cut === -1 ? '' : file.path.slice(0, cut);
  const name = cut === -1 ? file.path : file.path.slice(cut + 1);

  return (
    <button
      type="button"
      className="tf-row"
      data-source={file.source}
      onClick={() => onOpen(file)}
      title={`${file.path}${file.gitStatus ? ` · git ${file.gitStatus}` : ''}`}
    >
      <span className="tf-status" data-tone={statusTone(file.gitStatus)}>
        {file.gitStatus === null ? '··' : file.gitStatus.replace(/ /g, '·')}
      </span>

      <span className="tf-path">
        {dir === '' ? null : (
          <>
            <span className="tf-dir">{dir}</span>
            <span className="tf-sep">/</span>
          </>
        )}
        <span className="tf-name">{name}</span>
        {file.source === 'git' ? (
          <span
            className="tf-badge"
            title="Changed in the worktree, but not through an edit tool — a Bash command, a generator or a formatter. The transcript never mentions this file."
          >
            worktree
          </span>
        ) : null}
        {file.handEdited ? (
          <span className="tf-badge tf-badge-hand" title="You saved this file by hand in the editor">
            hand
          </span>
        ) : null}
      </span>

      <span className="tf-edits" title={`${file.editCount} edit tool call(s) in the transcript`}>
        {file.editCount === 0 ? '—' : `${file.editCount}×`}
      </span>
      <span className="tf-when">{relativeTime(file.lastTouchedAt, now)}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** add / del / mod / none, from the porcelain code. Drives the row's colour. */
export function statusTone(code: string | null): 'add' | 'del' | 'mod' | 'none' {
  if (code === null) return 'none';
  const letters = code.replace(/ /g, '');
  if (letters.includes('D')) return 'del';
  if (letters.includes('?') || letters.includes('A')) return 'add';
  if (letters === '') return 'none';
  return 'mod';
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** Path equality that tolerates a trailing slash on either side. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * `useOpenFile()` from the editor workstream, wrapped so this view survives
 * the editor being absent, unmounted or broken. Opening a file is a
 * convenience here; the change set is the point.
 *
 * The hook is called unconditionally on every render (React requires that);
 * only its RESULT is guarded.
 */
function useSafeOpenFile(): (req: OpenFileRequest) => void {
  let bound: ((req: OpenFileRequest) => void) | null = null;
  try {
    bound = useOpenFile();
  } catch {
    bound = null;
  }
  const ref = useRef(bound);
  ref.current = bound;
  return useCallback((req: OpenFileRequest) => {
    try {
      ref.current?.(req);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- a dead click must not white-screen the pane
      console.warn('TouchedFiles: could not open', req.path, err);
    }
  }, []);
}

export { TouchedFiles };
