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
import { compareTouched, touchedFilesDetailed } from '../db/touched';
import CommentsSection from './CommentsSection';
import { stat } from '@tauri-apps/plugin-fs';
import {
  branchCommits,
  changeKinds,
  committedFileTimes,
  lineChanges,
  type BranchCommit,
  type ChangeKind,
  type LineChange,
} from '../git/worktree';
import { setTouchedOrder } from './touchedOrder';
import { onCaptureUpdate } from '../capture';
import { onHandEditedChange } from '../lib/handEdited';
import { useOpenFile } from './editor/openFile';
import { relativeTime } from './TaskList';
import { useActivate } from './transcript/Diff';
import './touched.css';

type ViewMode = 'branch' | 'commit';
const MODE_KEY = 'albedo.touched.mode';

function readMode(): ViewMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'commit' ? 'commit' : 'branch';
  } catch {
    return 'branch';
  }
}

function writeMode(m: ViewMode): ViewMode {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* not remembered */
  }
  return m;
}

/** Capture fires per batch of rows; coalesce bursts into one reload. */
const REFRESH_DEBOUNCE_MS = 300;
/** Re-render cadence for the "3m ago" column. Nothing is re-queried. */
const CLOCK_MS = 30_000;

export interface TouchedFilesProps {
  task: Task;
  /** The file in the editor's active tab, worktree-relative: its row is marked. */
  activePath?: string | null;
}

