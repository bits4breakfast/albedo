/**
 * NewTaskDialog — create a task, which means creating a git worktree.
 *
 * The dialog's job is to make the consequence visible *before* it happens: the
 * derived branch name and the worktree path are shown live and read-only, so
 * the user knows exactly where the work will land. When git refuses, git's own
 * stderr is shown verbatim — never flattened into "something went wrong".
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import type { Task } from '../types';
import { createTask } from '../db';
import { branchNameFor, slugify } from '../git/slug';
import {
  GitError,
  agentsRoot,
  composeWorktreePath,
  createWorktree,
  listBranches,
  repoName,
} from '../git/worktree';
import './worktree.css';

const RECENTS_KEY = 'albedo.worktree.recentRepos';
const RECENTS_MAX = 6;

export interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Task) => void;
}

// ---------------------------------------------------------------------------
// localStorage recents. Wrapped: a locked-down WebView can throw on access.
// ---------------------------------------------------------------------------

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    // Not worth surfacing: the dialog still works without recents.
  }
}

function pushRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENTS_MAX);
}

/** Last two segments of a path, for a compact recents chip. */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `.../${parts.slice(-2).join('/')}`;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------

export function NewTaskDialog({ open, onClose, onCreated }: NewTaskDialogProps) {
  const [repoPath, setRepoPath] = useState('');
  const [title, setTitle] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [repoLabel, setRepoLabel] = useState('');
  const [home, setHome] = useState('');
  const [recents, setRecents] = useState<string[]>([]);

  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: string } | null>(null);

  const titleRef = useRef<HTMLInputElement | null>(null);
  // Guards against a slow repo probe resolving after the user picked another.
  const probeSeq = useRef(0);

  // --- lifecycle ----------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    setRecents(loadRecents());
    let cancelled = false;
    void (async () => {
      try {
        const { homeDir } = await import('@tauri-apps/api/path');
        const h = await homeDir();
        if (!cancelled) setHome(h);
      } catch {
        if (!cancelled) setHome('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset on close so the next open starts clean (except the recents list).
  useEffect(() => {
    if (open) return;
    setTitle('');
    setError(null);
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  // --- repo probe: name + branches ----------------------------------------

  const probeRepo = useCallback(async (path: string) => {
    const seq = ++probeSeq.current;
    setRepoBusy(true);
    setRepoError(null);
    setRepoLabel('');
    setBranches([]);
    setBaseBranch('');
    try {
      const [name, bs] = await Promise.all([repoName(path), listBranches(path)]);
      if (seq !== probeSeq.current) return;
      setRepoLabel(name);
      setBranches(bs.all);
      // Default to the repo's current branch, which is what the user means
      // nine times out of ten. If HEAD is detached it is not in `all`, so fall
      // back to the first real branch rather than offering a commit id.
      setBaseBranch(bs.all.includes(bs.current) ? bs.current : (bs.all[0] ?? ''));
    } catch (e) {
      if (seq !== probeSeq.current) return;
      setRepoError(messageOf(e));
    } finally {
      if (seq === probeSeq.current) setRepoBusy(false);
    }
  }, []);

  const chooseRepo = useCallback(
    async (path: string) => {
      setRepoPath(path);
      setError(null);
      const next = pushRecent(loadRecents(), path);
      setRecents(next);
      saveRecents(next);
      await probeRepo(path);
    },
    [probeRepo],
  );

  const browse = useCallback(async () => {
    try {
      const picked = await openFileDialog({
        directory: true,
        multiple: false,
        title: 'Choose a repository',
        defaultPath: repoPath || undefined,
      });
      if (typeof picked === 'string') await chooseRepo(picked);
    } catch (e) {
      setRepoError(messageOf(e));
    }
  }, [chooseRepo, repoPath]);

  // --- derived values, shown live -----------------------------------------

  const slug = useMemo(() => (title.trim() ? slugify(title) : ''), [title]);
  const branch = useMemo(() => (slug ? branchNameFor(slug) : ''), [slug]);
  const worktreePath = useMemo(
    () => (home && repoLabel && slug ? composeWorktreePath(home, repoLabel, slug) : ''),
    [home, repoLabel, slug],
  );

  const canSubmit =
    !busy && !repoBusy && repoPath !== '' && title.trim() !== '' && baseBranch !== '' &&
    branch !== '' && worktreePath !== '';

  // --- submit -------------------------------------------------------------

  const submit = useCallback(
    async (useExistingBranch: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await createWorktree({
          repoPath,
          baseBranch,
          branch,
          path: worktreePath,
          useExistingBranch,
        });
        // Only once the worktree exists on disk does a task row make sense:
        // a task whose worktree is missing is worse than no task at all.
        const task = await createTask({
          title: title.trim(),
          repoPath,
          baseBranch,
          branch,
          worktreePath,
        });
        onCreated(task);
      } catch (e) {
        const kind = e instanceof GitError ? e.kind : 'unknown';
        setError({ text: messageOf(e), kind });
      } finally {
        setBusy(false);
      }
    },
    [busy, repoPath, baseBranch, branch, worktreePath, title, onCreated],
  );

  if (!open) return null;

  const agents = home ? agentsRoot(home) : '~/agents';

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="wt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-newtask-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="wt-newtask-title">
            New task
          </h2>
          <span className="wt-modal-sub">a worktree under {agents}</span>
        </div>

        <div className="wt-modal-body">
          {/* --- repository ------------------------------------------------ */}
          <div className="wt-field">
            <span className="wt-label">Repository</span>
            <div className="wt-row">
              <span className="wt-repo-path" data-empty={repoPath === ''} title={repoPath}>
                {repoPath ? `‎${repoPath}` : 'No repository chosen'}
              </span>
              <button type="button" className="btn" onClick={() => void browse()} disabled={busy}>
                Browse…
              </button>
            </div>
            {recents.length > 0 && (
              <div className="wt-recents">
                {recents.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="wt-recent"
                    title={p}
                    disabled={busy}
                    onClick={() => void chooseRepo(p)}
                  >
                    {shortPath(p)}
                  </button>
                ))}
              </div>
            )}
            {repoBusy && <div className="wt-hint">Reading branches…</div>}
            {repoError && (
              <div className="wt-error">
                <div className="wt-error-head">git could not read that directory</div>
                <pre className="wt-error-body">{repoError}</pre>
              </div>
            )}
          </div>

          {/* --- title ------------------------------------------------------ */}
          <div className="wt-field">
            <label className="wt-label" htmlFor="wt-title">
              Title
            </label>
            <input
              id="wt-title"
              ref={titleRef}
              className="wt-input"
              type="text"
              value={title}
              placeholder="Fix the login redirect loop"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit(false);
              }}
            />
          </div>

          {/* --- base branch ------------------------------------------------ */}
          <div className="wt-field">
            <label className="wt-label" htmlFor="wt-base">
              Base branch
            </label>
            <select
              id="wt-base"
              className="wt-select"
              value={baseBranch}
              disabled={busy || repoBusy || branches.length === 0}
              onChange={(e) => {
                setBaseBranch(e.target.value);
                setError(null);
              }}
            >
              {branches.length === 0 && <option value="">—</option>}
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          {/* --- derived preview -------------------------------------------- */}
          <div className="wt-derived">
            <div className="wt-derived-row">
              <span className="wt-derived-key">Branch</span>
              <span className="wt-derived-val" data-pending={branch === ''}>
                {branch || 'from the title'}
              </span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">Worktree</span>
              <span className="wt-derived-val" data-pending={worktreePath === ''}>
                {worktreePath ||
                  (repoPath ? `${agents}/${repoLabel || '<repo>'}/<slug>` : 'choose a repository')}
              </span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">Command</span>
              <span className="wt-derived-val" data-pending={!canSubmit}>
                {canSubmit
                  ? `git worktree add -b ${branch} -- ${worktreePath} ${baseBranch}`
                  : 'git worktree add …'}
              </span>
            </div>
          </div>

          {/* --- failure ----------------------------------------------------- */}
          {error && (
            <div className="wt-error">
              <div className="wt-error-head">
                {error.kind === 'branch-exists'
                  ? `The branch ${branch} already exists`
                  : 'git refused'}
              </div>
              <pre className="wt-error-body">{error.text}</pre>
              {error.kind === 'branch-exists' && (
                <div className="wt-error-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void submit(true)}
                  >
                    Check out the existing branch
                  </button>
                  <span className="wt-modal-sub">
                    runs <code className="wt-mono">git worktree add -- {worktreePath} {branch}</code>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">
            The worktree is independent — uncommitted work in {repoLabel || 'the repo'} stays put.
          </span>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => void submit(false)}
          >
            {busy ? 'Creating…' : 'Create worktree'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default NewTaskDialog;
