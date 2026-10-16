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
import { exists } from '@tauri-apps/plugin-fs';
import type { Project, Task } from '../types';
import type { PastSession } from '../db/sessions';
import { listPastSessions } from '../db/sessions';
import { importTranscripts, listDiskSessions, type DiskSession } from '../capture';
import { adoptSessionIntoTask, createTask, updateTask } from '../db';
import { findProjectByRepo } from '../db/projects';
import { listBranches, repoRootFor } from '../git/worktree';
import { relativeTime } from './TaskList';
import { displayName, wrapForTooltip } from './text';

/** Typing in the search box should not fire a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 220;
const PAGE = 200;

/**
 * Branches that identify nothing. 53 of this machine's 115 sessions are on
 * `master` and 15 on `HEAD`, so for the largest cluster the branch is not the
 * discriminator and must not look like one -- these render dimmed so the eye
 * moves straight to the prompt and the files instead.
 */
const WEAK_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop', 'trunk']);

export type ResumeMode = 'continue' | 'fork';

export interface SessionBrowserProps {
  open: boolean;
  onClose: () => void;
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

/**
 * The headline, in order of how much it actually identifies a conversation.
 * Title is best but is null for anything Claude Code never titled, so the first
 * user prompt is the fallback that always exists.
 */
function sessionLabel(session: PastSession): string {
  const title = session.title?.trim();
  if (title) return title;
  // A first prompt can be an entire paragraph. This value is both a row
  // headline AND the created task's title, so it is capped here rather than
  // left for each consumer to shorten differently.
  const prompt = session.firstPrompt?.trim();
  if (prompt) return displayName(prompt, 120);
  if (session.branch) return session.branch;
  if (session.cwd) return `session in ${basename(session.cwd)}`;
  return `session ${session.sessionId.slice(0, 8)}`;
}

/** The second line: whatever the headline did not already use. */
function sessionSubtitle(session: PastSession): string | null {
  const title = session.title?.trim();
  const prompt = session.firstPrompt?.trim();
  if (title && prompt) return prompt;
  return null;
}

/**
 * The cwd that says nothing here, because nearly every row shares it. Computed
 * from the current result set rather than from config, so it self-calibrates:
 * whatever is unremarkable in THIS list is what gets suppressed.
 */
function modalCwd(sessions: PastSession[]): string | null {
  if (sessions.length < 4) return null;
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [cwd, n] of counts) {
    if (n > bestN) {
      best = cwd;
      bestN = n;
    }
  }
  // Only worth suppressing if it really is the background case.
  return bestN >= Math.max(3, sessions.length * 0.25) ? best : null;
}

