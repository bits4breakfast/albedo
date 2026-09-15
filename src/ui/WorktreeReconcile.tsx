/**
 * WorktreeReconcile — worktrees on disk that no task claims.
 *
 * Two lists, deliberately:
 *
 *   Orphaned   worktrees under ~/agents that Albedo created and nothing now
 *              references, plus stale directories whose gitdir has gone.
 *              These are removable, one at a time, behind a confirmation that
 *              shows the uncommitted files.
 *   Not tracked  everything else git told us about — the user's own
 *              ~/www/worktrees, say. Informational only: no remove button, on
 *              purpose. A false positive here would invite deleting real work.
 *
 * Nothing destructive happens without an explicit per-row confirm, and a dirty
 * worktree needs a second, separate acknowledgement on top of that.
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useState } from 'react';
import { listTasks } from '../db';
import { listProjects } from '../db/projects';
import {
  type OrphanInfo,
  findOrphans,
  pathKey,
  reclaimableTaskPaths,
} from '../git/reconcile';
import {
  GitError,
  type WorkAtRisk,
  ackLabel,
  assessLoss,
  listBranches,
  removeWorktree,
  uncommittedChanges,
  unmergedCommits,
} from '../git/worktree';
import './worktree.css';

export interface WorktreeReconcileProps {
  open: boolean;
  onClose: () => void;
}

interface Row extends OrphanInfo {
  /** Working-tree dirtiness. null = not probed yet or unreadable. */
  dirty: boolean | null;
  files: string[];
  dirtyError: string | null;
  /**
   * Commits not merged into {@link aheadBase}. A separate kind of loss from a
   * dirty working tree, and warned about separately. null = unknown.
   */
  ahead: number | null;
  aheadBase: string | null;
  aheadError: string | null;
}

/** Project a row onto the shared {@link WorkAtRisk} shape. */
function riskOf(row: Row): WorkAtRisk {
  return {
    files: row.dirtyError !== null || row.dirty === null ? null : row.files,
    ahead: row.ahead,
    aheadBase: row.aheadBase,
  };
}

