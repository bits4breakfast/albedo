/**
 * ArchiveTaskDialog — archiving a task, including its worktree.
 *
 * The gap this closes: `archiveTask` only flips a status column. On its own
 * that leaves the worktree on disk *and* keeps its path in the task table, so
 * the reconcile view used to skip it too — the checkout became unreachable
 * from the app and the user had to drop to a terminal. Archiving now asks what
 * should happen to the worktree and does it.
 *
 * Division of labour with the shell: this dialog owns the **git** side and
 * calls `onArchived(task.id)` only once git is done. The shell's `useTasks`
 * owns the **database** side and does the `archiveTask(id)` write in response.
 * Order matters and is deliberate: if removal fails we surface git's stderr and
 * do not archive, because an archived task whose removal failed is exactly how
 * a worktree goes missing.
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useState } from 'react';
import type { Task } from '../types';
import {
  GitError,
  type WorkAtRisk,
  ackLabel,
  assessLoss,
  removeWorktree,
  uncommittedChanges,
  unmergedCommits,
} from '../git/worktree';
import './worktree.css';

/**
 * What to do with the worktree when the task is archived.
 *
 * `remove-keep-branch` is the default and never destroys committed work: the
 * branch survives, so anything committed is still reachable by name.
 */
export type ArchiveMode = 'remove-keep-branch' | 'remove-delete-branch' | 'archive-only';

export interface ArchiveTaskDialogProps {
  /** The task to archive; null closes the dialog. */
  task: Task | null;
  onClose: () => void;
  /** Called only after the chosen git work succeeded. The shell archives the row. */
  onArchived: (taskId: number) => void;
}

interface Probe {
  files: string[] | null;
  filesError: string | null;
  ahead: number | null;
  aheadBase: string | null;
  aheadError: string | null;
  done: boolean;
}