export default function SessionBrowser({
  open,
  onClose,
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
  /** Claude Code session files Albedo is not holding. Read from disk, not the db. */
  const [disk, setDisk] = useState<DiskSession[]>([]);
  const [diskLoading, setDiskLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  /** cwd -> exists. The db layer deliberately never stats the disk. */
  const [cwdState, setCwdState] = useState<Map<string, boolean>>(() => new Map());

  const aliveRef = useRef(true);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pickFolderRef = useRef<HTMLButtonElement | null>(null);

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

  const loadDisk = useCallback(async () => {
    setDiskLoading(true);
    try {
      const rows = await listDiskSessions();
      if (aliveRef.current) setDisk(rows);
    } catch (err) {
      if (aliveRef.current) setDisk([]);
      console.warn('[history] could not list Claude Code sessions on disk', err);
    } finally {
      if (aliveRef.current) setDiskLoading(false);
    }
  }, []);

  const importSession = useCallback(
    async (d: DiskSession) => {
      if (importing) return;
      setImporting(d.sessionId);
      setError(null);
      try {
        await importTranscripts(d.path);
        await Promise.all([load(query), loadDisk()]);
      } catch (err) {
        setError(`Could not import: ${messageOf(err)}`);
      } finally {
        if (aliveRef.current) setImporting(null);
      }
    },
    [importing, load, loadDisk, query],
  );

  // Reset and focus each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedId(null);
    setCwdOverride(null);
    setNow(Date.now());
    void load('');
    void loadDisk();
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, load, loadDisk]);

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

  /**
   * Stat each DISTINCT cwd once, not each row. 115 sessions share 13 folders,
   * so this is ~13 calls rather than 115.
   */
  useEffect(() => {
    const wanted = [...new Set(sessions.map((s) => s.cwd).filter((c): c is string => !!c))];
    const missing = wanted.filter((c) => !cwdState.has(c));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const found = await Promise.all(
        missing.map(async (cwd) => [cwd, await exists(cwd).catch(() => true)] as const),
      );
      if (cancelled || !aliveRef.current) return;
      setCwdState((prev) => {
        const next = new Map(prev);
        for (const [cwd, ok] of found) next.set(cwd, ok);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessions, cwdState]);

  /**
   * Why this session cannot be continued right now, or null if it can.
   *
   * Deliberately ONE expression, consulted by both the Continue button and the
   * double-click accelerator. An accelerator that bypasses a guard is worse
   * than no accelerator: the guard exists precisely for the case the user is
   * moving fast through.
   */
  const cwdOk = useCallback(
    (session: PastSession): boolean | null => {
      if (session.cwdExists !== null) return session.cwdExists;
      if (!session.cwd) return null;
      return cwdState.get(session.cwd) ?? null;
    },
    [cwdState],
  );

  const commonCwd = useMemo(() => modalCwd(sessions), [sessions]);

  /** On-disk sessions the db does not hold, narrowed by the search box. */
  const diskShown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const held = new Set(sessions.map((x) => x.sessionId));
    return disk.filter(
      (d) =>
        !held.has(d.sessionId) &&
        (q === '' || `${d.title ?? ''} ${d.cwd ?? ''}`.toLowerCase().includes(q)),
    );
  }, [disk, sessions, query]);

  const resumeBlocker = useCallback(
    (session: PastSession, override: string | null): 'no-cwd' | 'cwd-missing' | null => {
      const cwd = override ?? session.cwd;
      if (!cwd) return 'no-cwd';
      if (!override && cwdOk(session) === false) return 'cwd-missing';
      return null;
    },
    [cwdOk],
  );

  const selected = useMemo(
    () => sessions.find((s) => s.sessionId === selectedId) ?? null,
    [sessions, selectedId],
  );

  const effectiveCwd = cwdOverride ?? selected?.cwd ?? null;
  // `cwdExists` is null when capture did not check; only false is a real problem.
  const cwdMissing = !cwdOverride && selected !== null && cwdOk(selected) === false;

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

        /*
         * Which project owns this directory.
         *
         * Comparing the cwd to `projects.repo_path` directly is wrong whenever
         * the session ran in a LINKED WORKTREE: `~/agents/upsellguru/UP-2398`
         * is upsellguru, but it matches no project row, so the task lands in
         * "Other". `repoRootFor` resolves through git's common dir, which
         * returns the same root from inside a worktree or the main checkout.
         *
         * Failure here is expected and silent -- a session in ~/Downloads is
         * not in a repo at all. Null projectId, "Other" tab, no error.
         */
        let repoRoot: string | null = null;
        try {
          repoRoot = (await repoRootFor(cwd)) || null;
        } catch {
          /* not a git repo */
        }
        let project: Project | null = null;
        if (repoRoot) {
          try {
            project = await findProjectByRepo(repoRoot);
          } catch {
            /* db unreachable -- grouping is not worth failing the resume over */
          }
        }

        const task = await createTask({
          title: sessionLabel(session),
          projectId: project?.id ?? null,
          // The ORIGIN repo, per the Task contract. Only the association uses
          // the resolved root; the session still runs where it ran.
          repoPath: repoRoot ?? cwd,
          baseBranch: branch,
          branch,
          // The session's own directory, NOT a worktree Albedo cut, and NOT
          // the resolved repo root -- resuming in the wrong folder would be a
          // far worse bug than a mis-grouped tab. Paired with ownsWorktree:
          // false so archive can never offer to remove it; resolving which
          // project a directory belongs to says nothing about who created it.
          worktreePath: cwd,
          ownsWorktree: false,
        });

        const args = ['--resume', session.sessionId];
        if (mode === 'fork') {
          // A fork lands under a NEW session id, so the task must not claim the
          // source id — capture will adopt whatever the fork writes.
          //
          // And deliberately NO adoption here, despite the continue path below
          // doing it: the source conversation's history belongs to the source
          // session, not to the fork's task. Adopting would move 200 messages
          // the fork did not produce onto it, and take them off the original.
          args.push('--fork-session');
        } else {
          // Continuing keeps the id, and setting it now is what suppresses the
          // project's initial-prompt template (the gate is sessionId === null).
          await updateTask(task.id, { sessionId: session.sessionId });
          task.sessionId = session.sessionId;

          /*
           * Claim the EXISTING history for this task, now.
           *
           * Rows captured before Albedo existed have task_id = NULL, and the
           * watcher only backfills them when NEW lines arrive. So without this
           * the transcript pane is empty until the agent writes something --
           * and permanently empty for anyone who resumed a session in order to
           * READ it, which is the exact case this feature was built for.
           *
           * Idempotent (`WHERE task_id IS NULL`), so it is safe on a session
           * that was already adopted.
           */
          try {
            await adoptSessionIntoTask(session.sessionId, task.id);
          } catch (err) {
            // Degrades to the old behaviour -- the pane fills in once new lines
            // land -- which is not worth failing the resume over.
            console.warn('[albedo] could not adopt session history', err);
          }
        }

        onResumed(task, args);
        onClose();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [cwdOverride, onResumed, onClose],
  );

  /**
   * Double-click: do the obvious thing with this row.
   *
   * Continue rather than fork, because an accelerator is not a decision
   * surface — the two buttons stay equally weighted for someone actually
   * choosing, and forking is something you go looking for. When the row is
   * blocked, the obvious thing becomes "get me to what is blocking it", so it
   * selects the row and focuses the folder picker instead of resuming.
   */
  const activate = useCallback(
    async (session: PastSession) => {
      if (busy) return;
      if (session.taskId !== null) {
        onOpenTask(session.taskId);
        onClose();
        return;
      }
      const override = session.sessionId === selectedId ? cwdOverride : null;
      if (resumeBlocker(session, override) !== null) {
        setSelectedId(session.sessionId);
        if (session.sessionId !== selectedId) setCwdOverride(null);
        window.requestAnimationFrame(() => pickFolderRef.current?.focus());
        return;
      }
      await resume(session, 'continue');
    },
    [busy, selectedId, cwdOverride, resumeBlocker, resume, onOpenTask, onClose],
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
          {sessions.map((session) => {
            const subtitle = sessionSubtitle(session);
            return (
            <button
              key={session.sessionId}
              className="sb-row"
              title={session.cwd ? homeRelative(session.cwd) : undefined}
              data-selected={session.sessionId === selectedId}
              data-adopted={session.taskId !== null}
              onClick={() => {
                // Re-clicking the selected row must not discard a folder the
                // user just picked for it.
                if (session.sessionId === selectedId) return;
                setSelectedId(session.sessionId);
                setCwdOverride(null);
              }}
              onDoubleClick={() => void activate(session)}
            >
              {/* Branch leads: 87 distinct values across 115 sessions, and on
                  this machine they read as issue keys, which is how the work is
                  actually named. cwd has 13 distinct values and identifies
                  almost nothing, so it has lost the leading position. */}
              <span
                className="sb-row-branch"
                data-weak={!session.branch || WEAK_BRANCHES.has(session.branch)}
                title={session.branch ?? undefined}
              >
                {session.branch ?? '—'}
              </span>
              <span className="sb-row-title" title={wrapForTooltip(sessionLabel(session))}>
                {sessionLabel(session)}
              </span>
              <span className="sb-row-age">{relativeTime(session.lastTs, now)}</span>

              {subtitle && (
                <span className="sb-row-sub" title={wrapForTooltip(subtitle)}>
                  {subtitle}
                </span>
              )}

              <span className="sb-row-meta">
                {session.topFiles && session.topFiles.length > 0 && (
                  <span className="sb-row-files" title={session.topFiles.join(', ')}>
                    {session.topFiles.slice(0, 3).join(' · ')}
                  </span>
                )}
                <span className="sb-row-count">{session.messageCount} msgs</span>
                {/* Shown only where it says something. A column of 115
                    identical paths is noise; an unexpected one is a fact. */}
                {session.cwd && session.cwd !== commonCwd && (
                  <span className="sb-row-cwd">{homeRelative(session.cwd)}</span>
                )}
                {session.taskId !== null && <span className="sb-chip">open</span>}
                {cwdOk(session) === false && (
                  <span className="sb-chip" data-tone="warn">
                    folder gone
                  </span>
                )}
              </span>
            </button>
            );
          })}

          {/* Sessions Claude Code still has on disk that Albedo does not hold.
              Deleting a task clears Albedo's copy; this is the way back. They
              are listed from the filesystem, so they are not searchable until
              imported. */}
          {diskShown.length > 0 && (
            <div className="sb-disk" aria-label="Sessions in Claude Code not imported">
              <div className="sb-disk-head">
                In Claude Code, not imported
                <span className="sb-disk-note"> — import to search or resume with history</span>
              </div>
              {diskShown.map((d) => (
                <div className="sb-disk-row" key={d.path} title={d.cwd ? homeRelative(d.cwd) : d.path}>
                  <span className="sb-disk-title">{d.title || (d.cwd ? displayName(d.cwd) : d.sessionId.slice(0, 8))}</span>
                  <span className="sb-disk-meta">
                    {d.cwd ? homeRelative(d.cwd) : d.projectDir} · {relativeTime(d.mtime, now)} ·{' '}
                    {formatBytes(d.size)}
                  </span>
                  <button
                    className="btn btn-ghost"
                    disabled={importing !== null}
                    onClick={() => void importSession(d)}
                  >
                    {importing === d.sessionId ? 'importing…' : 'Import'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {diskLoading && diskShown.length === 0 && <div className="sb-empty">reading Claude Code sessions…</div>}
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
                <button
                  ref={pickFolderRef}
                  className="btn"
                  onClick={() => void pickFolder()}
                  disabled={busy}
                >
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
                    disabled={busy || resumeBlocker(selected, cwdOverride) !== null}
                    onClick={() => void resume(selected, 'fork')}
                  >
                    Branch from it
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy || resumeBlocker(selected, cwdOverride) !== null}
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
