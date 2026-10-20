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
import { adoptSessionIntoTask, createTask } from '../db';
import { linkTaskSession, newSessionId } from '../capture/sessionLink';
import { findProjectByRepo } from '../db/projects';
import { defaultBranchOf, listBranches, repoRootFor } from '../git/worktree';
import {
  probeResumePlace,
  recreateWorktree,
  switchMainCheckout,
  type ResumePlacePlan,
} from '../git/resumePlace';
import { relativeTime } from './TaskList';
import { displayName, wrapForTooltip } from './text';
import './worktree.css';

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

/** The base a resumed task records. See the call site. */
async function resumeBase(
  planned: string | null,
  project: Project | null,
  repo: string,
  branch: string,
): Promise<string> {
  const pick = (b: string | null | undefined) => (b && b !== branch ? b : null);
  return (
    pick(planned) ??
    pick(project?.defaultBaseBranch) ??
    pick(await defaultBranchOf(repo).catch(() => null)) ??
    // A session on the default branch itself: there is nothing else to name.
    branch
  );
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
  /** A folder to resume in instead of the recorded cwd. */
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  /** What a gone folder could be replaced with; null while unknown or nothing. */
  const [place, setPlace] = useState<ResumePlacePlan | null>(null);
  /**
   * Git work to do before resuming, in place of a folder: recreate the gone
   * worktree at its old path, or switch the main checkout to its branch.
   * Ignored while `cwdOverride` is set -- a chosen folder wins.
   */
  const [action, setAction] = useState<'recreate' | 'switch' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Claude Code session files Albedo is not holding. Read from disk, not the db. */
  const [disk, setDisk] = useState<DiskSession[]>([]);
  const [diskLoading, setDiskLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  /** cwd -> exists. The db layer deliberately never stats the disk. */
  const [cwdState, setCwdState] = useState<Map<string, boolean>>(() => new Map());

  const aliveRef = useRef(true);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pickFolderRef = useRef<HTMLButtonElement | HTMLInputElement | null>(null);

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
    (session: PastSession, override: string | null, recreating = false): 'no-cwd' | 'cwd-missing' | null => {
      const cwd = override ?? session.cwd;
      if (!cwd) return 'no-cwd';
      if (!override && !recreating && cwdOk(session) === false) return 'cwd-missing';
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
  const folderGone = selected !== null && cwdOk(selected) === false;
  const pending = cwdOverride ? null : action;
  const cwdMissing = folderGone && !cwdOverride && !pending;

  /**
   * A gone folder: find out whether its branch can be put back where it was,
   * or is checked out somewhere else, and preselect the better of the two.
   * Recreating is preferred because only it makes the conversation's paths
   * true again.
   */
  const goneCwd = folderGone ? selected.cwd : null;
  const goneBranch = folderGone ? selected.branch : null;
  useEffect(() => {
    setPlace(null);
    setAction(null);
    if (!goneCwd) return;
    let cancelled = false;
    void probeResumePlace(goneCwd, goneBranch).then((plan) => {
      if (cancelled || !aliveRef.current || !plan) return;
      setPlace(plan);
      if (plan.recreate) setAction('recreate');
      else if (plan.elsewhere) setCwdOverride((o) => o ?? plan.elsewhere);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, goneCwd, goneBranch]);

  const pickFolder = useCallback(async () => {
    try {
      const picked = await openFolderDialog({ directory: true, multiple: false });
      if (typeof picked === 'string') {
        setCwdOverride(picked);
        setAction(null);
      }
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const resume = useCallback(
    async (session: PastSession, mode: ResumeMode) => {
      // A chosen folder wins over any git action.
      const act = !cwdOverride && place !== null ? action : null;
      const cwd = act === 'switch' ? (place?.main?.path ?? null) : (cwdOverride ?? session.cwd);
      if (!cwd) {
        setError('This session has no recorded folder. Choose one to resume in.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // First, before any row exists: if git refuses, nothing was created.
        if (act === 'recreate' && place) await recreateWorktree(place, cwd);
        if (act === 'switch' && place) await switchMainCheckout(place);

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
         * the session ran in a LINKED WORKTREE: `~/agents/acme/ACME-2398`
         * is acme, but it matches no project row, so the task lands in
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
          // What the task's work is measured against: never its own branch,
          // which made the Files pane empty and hid the PR (prLookupBranch
          // skips branch === base). The project's default, else the repo's.
          baseBranch: await resumeBase(act && place ? place.baseBranch : null, project, repoRoot ?? cwd, branch),
          branch,
          // The session's own directory, NOT a worktree Albedo cut, and NOT
          // the resolved repo root -- resuming in the wrong folder would be a
          // far worse bug than a mis-grouped tab. Paired with ownsWorktree:
          // false so archive can never offer to remove it; resolving which
          // project a directory belongs to says nothing about who created it.
          // The one exception is a worktree recreated just now: Albedo made
          // that folder, so archive may offer to remove it again. A switched
          // main checkout is still the user's own and stays false.
          worktreePath: cwd,
          ownsWorktree: act === 'recreate',
          // The session's branch was the user's before Albedo saw it.
          createdBranch: false,
        });

        const args = ['--resume', session.sessionId];
        if (mode === 'fork') {
          // A fork lands under a NEW session id, chosen here so the task is on
          // it from the start -- capture used to find the fork by folder, and a
          // folder identifies no session (sessionLink.ts).
          //
          // And deliberately NO adoption here, despite the continue path below
          // doing it: the source conversation's history belongs to the source
          // session, not to the fork's task. Adopting would move 200 messages
          // the fork did not produce onto it, and take them off the original.
          const forkId = newSessionId();
          args.push('--fork-session', '--session-id', forkId);
          await linkTaskSession(task.id, forkId, 'browser');
          task.sessionId = forkId;
        } else {
          // Continuing keeps the id, and setting it now is what suppresses the
          // project's initial-prompt template (the gate is sessionId === null).
          await linkTaskSession(task.id, session.sessionId, 'browser');
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
    [cwdOverride, action, place, onResumed, onClose],
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
      // A gone folder always stops here, even with a folder already filled in:
      // that one may be Albedo's suggestion rather than the user's choice.
      if (cwdOk(session) === false || resumeBlocker(session, override) !== null) {
        setSelectedId(session.sessionId);
        if (session.sessionId !== selectedId) setCwdOverride(null);
        window.requestAnimationFrame(() => pickFolderRef.current?.focus());
        return;
      }
      await resume(session, 'continue');
    },
    [busy, selectedId, cwdOverride, cwdOk, resumeBlocker, resume, onOpenTask, onClose],
  );

  if (!open) return null;

  return (
    <div className="sb-overlay" onPointerDown={() => !busy && onClose()}>
      <div
        className="sb-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Past Sessions"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="sb-head">
          <span className="sb-title">Past Sessions</span>
          <input
            ref={searchRef}
            className="sb-search"
            type="search"
            placeholder="Search everything said in 41 days of sessions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner sb-banner">{error}</div>}

        <div className="sb-list">
          {loading && sessions.length === 0 && <div className="sb-empty">Reading…</div>}
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
                {session.taskId !== null && <span className="sb-chip">Open</span>}
                {cwdOk(session) === false && (
                  <span className="sb-chip" data-tone="warn">
                    Folder Gone
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
                In Claude Code, Not Imported
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
                    {importing === d.sessionId ? 'Importing…' : 'Import'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {diskLoading && diskShown.length === 0 && <div className="sb-empty">Reading Claude Code sessions…</div>}
        </div>

        {selected && (
          <div className="sb-detail">
            <div className="sb-detail-path" title={effectiveCwd ?? undefined}>
              {effectiveCwd ? homeRelative(effectiveCwd) : 'No folder recorded'}
              {cwdOverride && <span className="sb-chip">Using This Instead</span>}
            </div>

            {folderGone && (
              <div className="sb-warn">
                That folder no longer exists.{' '}
                {place
                  ? <>Its branch <span className="wt-mono">{place.branch}</span> still does.</>
                  : <>The conversation's file paths point at it, so resuming elsewhere will not
                    line up perfectly — pick the closest equivalent.</>}
              </div>
            )}

            {folderGone && place && selected.cwd && (
              <div className="wt-field sb-places" role="radiogroup" aria-label="Where to resume">
                {place.recreate && (
                  <label className="wt-option" data-selected={pending === 'recreate'}>
                    <input
                      ref={(el) => {
                        pickFolderRef.current = el;
                      }}
                      type="radio"
                      name="sb-place"
                      checked={pending === 'recreate'}
                      disabled={busy}
                      onChange={() => {
                        setAction('recreate');
                        setCwdOverride(null);
                      }}
                    />
                    <span>
                      <span className="wt-option-label">Recreate the Worktree Here</span>
                      <span className="wt-option-detail">
                        <span className="wt-mono">git worktree add</span> at{' '}
                        <span className="wt-mono">{homeRelative(selected.cwd)}</span> on{' '}
                        <span className="wt-mono">{place.branch}</span>. The conversation's file
                        paths line up exactly.
                      </span>
                    </span>
                  </label>
                )}
                {place.elsewhere && (
                  <label className="wt-option" data-selected={cwdOverride === place.elsewhere}>
                    <input
                      ref={(el) => {
                        if (!place.recreate) pickFolderRef.current = el;
                      }}
                      type="radio"
                      name="sb-place"
                      checked={cwdOverride === place.elsewhere}
                      disabled={busy}
                      onChange={() => {
                        setAction(null);
                        setCwdOverride(place.elsewhere);
                      }}
                    />
                    <span>
                      <span className="wt-option-label">Use {homeRelative(place.elsewhere)}</span>
                      <span className="wt-option-detail">
                        Where <span className="wt-mono">{place.branch}</span> is checked out now,
                        which is also why it cannot be recreated at the old path.
                      </span>
                    </span>
                  </label>
                )}
                {place.main && (
                  <label
                    className="wt-option"
                    data-selected={pending === 'switch'}
                  >
                    <input
                      type="radio"
                      name="sb-place"
                      checked={pending === 'switch'}
                      disabled={busy || place.main.dirty !== 0}
                      onChange={() => {
                        setAction('switch');
                        setCwdOverride(null);
                      }}
                    />
                    <span>
                      <span className="wt-option-label">
                        Switch {homeRelative(place.main.path)} to {place.branch}
                      </span>
                      <span className="wt-option-detail">
                        The main checkout, currently on{' '}
                        <span className="wt-mono">{place.main.current ?? 'a detached HEAD'}</span>.{' '}
                        {place.main.dirty === 0 ? (
                          <>
                            Runs <span className="wt-mono">git switch {place.branch}</span> there; no
                            worktree is made.
                          </>
                        ) : place.main.dirty === null ? (
                          'Its uncommitted changes could not be read, so switching is not offered.'
                        ) : (
                          `It has ${place.main.dirty} uncommitted change(s). Commit or stash them to switch.`
                        )}
                      </span>
                    </span>
                  </label>
                )}
                <label
                  className="wt-option"
                  data-selected={cwdOverride !== null && cwdOverride !== place.elsewhere}
                >
                  <input
                    type="radio"
                    name="sb-place"
                    checked={cwdOverride !== null && cwdOverride !== place.elsewhere}
                    disabled={busy}
                    onChange={() => void pickFolder()}
                  />
                  <span>
                    <span className="wt-option-label">Choose Another Folder…</span>
                    {cwdOverride !== null && cwdOverride !== place.elsewhere && (
                      <span className="wt-option-detail wt-mono">{homeRelative(cwdOverride)}</span>
                    )}
                  </span>
                </label>
              </div>
            )}

            <div className="sb-actions">
              {(!place || !folderGone) && (cwdMissing || !effectiveCwd || selected.taskId === null) && (
                <button
                  ref={(el) => {
                    if (!place || !folderGone) pickFolderRef.current = el;
                  }}
                  className={cwdMissing || !effectiveCwd ? 'btn' : 'btn btn-ghost'}
                  onClick={() => void pickFolder()}
                  disabled={busy}
                  title="Resume this conversation in a folder other than the one it ran in"
                >
                  {cwdMissing || !effectiveCwd ? 'Choose Folder…' : 'Other Folder…'}
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
                    Open Task
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
                    disabled={busy || resumeBlocker(selected, cwdOverride, pending !== null) !== null}
                    onClick={() => void resume(selected, 'fork')}
                  >
                    Branch from It
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy || resumeBlocker(selected, cwdOverride, pending !== null) !== null}
                    onClick={() => void resume(selected, 'continue')}
                  >
                    {pending === 'recreate'
                      ? 'Recreate and Continue'
                      : pending === 'switch'
                        ? 'Switch and Continue'
                        : 'Continue This Session'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* The bindings this dialog actually has: no more, no fewer. */}
        <div className="sb-foot" aria-hidden="true">
          <span>Double-click a row to continue it, or open its task</span>
          <span>
            <span className="kbd">Esc</span> Close
          </span>
        </div>
      </div>
    </div>
  );
}