export default function TouchedFiles({ task, activePath = null }: TouchedFilesProps): ReactNode {
  const [files, setFiles] = useState<TouchedFile[]>([]);
  const [gitError, setGitError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);
  /** +/- per path against the task's base. Empty when git cannot say. */
  const [lines, setLines] = useState<Map<string, LineChange>>(() => new Map());
  /** A / M / D / T per path against the task's base. Empty when git cannot say. */
  const [kinds, setKinds] = useState<Map<string, ChangeKind>>(() => new Map());
  /** When each file was last committed on the branch. */
  const [committedAt, setCommittedAt] = useState<Map<string, number>>(() => new Map());
  /** When each uncommitted file last changed on disk. */
  const [modifiedAt, setModifiedAt] = useState<Map<string, number>>(() => new Map());
  /** The branch's commits, newest first, for the by-commit view. */
  const [commits, setCommits] = useState<BranchCommit[]>([]);
  const [mode, setMode] = useState<ViewMode>(readMode);
  /** Commits the user folded away in the by-commit view. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());

  const openFile = useSafeOpenFile();

  // --- load -----------------------------------------------------------------
  useEffect(() => {
    let live = true;
    setLoading(true);
    // Line counts are a nicety beside the change set: a failure here leaves
    // the rows without them rather than failing the list.
    void lineChanges(task.worktreePath, task.baseBranch)
      .then((m) => {
        if (live) setLines(m);
      })
      .catch(() => {
        if (live) setLines(new Map());
      });
    void changeKinds(task.worktreePath, task.baseBranch)
      .then((m) => {
        if (live) setKinds(m);
      })
      .catch(() => {
        if (live) setKinds(new Map());
      });
    void branchCommits(task.worktreePath, task.baseBranch)
      .then((c) => {
        if (live) setCommits(c);
      })
      .catch(() => {
        if (live) setCommits([]);
      });
    void committedFileTimes(task.worktreePath, task.baseBranch)
      .then((m) => {
        if (live) setCommittedAt(m);
      })
      .catch(() => {
        if (live) setCommittedAt(new Map());
      });
    void touchedFilesDetailed(task.id)
      .then((res) => {
        if (!live) return;
        setFiles(res.files);
        setGitError(res.gitError);
        setError(null);
        setNow(Date.now());
        // An uncommitted file's time is when it last changed on disk, however
        // it was changed -- an edit tool, a shell command, a formatter.
        void modifiedTimes(
          task.worktreePath,
          res.files.filter((f) => f.gitStatus !== null && !f.path.startsWith('/')).map((f) => f.path),
        ).then((m) => {
          if (live) setModifiedAt(m);
        });
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
  }, [task.id, task.worktreePath, task.baseBranch, reloadKey]);

  // Reset between tasks so the previous task's rows never flash in the new one.
  useEffect(() => {
    setFiles([]);
    setLines(new Map());
    setKinds(new Map());
    setCommittedAt(new Map());
    setModifiedAt(new Map());
    setCommits([]);
    setFolded(new Set());
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

  /*
     The branch's change set, as git sees it, in two sections:

       uncommitted   git status sees it
       committed     in a commit on this branch, clean now

     A file the transcript touched that git shows no change for (edited back,
     or outside the worktree altogether) is not part of the change set and is
     not listed. Files the branch committed that this transcript never
     mentions are added from git: the change set is the branch's, not only
     this session's.
  */
  const view = useMemo(() => {
    const inside = files.filter((f) => !f.path.startsWith('/'));
    const known = new Set(inside.map((f) => f.path));
    const fromGit: TouchedFile[] = [];
    for (const path of lines.keys()) {
      if (known.has(path)) continue;
      fromGit.push({
        path,
        editCount: 0,
        lastTouchedAt: committedAt.get(path) ?? null,
        source: 'git',
        gitStatus: null,
        handEdited: false,
      });
    }
    const withTime = (f: TouchedFile): TouchedFile =>
      f.lastTouchedAt === null && committedAt.has(f.path) ? { ...f, lastTouchedAt: committedAt.get(f.path) ?? null } : f;
    const byRecent = (a: TouchedFile, b: TouchedFile) => (b.lastTouchedAt ?? 0) - (a.lastTouchedAt ?? 0);

    const uncommitted = inside
      .filter((f) => f.gitStatus !== null)
      .map((f) => (modifiedAt.has(f.path) ? { ...f, lastTouchedAt: modifiedAt.get(f.path) ?? null } : f))
      .sort(compareTouched);
    const committed = [...inside.filter((f) => f.gitStatus === null && lines.has(f.path)), ...fromGit]
      .map(withTime)
      .sort(byRecent);
    return { uncommitted, committed };
  }, [files, lines, committedAt, modifiedAt]);

  // The order the editor steps through with next / previous file: what is on
  // screen, top to bottom, each file once.
  useEffect(() => {
    const paths =
      mode === 'commit'
        ? [...view.uncommitted.map((f) => f.path), ...commits.flatMap((c) => [...c.files.keys()])]
        : [...view.uncommitted, ...view.committed].map((f) => f.path);
    setTouchedOrder(task.id, [...new Set(paths)]);
  }, [task.id, view, commits, mode]);

  /** The row for a path: the list's own entry when it has one, else a bare one. */
  const rowFor = useCallback(
    (path: string): TouchedFile =>
      [...view.uncommitted, ...view.committed].find((f) => f.path === path) ?? {
        path,
        editCount: 0,
        lastTouchedAt: null,
        source: 'git',
        gitStatus: null,
        handEdited: false,
      },
    [view],
  );


  // Keep the open file's row in view as tabs change, without yanking the
  // list when it already shows.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activePath === null) return;
    scrollRef.current?.querySelector<HTMLElement>('.tf-row[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activePath, view, commits, mode]);

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
          {view.uncommitted.length + view.committed.length} file
          {view.uncommitted.length + view.committed.length === 1 ? '' : 's'}
        </span>
        <span className="tf-mode" role="group" aria-label="Group files">
          <button
            type="button"
            className="tf-mode-btn"
            aria-pressed={mode === 'branch'}
            onClick={() => setMode(writeMode('branch'))}
            title="Every file changed on this branch, once, by where it stands"
          >
            Branch
          </button>
          <button
            type="button"
            className="tf-mode-btn"
            aria-pressed={mode === 'commit'}
            onClick={() => setMode(writeMode('commit'))}
            title="Each commit on this branch with the files it changed"
          >
            By commit
          </button>
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

      <div className="tf-scroll" ref={scrollRef}>
        <CommentsSection task={task} onOpen={(path, line) => openFile({ path, line })} />
        {mode === 'commit' ? (
          <>
            {view.uncommitted.length > 0 ? (
              <section className="tf-section">
                <div className="tf-section-head">
                  Uncommitted<span className="tf-section-count">{view.uncommitted.length}</span>
                </div>
                {view.uncommitted.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    change={lines.get(f.path) ?? null}
                    now={now}
                    onOpen={onOpen}
                    current={f.path === activePath}
                  />
                ))}
              </section>
            ) : null}
            {commits.map((c) => {
              const open = !folded.has(c.sha);
              return (
                <section key={c.sha} className="tf-section">
                  <button
                    type="button"
                    className="tf-section-head tf-commit-head"
                    aria-expanded={open}
                    onClick={() =>
                      setFolded((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.sha)) next.delete(c.sha);
                        else next.add(c.sha);
                        return next;
                      })
                    }
                    title={`${c.sha}\n${c.subject}`}
                  >
                    <span className="tf-section-caret">{open ? '▾' : '▸'}</span>
                    <span className="tf-commit-subject">{c.subject || '(no message)'}</span>
                    <span className="tf-commit-meta">
                      {c.sha.slice(0, 7)} · {relativeTime(c.at, now)}
                    </span>
                  </button>
                  {open
                    ? [...c.files.entries()].map(([path, change]) => (
                        <FileRow
                          key={`${c.sha}:${path}`}
                          file={rowFor(path)}
                          change={change}
                          now={now}
                          onOpen={onOpen}
                          current={path === activePath}
                        />
                      ))
                    : null}
                </section>
              );
            })}
            {commits.length === 0 && view.uncommitted.length === 0 && loaded ? (
              <div className="tf-empty">No commits on this branch yet, and nothing uncommitted.</div>
            ) : null}
          </>
        ) : null}
        {mode === 'commit' ? null : (
          [
            ['Uncommitted', view.uncommitted],
            ['Committed on this branch', view.committed],
          ] as const
        ).map(([label, rows]) =>
          rows.length === 0 ? null : (
            <section key={label} className="tf-section">
              <div className="tf-section-head">
                {label}
                <span className="tf-section-count">{rows.length}</span>
              </div>
              {rows.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  change={lines.get(f.path) ?? null}
                  kind={kinds.get(f.path) ?? null}
                  now={now}
                  onOpen={onOpen}
                  current={f.path === activePath}
                />
              ))}
            </section>
          ),
        )}

        {mode !== 'commit' && view.uncommitted.length === 0 && view.committed.length === 0 && loaded && error === null ? (
          <div className="tf-empty">
            No changes yet.
            <span className="tf-empty-hint">
              Files appear here as soon as git sees a change in <span className="tf-mono">{task.worktreePath}</span>.
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
  change,
  kind = null,
  now,
  onOpen,
  current = false,
}: {
  file: TouchedFile;
  /** Lines added/deleted against the base; null when git has no count. */
  change: LineChange | null;
  /**
   * A / M / D / T against the base. Shown when the file is clean now, so a
   * committed row says how the branch changed it instead of a blank `··`.
   */
  kind?: ChangeKind | null;
  now: number;
  onOpen: (f: TouchedFile) => void;
  /** This file is in the editor's active tab. */
  current?: boolean;
}): ReactNode {
  const cut = file.path.lastIndexOf('/');
  // The trailing slash is its own element: `.tf-dir` clips from the FRONT
  // (direction: rtl), and a path ending in a neutral character like `/` would
  // be reordered by the bidi algorithm and render as `/src/ui`.
  const dir = cut === -1 ? '' : file.path.slice(0, cut);
  const name = cut === -1 ? file.path : file.path.slice(cut + 1);

  // A div, not a <button>: WebKit allows no text selection inside a button,
  // and the path is something people copy. useActivate opens the file on a
  // plain click but not on a click that ends a text selection.
  const activate = useActivate(() => onOpen(file));
  // The row says what git says: the status letter, the line counts. How the
  // file was changed (an edit tool, a shell command, a formatter) is not
  // shown -- the change is the same either way, and the diff is what to read.
  const status = file.gitStatus ?? kind;
  return (
    <div
      role="button"
      tabIndex={0}
      className="tf-row"
      aria-current={current ? 'true' : undefined}
      onMouseDown={activate.onMouseDown}
      onClick={activate.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(file);
          return;
        }
        // Up / down walk the rows, across sections; Enter opens.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = Array.from(
            e.currentTarget.closest('.tf-scroll')?.querySelectorAll<HTMLElement>('.tf-row') ?? [],
          );
          const i = rows.indexOf(e.currentTarget);
          const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
      }}
      // Everything the row can shed when the column is narrow is still here.
      // Pinned as a column the pane goes down to 180px, where touched.css drops
      // the directory and the timestamp; the tooltip is where they survive.
      title={rowTitle(file, kind, now)}
    >
      <span className="tf-status" data-tone={statusTone(status)}>
        {status === null ? '··' : status.replace(/ /g, '·')}
      </span>

      <span className="tf-path">
        {dir === '' ? null : (
          <>
            <span className="tf-dir">{dir}</span>
            <span className="tf-sep">/</span>
          </>
        )}
        <span className="tf-name">{name}</span>
        {file.handEdited ? (
          <span className="tf-badge tf-badge-hand" title="You saved this file by hand in the editor">
            hand
          </span>
        ) : null}
      </span>

      <span className="tf-lines" title={linesTitle(change)}>
        {change === null ? null : change.added === null ? (
          <span className="tf-bin">bin</span>
        ) : (
          <>
            <span className="tf-add">+{change.added}</span> <span className="tf-del">−{change.deleted}</span>
          </>
        )}
      </span>
      <span className="tf-when">{relativeTime(file.lastTouchedAt, now)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The whole row as text. The pane is resizable down to 180px as a pinned
 * column, and at that width the directory and the relative time are dropped
 * from the layout — so they have to be somewhere, and hover is that somewhere.
 */
const KIND_WORDS: Record<ChangeKind, string> = {
  A: 'added on this branch',
  M: 'modified on this branch',
  D: 'deleted on this branch',
  T: 'type changed on this branch',
};

function rowTitle(file: TouchedFile, kind: ChangeKind | null, now: number): string {
  const facts: string[] = [];
  if (file.lastTouchedAt !== null) facts.push(`changed ${relativeTime(file.lastTouchedAt, now)} ago`);
  if (file.gitStatus !== null) facts.push(`git ${file.gitStatus.trim() || '--'}`);
  else if (kind !== null) facts.push(KIND_WORDS[kind]);
  if (file.handEdited) facts.push('saved by hand in the editor');
  return `${file.path}\n${facts.join(' · ')}`;
}

function linesTitle(change: LineChange | null): string {
  if (change === null) return 'No line count: unchanged against the base branch, or not tracked by git yet';
  if (change.added === null) return 'Binary file';
  return `${change.added} line(s) added, ${change.deleted} removed, against the base branch`;
}

/** add / del / mod / none, from a porcelain code or a branch-diff letter. Drives the status colour. */
export function statusTone(code: string | null): 'add' | 'del' | 'mod' | 'none' {
  if (code === null) return 'none';
  const letters = code.replace(/ /g, '');
  if (letters.includes('D')) return 'del';
  if (letters.includes('?') || letters.includes('A')) return 'add';
  if (letters === '') return 'none';
  return 'mod';
}

/**
 * Modification time per worktree-relative path. A path that cannot be read --
 * deleted, or outside the granted scope -- is simply absent, and its row keeps
 * the transcript's time.
 */
async function modifiedTimes(root: string, paths: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    paths.map(async (p) => {
      try {
        const m = (await stat(`${root}/${p}`)).mtime;
        if (m) out.set(p, m.getTime());
      } catch {
        /* no time: see above */
      }
    }),
  );
  return out;
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