const EMPTY_PROBE: Probe = {
  files: null,
  filesError: null,
  ahead: null,
  aheadBase: null,
  aheadError: null,
  done: false,
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ArchiveTaskDialog({ task, onClose, onArchived }: ArchiveTaskDialogProps) {
  const [probe, setProbe] = useState<Probe>(EMPTY_PROBE);
  const [mode, setMode] = useState<ArchiveMode>('remove-keep-branch');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id ?? null;
  const worktreePath = task?.worktreePath ?? '';
  const baseBranch = task?.baseBranch ?? '';

  // --- probe: the two kinds of work at risk -------------------------------

  useEffect(() => {
    if (taskId === null) {
      setProbe(EMPTY_PROBE);
      setMode('remove-keep-branch');
      setAck(false);
      setError(null);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setProbe(EMPTY_PROBE);
    void (async () => {
      const next: Probe = { ...EMPTY_PROBE, done: true };
      try {
        const st = await uncommittedChanges(worktreePath);
        next.files = st.files;
      } catch (e) {
        next.files = null;
        next.filesError = messageOf(e);
      }
      try {
        const un = await unmergedCommits(worktreePath, baseBranch);
        next.ahead = un.ahead;
        next.aheadBase = un.upstream ?? baseBranch;
      } catch (e) {
        next.ahead = null;
        next.aheadBase = baseBranch;
        next.aheadError = messageOf(e);
      }
      if (!cancelled) setProbe(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, worktreePath, baseBranch]);

  // Changing the plan changes what is destroyed, so a stale tick must not
  // carry over from a more dangerous option to a safer one and back.
  useEffect(() => {
    setAck(false);
  }, [mode]);

  useEffect(() => {
    if (taskId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId, busy, onClose]);

  // --- confirm ------------------------------------------------------------

  const confirm = useCallback(async () => {
    if (!task || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode !== 'archive-only') {
        await removeWorktree({
          repoPath: task.repoPath,
          path: task.worktreePath,
          branch: task.branch,
          // `force` means the user acknowledged losing work, and is also what
          // turns `git branch -d` into `-D`. It can only be true via the tick.
          force: ack,
          deleteBranch: mode === 'remove-delete-branch',
        });
      }
      // Git is done (or was not needed). Only now is it safe to archive.
      onArchived(task.id);
    } catch (e) {
      setError(e instanceof GitError ? e.message : `${messageOf(e)}\n(not a git failure)`);
    } finally {
      setBusy(false);
    }
  }, [task, busy, mode, ack, onArchived]);

  if (!task) return null;

  const risk: WorkAtRisk = {
    files: probe.files,
    ahead: probe.ahead,
    aheadBase: probe.aheadBase,
  };
  const removing = mode !== 'archive-only';
  const loss = assessLoss(risk, { deleteBranch: mode === 'remove-delete-branch' });
  const needsAck = removing && loss.needsAck;
  const hasUnmerged = probe.ahead !== null && probe.ahead > 0;
  const fileCount = probe.files?.length ?? 0;

  const option = (value: ArchiveMode, label: string, detail: React.ReactNode) => (
    <label className="wt-option" data-selected={mode === value}>
      <input
        type="radio"
        name="wt-archive-mode"
        value={value}
        checked={mode === value}
        disabled={busy}
        onChange={() => setMode(value)}
      />
      <span>
        <span className="wt-option-label">{label}</span>
        <span className="wt-option-detail">{detail}</span>
      </span>
    </label>
  );

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
        aria-labelledby="wt-archive-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="wt-archive-title">
            Archive task
          </h2>
          <span className="wt-modal-sub">{task.title}</span>
        </div>

        <div className="wt-modal-body">
          <div className="wt-derived">
            <div className="wt-derived-row">
              <span className="wt-derived-key">Branch</span>
              <span className="wt-derived-val">
                {task.branch} <span className="wt-modal-sub">off {task.baseBranch}</span>
              </span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">Worktree</span>
              <span className="wt-derived-val">{task.worktreePath}</span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">State</span>
              <span className="wt-derived-val" data-pending={!probe.done}>
                {!probe.done
                  ? 'checking…'
                  : [
                      probe.filesError
                        ? 'uncommitted changes unknown'
                        : fileCount > 0
                          ? `${fileCount} uncommitted change(s)`
                          : 'clean',
                      probe.aheadError
                        ? 'unmerged commits unknown'
                        : hasUnmerged
                          ? `${probe.ahead} unmerged commit(s)`
                          : 'nothing unmerged',
                    ].join(' · ')}
              </span>
            </div>
          </div>

          {/* --- the choice ------------------------------------------------ */}
          <div className="wt-field" style={{ marginTop: 14 }}>
            <span className="wt-label">What happens to the worktree</span>

            {option(
              'remove-keep-branch',
              'Remove the worktree, keep the branch',
              <>
                <span className="wt-mono">git worktree remove</span> then{' '}
                <span className="wt-mono">git worktree prune</span>. Committed work stays reachable
                on <span className="wt-mono">{task.branch}</span>.
              </>,
            )}

            {option(
              'remove-delete-branch',
              'Remove the worktree and delete the branch',
              <>
                Also runs <span className="wt-mono">git branch -d</span>
                {hasUnmerged ? (
                  <>
                    {' '}
                    — but <span className="wt-mono">{task.branch}</span> has {probe.ahead} commit(s)
                    that are not in <span className="wt-mono">{probe.aheadBase}</span>, so this
                    destroys them.
                  </>
                ) : (
                  <>. Tidy when the work is merged or pushed.</>
                )}
              </>,
            )}

            {option(
              'archive-only',
              'Archive only, leave the worktree on disk',
              <>
                No git commands run. <strong>The worktree stays at</strong>{' '}
                <span className="wt-mono">{task.worktreePath}</span> and will be listed under
                Orphaned in the reconcile view, where you can remove it later.
              </>,
            )}
          </div>

          {/* --- loss 1: the working tree ---------------------------------- */}
          {removing && loss.dirty && probe.files && (
            <>
              <div className="wt-item-reason">
                {fileCount} uncommitted change(s), including untracked files, will be destroyed:
              </div>
              <ul className="wt-filelist">
                {probe.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}

          {removing && probe.filesError && (
            <div className="wt-notice">
              Could not read <span className="wt-mono">git status</span> for this worktree, so its
              uncommitted changes are unknown.
              <pre className="wt-error-body">{probe.filesError}</pre>
            </div>
          )}

          {/* --- loss 2: commits that exist nowhere else -------------------- */}
          {mode === 'remove-delete-branch' && hasUnmerged && (
            <div className="wt-notice" data-tone="unmerged">
              <strong>
                {probe.ahead} commit(s) on {task.branch} are not merged into{' '}
                <span className="wt-mono">{probe.aheadBase}</span>.
              </strong>{' '}
              Deleting the branch discards them — they are not in the working tree, so the file list
              above does not cover them. Keep the branch instead and nothing committed is lost.
            </div>
          )}

          {mode === 'remove-delete-branch' && probe.aheadError && (
            <div className="wt-notice">
              Could not work out whether this branch has unmerged commits, so there may be committed
              work here that exists nowhere else.
              <pre className="wt-error-body">{probe.aheadError}</pre>
            </div>
          )}

          {needsAck && (
            <label className="wt-check" data-tone="danger">
              <input
                type="checkbox"
                checked={ack}
                disabled={busy}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>{ackLabel(risk, { deleteBranch: mode === 'remove-delete-branch' })}</span>
            </label>
          )}

          {error && (
            <div className="wt-error">
              <div className="wt-error-head">git refused — the task has NOT been archived</div>
              <pre className="wt-error-body">{error}</pre>
              <div className="wt-error-actions">
                <span className="wt-modal-sub">
                  Nothing was archived, so you can fix this and try again, or choose “Archive only”.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">
            {removing
              ? 'The worktree is removed first; the task is archived only if that succeeds.'
              : 'The task is archived. The worktree is left exactly as it is.'}
          </span>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={needsAck ? 'btn wt-btn-danger' : 'btn btn-primary'}
            disabled={busy || !probe.done || (needsAck && !ack)}
            onClick={() => void confirm()}
          >
            {busy
              ? 'Archiving…'
              : needsAck
                ? 'Archive and discard work'
                : removing
                  ? 'Archive and remove worktree'
                  : 'Archive only'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ArchiveTaskDialog;