interface ConfirmState {
  path: string;
  ack: boolean;
  deleteBranch: boolean;
  busy: boolean;
  error: string | null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortHead(head: string): string {
  return head ? head.slice(0, 7) : '—';
}

export function WorktreeReconcile({ open, onClose }: WorktreeReconcileProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // --- scan ---------------------------------------------------------------

  const scan = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setConfirm(null);
    try {
      // Every task is "known" so that a live worktree is never misreported --
      // except archived ones, which are handed over as reclaimable. Archiving
      // is the user saying they are done with the worktree, so if it is still
      // on disk (they chose "archive only", or removal failed) this view is
      // where they get to finish the job. Without this the row keeps the path
      // known forever and the worktree is unreachable from the UI.
      const [tasks, projects] = await Promise.all([
        listTasks({ includeArchived: true }),
        listProjects({ includeArchived: true }),
      ]);
      // Scan every project's repo AND every repo a task remembers: a task whose
      // project was archived still has a worktree worth reconciling.
      const repoPaths = [
        ...new Set([...projects.map((p) => p.repoPath), ...tasks.map((t) => t.repoPath)].filter(Boolean)),
      ];
      // Albedo's territory is exactly the set of project worktree roots.
      // Nothing outside them is ever offered for removal.
      const worktreeRoots = [...new Set(projects.map((p) => p.worktreeRoot).filter(Boolean))];
      const knownPaths = tasks.map((t) => t.worktreePath).filter(Boolean);
      // Archived AND created by Albedo. A resumed session's cwd is the user's
      // own directory -- archived or not, it is never ours to offer up.
      const reclaimablePaths = reclaimableTaskPaths(tasks);

      // An archived task knows the branch it was cut from; prefer that over
      // the repo's current branch when comparing for unmerged commits.
      const recordedBase = new Map<string, string>();
      for (const t of tasks) {
        if (t.worktreePath && t.baseBranch) recordedBase.set(pathKey(t.worktreePath), t.baseBranch);
      }

      const found = await findOrphans({
        repoPaths,
        worktreeRoots,
        knownPaths,
        reclaimablePaths,
      });
      const initial: Row[] = found.map((o) => ({
        ...o,
        dirty: null,
        files: [],
        dirtyError: null,
        ahead: null,
        aheadBase: null,
        aheadError: null,
      }));
      setRows(initial);
      setLoading(false);

      // An orphan usually has no task row, so no recorded base branch. The
      // project's default, then the repo's current branch, are the fallbacks;
      // `unmergedCommits` prefers the worktree's own upstream over both.
      const projectBase = new Map<string, string>();
      for (const pr of projects) {
        if (pr.defaultBaseBranch) projectBase.set(pr.repoPath, pr.defaultBaseBranch);
      }
      const baseCache = new Map<string, string | null>();
      const baseFor = async (repo: string): Promise<string | null> => {
        const hit = baseCache.get(repo);
        if (hit !== undefined) return hit;
        let value: string | null = projectBase.get(repo) ?? null;
        if (value !== null) {
          baseCache.set(repo, value);
          return value;
        }
        try {
          const bs = await listBranches(repo);
          value = bs.all.includes(bs.current) ? bs.current : (bs.all[0] ?? null);
        } catch {
          value = null;
        }
        baseCache.set(repo, value);
        return value;
      };

      // Probe one at a time, updating as we go: the list is useful immediately
      // and fills in rather than blocking on the slowest repo.
      for (const o of found) {
        let patch: Partial<Row>;
        try {
          const st = await uncommittedChanges(o.path);
          patch = { dirty: st.dirty, files: st.files, dirtyError: null };
        } catch (e) {
          patch = { dirty: null, files: [], dirtyError: messageOf(e) };
        }

        const base =
          recordedBase.get(pathKey(o.path)) ?? (o.repoPath ? await baseFor(o.repoPath) : null);
        if (base === null) {
          patch.aheadError = 'No base branch to compare against, so unmerged commits are unknown.';
        } else {
          try {
            const un = await unmergedCommits(o.path, base);
            patch.ahead = un.ahead;
            patch.aheadBase = un.upstream ?? base;
            patch.aheadError = null;
          } catch (e) {
            patch.ahead = null;
            patch.aheadBase = base;
            patch.aheadError = messageOf(e);
          }
        }

        setRows((prev) => prev.map((r) => (r.path === o.path ? { ...r, ...patch } : r)));
      }
    } catch (e) {
      setLoadError(messageOf(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void scan();
    else setRows([]);
  }, [open, scan]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirm?.busy) return;
      e.stopPropagation();
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, confirm]);

  // --- removal ------------------------------------------------------------

  const doRemove = useCallback(
    async (row: Row, state: ConfirmState) => {
      if (!row.repoPath) return;
      setConfirm({ ...state, busy: true, error: null });
      try {
        await removeWorktree({
          repoPath: row.repoPath,
          path: row.path,
          branch: row.branch,
          // `force` means one thing: the user has acknowledged losing work.
          // It is what turns `git branch -d` (which refuses an unmerged branch)
          // into `-D`, so it must be set for unmerged commits too, not only for
          // a dirty working tree. It can only be true via the acknowledgement.
          force: state.ack,
          deleteBranch: state.deleteBranch && row.branch !== null,
        });
        setRows((prev) => prev.filter((r) => r.path !== row.path));
        setConfirm(null);
      } catch (e) {
        const text =
          e instanceof GitError ? e.message : `${messageOf(e)}\n(not a git failure)`;
        setConfirm({ ...state, busy: false, error: text });
      }
    },
    [],
  );

  if (!open) return null;

