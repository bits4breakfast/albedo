/**
 * SessionBrowser — the back catalogue.
 *
 * Owner: shell workstream (M2).
 *
 * Albedo has had every past Claude Code session indexed since M1, and until now
 * none of it was reachable from the UI. 115 conversations over 41.8 days is a
 * corpus, not a dropdown, so this is a browser with search over message bodies
 * rather than a picker.
 *
 * ## The safety constraint
 *
 * A resumed session runs in the cwd it originally used, which is usually the
 * main repo checkout rather than a worktree Albedo cut. Tasks created here are
 * therefore marked `ownsWorktree: false`, so the archive flow can never offer
 * `git worktree remove` on the user's actual working tree. That flag is the
 * whole reason this component creates the task itself instead of reusing the
 * new-task path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import type { Project, Task } from '../types';
import type { PastSession } from '../db/sessions';
import { listPastSessions } from '../db/sessions';
import { createTask, updateTask } from '../db';
import { listBranches } from '../git/worktree';
import { relativeTime } from './TaskList';

/** Typing in the search box should not fire a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 220;
const PAGE = 200;

export type ResumeMode = 'continue' | 'fork';

export interface SessionBrowserProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  /** The session already belongs to a task — show it rather than resuming again. */
  onOpenTask: (taskId: number) => void;
  /** A task was created for this session; `args` is what its pty must spawn with. */
  onResumed: (task: Task, args: string[]) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

/** Title, or the least-bad thing we have. */
function sessionLabel(session: PastSession): string {
  if (session.title && session.title.trim().length > 0) return session.title.trim();
  if (session.cwd) return `session in ${basename(session.cwd)}`;
  return `session ${session.sessionId.slice(0, 8)}`;
}

export default function SessionBrowser({
  open,
  onClose,
  projects,
  onOpenTask,
  onResumed,
}: SessionBrowserProps) {
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Overrides a recorded cwd that no longer exists. */
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const aliveRef = useRef(true);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const rows = await listPastSessions({ query: q.trim() || undefined, limit: PAGE });
      if (!aliveRef.current) return;
      setSessions(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setSessions([]);
      setError(messageOf(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // Reset and focus each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedId(null);
    setCwdOverride(null);
    setNow(Date.now());
    void load('');
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, load]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void load(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const selected = useMemo(
    () => sessions.find((s) => s.sessionId === selectedId) ?? null,
    [sessions, selectedId],
  );

  const effectiveCwd = cwdOverride ?? selected?.cwd ?? null;
  // `cwdExists` is null when capture did not check; only false is a real problem.
  const cwdMissing = !cwdOverride && selected?.cwdExists === false;

  const pickFolder = useCallback(async () => {
    try {
      const picked = await openFolderDialog({ directory: true, multiple: false });
      if (typeof picked === 'string') setCwdOverride(picked);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const resume = useCallback(
    async (session: PastSession, mode: ResumeMode) => {
      const cwd = cwdOverride ?? session.cwd;
      if (!cwd) {
        setError('This session has no recorded folder. Choose one to resume in.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // Best-effort: a resumed session need not be in a git repo at all.
        let branch = '';
        try {
          branch = (await listBranches(cwd)).current;
        } catch {
          /* not a repo, or git unavailable — the task just has no branch */
        }

        const project = projects.find((p) => p.repoPath === cwd) ?? null;
        const task = await createTask({
          title: sessionLabel(session),
          projectId: project?.id ?? null,
          repoPath: cwd,
          baseBranch: branch,
          branch,
          // The session's own directory, NOT a worktree Albedo cut. Paired with
          // ownsWorktree: false so archive can never offer to remove it.
          worktreePath: cwd,
          ownsWorktree: false,
        });

        const args = ['--resume', session.sessionId];
        if (mode === 'fork') {
          // A fork lands under a NEW session id, so the task must not claim the
          // source id — capture will adopt whatever the fork writes.
          args.push('--fork-session');
        } else {
          // Continuing keeps the id, and setting it now is what suppresses the
          // project's initial-prompt template (the gate is sessionId === null).
          await updateTask(task.id, { sessionId: session.sessionId });
          task.sessionId = session.sessionId;
        }

        onResumed(task, args);
        onClose();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [cwdOverride, projects, onResumed, onClose],
  );

  if (!open) return null;

  return (
    <div className="sb-overlay" onPointerDown={() => !busy && onClose()}>
      <div
        className="sb-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Past sessions"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="sb-head">
          <span className="sb-title">Past sessions</span>
          <input
            ref={searchRef}
            className="sb-search"
            type="search"
            placeholder="Search everything said in 41 days of sessions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button className="btn btn-ghost" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner sb-banner">{error}</div>}

        <div className="sb-list">
          {loading && sessions.length === 0 && <div className="sb-empty">reading…</div>}
          {!loading && sessions.length === 0 && (
            <div className="sb-empty">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : 'No sessions captured yet.'}
            </div>
          )}
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              className="sb-row"
              data-selected={session.sessionId === selectedId}
              data-adopted={session.taskId !== null}
              onClick={() => {
                setSelectedId(session.sessionId);
                setCwdOverride(null);
              }}
              onDoubleClick={() => {
                if (session.taskId !== null) {
                  onOpenTask(session.taskId);
                  onClose();
                }
              }}
            >
              <span className="sb-row-title">{sessionLabel(session)}</span>
              <span className="sb-row-age">{relativeTime(session.lastTs, now)}</span>
              <span className="sb-row-meta">
                <span className="sb-row-cwd">
                  {session.cwd ? homeRelative(session.cwd) : 'folder unknown'}
                </span>
                <span className="task-sep">·</span>
                <span className="sb-row-count">{session.messageCount} msgs</span>
                {session.taskId !== null && <span className="sb-chip">open</span>}
                {session.cwdExists === false && <span className="sb-chip" data-tone="warn">folder gone</span>}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <div className="sb-detail">
            <div className="sb-detail-path" title={effectiveCwd ?? undefined}>
              {effectiveCwd ? homeRelative(effectiveCwd) : 'no folder recorded'}
              {cwdOverride && <span className="sb-chip">using this instead</span>}
            </div>

            {cwdMissing && (
              <div className="sb-warn">
                That folder no longer exists. The conversation's file paths point at it, so
                resuming elsewhere will not line up perfectly — pick the closest equivalent.
              </div>
            )}

            <div className="sb-actions">
              {(cwdMissing || !effectiveCwd) && (
                <button className="btn" onClick={() => void pickFolder()} disabled={busy}>
                  Choose folder…
                </button>
              )}

              {selected.taskId !== null ? (
                <>
                  <span className="sb-note">Already open as a task.</span>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      onOpenTask(selected.taskId as number);
                      onClose();
                    }}
                  >
                    Open task
                  </button>
                </>
              ) : (
                <>
                  <span className="sb-note">
                    Continue keeps this conversation; branching copies it so the original stays
                    untouched.
                  </span>
                  <button
                    className="btn"
                    disabled={busy || !effectiveCwd}
                    onClick={() => void resume(selected, 'fork')}
                  >
                    Branch from it
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy || !effectiveCwd}
                    onClick={() => void resume(selected, 'continue')}
                  >
                    Continue this session
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