  const orphans = rows.filter((r) => r.classification === 'orphan');
  const unknowns = rows.filter((r) => r.classification === 'unknown');

  const renderRow = (row: Row) => {
    const confirming = confirm?.path === row.path;
    const removable = row.classification === 'orphan' && row.repoPath !== null;
    const risk = riskOf(row);
    // The chips describe the worst case (branch deleted too); the confirmation
    // below re-assesses against what the user has actually ticked, so keeping
    // the branch correctly stops warning about unmerged commits.
    const summary = assessLoss(risk, { deleteBranch: true });
    const loss =
      confirming && confirm ? assessLoss(risk, { deleteBranch: confirm.deleteBranch }) : summary;
    const dirty = loss.dirty;
    const hasUnmerged = row.ahead !== null && row.ahead > 0;

    return (
      <div
        key={row.path}
        className="wt-item"
        data-class={row.classification}
        data-dirty={summary.needsAck && !confirming}
        data-confirming={confirming}
      >
        <div className="wt-item-top">
          <span className="wt-item-path" title={row.path}>
            {row.path}
          </span>
          {removable && !confirming && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                setConfirm({
                  path: row.path,
                  ack: false,
                  deleteBranch: row.branch !== null,
                  busy: false,
                  error: null,
                })
              }
            >
              Remove…
            </button>
          )}
        </div>

        <div className="wt-item-meta">
          <span className="wt-chip">{row.branch ?? (row.detached ? 'detached' : 'no branch')}</span>
          <span className="wt-chip">{shortHead(row.head)}</span>
          {row.locked && <span className="wt-chip" data-tone="locked">locked</span>}
          {row.dirty === null && !row.dirtyError && <span className="wt-chip">checking…</span>}
          {row.dirty === false && (
            <span className="wt-chip" data-tone="clean">
              clean
            </span>
          )}
          {dirty && (
            <span className="wt-chip" data-tone="dirty">
              {row.files.length} uncommitted
            </span>
          )}
          {row.dirtyError && <span className="wt-chip">status unreadable</span>}
          {hasUnmerged && (
            <span className="wt-chip" data-tone="dirty">
              {row.ahead} unmerged
            </span>
          )}
          {row.ahead === 0 && (
            <span className="wt-chip" data-tone="clean">
              merged
            </span>
          )}
          {row.aheadError && <span className="wt-chip">unmerged commits unknown</span>}
        </div>

        <div className="wt-item-reason">{row.reason}</div>

        {row.classification === 'orphan' && !row.repoPath && (
          <div className="wt-item-reason">
            No repository to run <span className="wt-mono">git worktree remove</span> from, so
            Albedo will not touch it. Delete the directory yourself once you are sure.
          </div>
        )}

        {confirming && confirm && (
          <div className="wt-confirm">
            <div className="wt-confirm-title">
              {loss.needsAck ? 'Removing this worktree destroys work.' : 'Remove this worktree?'}
            </div>

            {/* --- loss 1: the working tree ------------------------------- */}
            {dirty && (
              <>
                <div className="wt-item-reason">
                  {row.files.length} uncommitted change(s), including untracked files:
                </div>
                <ul className="wt-filelist">
                  {row.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </>
            )}

            {row.dirtyError && (
              <div className="wt-notice">
                Could not read <span className="wt-mono">git status</span> for this worktree, so its
                uncommitted changes are unknown. Proceed only if you are certain.
                <pre className="wt-error-body">{row.dirtyError}</pre>
              </div>
            )}

            {/* --- loss 2: commits that exist nowhere else ----------------- */}
            {loss.unmerged && (
              <div className="wt-notice" data-tone="unmerged">
                <strong>
                  {row.ahead} commit(s) on {row.branch ?? 'this worktree'} are not merged into{' '}
                  <span className="wt-mono">{row.aheadBase}</span>.
                </strong>{' '}
                Deleting the branch discards them — they are not in the working tree, so the file
                list above does not cover them.
              </div>
            )}

            {row.aheadError && confirm.deleteBranch && (
              <div className="wt-notice">
                Could not work out whether this worktree has unmerged commits, so there may be
                committed work here that exists nowhere else.
                <pre className="wt-error-body">{row.aheadError}</pre>
              </div>
            )}

            {row.branch && (
              <label className="wt-check">
                <input
                  type="checkbox"
                  checked={confirm.deleteBranch}
                  disabled={confirm.busy}
                  onChange={(e) => setConfirm({ ...confirm, deleteBranch: e.target.checked })}
                />
                <span>
                  Also delete the branch <span className="wt-mono">{row.branch}</span>
                  {loss.needsAck ? (
                    <>
                      {' '}
                      (<span className="wt-mono">git branch -D</span>
                      {loss.unmerged ? ` — discards ${row.ahead} unmerged commit(s)` : ''})
                    </>
                  ) : (
                    <>
                      {' '}
                      (<span className="wt-mono">git branch -d</span>, which refuses if the branch
                      is not merged)
                    </>
                  )}
                </span>
              </label>
            )}

            {loss.needsAck && (
              <label className="wt-check" data-tone="danger">
                <input
                  type="checkbox"
                  checked={confirm.ack}
                  disabled={confirm.busy}
                  onChange={(e) => setConfirm({ ...confirm, ack: e.target.checked })}
                />
                <span>{ackLabel(risk, { deleteBranch: confirm.deleteBranch })}</span>
              </label>
            )}

            {confirm.error && (
              <div className="wt-error">
                <div className="wt-error-head">git refused</div>
                <pre className="wt-error-body">{confirm.error}</pre>
              </div>
            )}

            <div className="wt-confirm-actions">
              <button
                type="button"
                className="btn wt-btn-danger"
                disabled={confirm.busy || (loss.needsAck && !confirm.ack)}
                onClick={() => void doRemove(row, confirm)}
              >
                {confirm.busy
                  ? 'Removing…'
                  : loss.needsAck
                    ? 'Remove and discard work'
                    : 'Remove'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={confirm.busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !confirm?.busy) onClose();
      }}
    >
      <div
        className="wt-modal"
        data-wide="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-reconcile-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="wt-reconcile-title">
            Reconcile worktrees
          </h2>
          <span className="wt-modal-sub">
            {loading
              ? 'scanning…'
              : `${orphans.length} orphaned, ${unknowns.length} not tracked by a task`}
          </span>
        </div>

        <div className="wt-modal-body">
          {loadError && (
            <div className="wt-error">
              <div className="wt-error-head">The scan failed</div>
              <pre className="wt-error-body">{loadError}</pre>
            </div>
          )}

          {!loading && !loadError && rows.length === 0 && (
            <div className="wt-empty">
              <strong>Nothing to reconcile.</strong>
              Every worktree git knows about belongs to a task.
            </div>
          )}

          {orphans.length > 0 && (
            <>
              <div className="wt-group-label">
                <span>Orphaned</span>
                <span className="wt-group-rule" />
                <span>{orphans.length}</span>
              </div>
              {orphans.map(renderRow)}
            </>
          )}

          {unknowns.length > 0 && (
            <>
              <div className="wt-group-label">
                <span>Not tracked by a task — informational</span>
                <span className="wt-group-rule" />
                <span>{unknowns.length}</span>
              </div>
              {unknowns.map(renderRow)}
            </>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">
            Removal runs <span className="wt-mono">git worktree remove</span> then{' '}
            <span className="wt-mono">git worktree prune</span>. Albedo never deletes a directory
            itself.
          </span>
          <span className="wt-foot-spacer" />
          <button
            type="button"
            className="btn"
            disabled={loading || confirm?.busy}
            onClick={() => void scan()}
          >
            Rescan
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={confirm?.busy}
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export default WorktreeReconcile;
