/**
 * Ending a task — archiving it, or deleting it outright.
 *
 * The gap this closes: `archiveTask` only flips a status column. On its own
 * that leaves the worktree on disk *and* keeps its path in the task table, so
 * the reconcile view used to skip it too — the checkout became unreachable
 * from the app and the user had to drop to a terminal. Archiving now asks what
 * should happen to the worktree and does it.
 *
 * **One component serves both verbs on purpose.** Everything that decides what
 * is destroyed — the probes, the loss assessment, the acknowledgement wording —
 * is identical for archive and delete, and two dialogs would be two places for
 * that to drift. Only the words and the final callback differ.
 *
 * Division of labour with the shell: this dialog owns the **git** side and
 * calls back only once git is done. The shell owns the **database** side.
 * Order matters and is deliberate: if removal fails we surface git's stderr and
 * do not end the task, because a task whose removal failed is exactly how a
 * worktree goes missing.
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useState } from 'react';
import type { Task } from '../types';
import { albedoOwnsWorktree, worktreeSharedWithLiveTask } from '../git/reconcile';
import {
  GitError,
  RiskChangedError,
  type WorkAtRisk,
  type WorkProbe,
  ackLabel,
  assessLoss,
  probeWorkAtRisk,
  removeWorktree,
  mayDeleteTaskBranch,
} from '../git/worktree';
import { stopPhpantom } from '../lsp/phpantom';
import './worktree.css';

/**
 * What to do with the worktree when the task is archived.
 *
 * `remove-keep-branch` is the default and never destroys committed work: the
 * branch survives, so anything committed is still reachable by name.
 */
export type ArchiveMode = 'remove-keep-branch' | 'remove-delete-branch' | 'keep-worktree';

/**
 * Which of the two endings this is.
 *
 *  - `archive` — the task leaves the active list and stays under Archived.
 *  - `delete`  — the task row and Albedo's copy of its conversation are gone.
 *    Claude Code's own transcript file is untouched. Archive is the ending
 *    that keeps history.
 */
export type EndIntent = 'archive' | 'delete';

export interface ArchiveTaskDialogProps {
  /** The task to end; null closes the dialog. */
  task: Task | null;
  /** Defaults to `archive`, so an existing caller is unaffected. */
  intent?: EndIntent;
  onClose: () => void;
  /** Called after the chosen git work succeeded. The shell flips the status. */
  onArchived: (taskId: number) => void;
  /**
   * Called after the chosen git work succeeded, for `intent === 'delete'`.
   *
   * The implementation removes the task row and Albedo's copy of its
   * conversation (see `deleteTask`). Claude Code's own transcript file is not
   * touched.
   *
   * This dialog tells the user in as many words that the conversation is
   * removed from Albedo. That sentence is a promise the data layer keeps.
   */
  onDeleted?: (taskId: number) => void;
  /**
   * The other tasks, to tell whether a live one runs in the same directory
   * (a resumed session, a reused slug). If so, removal is not offered.
   */
  otherTasks?: readonly Task[];
}

interface Probe {
  files: string[] | null;
  filesError: string | null;
  ahead: number | null;
  aheadBase: string | null;
  aheadError: string | null;
  head: string | null;
  /**
   * Whether this task's branch was cut by Albedo for it. False when the user
   * chose "Check out the existing branch" -- or when that cannot be shown, in
   * which case deleting the branch is simply not offered.
   */
  createdBranch: boolean;
  done: boolean;
}

const EMPTY_PROBE: Probe = {
  files: null,
  filesError: null,
  ahead: null,
  aheadBase: null,
  aheadError: null,
  head: null,
  createdBranch: false,
  done: false,
};

/** Fold a fresh {@link WorkProbe} into the dialog's probe state. */
function fromWorkProbe(p: WorkProbe, createdBranch: boolean): Probe {
  return {
    files: p.risk.files,
    filesError: p.filesError,
    ahead: p.risk.ahead,
    aheadBase: p.risk.aheadBase,
    aheadError: p.aheadError,
    head: p.risk.head ?? null,
    createdBranch,
    done: true,
  };
}

/**
 * Whether deleting the task's branch may be offered.
 *
 * A branch this task's `worktree add -b` cut, always (the tick covers any loss).
 * Any other branch only when deleting it loses nothing: no commits outside the
 * base and no uncommitted files. Who created it does not matter then, and
 * `git branch -d` itself refuses if that changes. The remote branch is never
 * touched either way.
 */
export function branchDeletable(p: Pick<Probe, 'createdBranch' | 'ahead' | 'files' | 'done'>): boolean {
  if (!p.done) return false;
  return p.createdBranch || (p.ahead === 0 && p.files !== null && p.files.length === 0);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ArchiveTaskDialog({
  task,
  intent = 'archive',
  onClose,
  onArchived,
  onDeleted,
  otherTasks = [],
}: ArchiveTaskDialogProps) {
  const deleting = intent === 'delete';
  const [probe, setProbe] = useState<Probe>(EMPTY_PROBE);
  const [mode, setMode] = useState<ArchiveMode>('remove-keep-branch');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The error is "more at risk than you ticked for", not a git failure. */
  const [riskChanged, setRiskChanged] = useState(false);

  const taskId = task?.id ?? null;
  const worktreePath = task?.worktreePath ?? '';
  const baseBranch = task?.baseBranch ?? '';
  const repoPath = task?.repoPath ?? '';
  const branch = task?.branch ?? '';
  const createdAt = task?.createdAt ?? 0;
  const createdBranch = task?.createdBranch ?? null;
  /**
   * Whether Albedo created this directory. False for a resumed session, which
   * runs in whatever cwd it originally used -- frequently the user's main
   * checkout. When false this dialog offers no removal of any kind: not a
   * disabled button, not an unselected radio. An option that dangerous should
   * not exist on the screen at all.
   */
  const owned = task === null || (albedoOwnsWorktree(task) && !worktreeSharedWithLiveTask(task, otherTasks));

  // --- probe: the two kinds of work at risk -------------------------------

  useEffect(() => {
    if (taskId === null) {
      setProbe(EMPTY_PROBE);
      setMode('remove-keep-branch');
      setAck(false);
      setError(null);
      setRiskChanged(false);
      setBusy(false);
      return;
    }
    // Nothing is going to be removed, so there is nothing to quantify. Probing
    // here would print the user's real working state under a heading about
    // losing work, and a number next to a confirmation button reads as a
    // warning however carefully it is labelled.
    if (!owned) {
      setProbe({ ...EMPTY_PROBE, done: true });
      return;
    }
    let cancelled = false;
    setProbe(EMPTY_PROBE);
    void (async () => {
      try {
        const work = await probeWorkAtRisk(worktreePath, baseBranch || null);
        const created = await mayDeleteTaskBranch({ repoPath, branch, createdAt, createdBranch });
        if (cancelled) return;
        const next = fromWorkProbe(work, created);
        setProbe(next);
        const nothingAtRisk = next.ahead === 0 && next.files !== null && next.files.length === 0;
        // Deleting a task whose work is all merged: delete means delete, so
        // the branch goes too unless the user picks otherwise.
        if (deleting && nothingAtRisk && branchDeletable(next)) setMode('remove-delete-branch');
        // Never leave a selection on an option that is no longer offered.
        else if (!branchDeletable(next)) setMode((m) => (m === 'remove-delete-branch' ? 'remove-keep-branch' : m));
      } catch (e) {
        // Both calls promise not to throw. If one does anyway, finish the probe
        // as "unknown" rather than leave the dialog on "checking…" with its
        // button disabled for good.
        if (cancelled) return;
        const msg = messageOf(e);
        setProbe({ ...EMPTY_PROBE, filesError: msg, aheadError: msg, done: true });
        setMode((m) => (m === 'remove-delete-branch' ? 'remove-keep-branch' : m));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, worktreePath, baseBranch, repoPath, branch, createdAt, createdBranch, owned, deleting]);

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
      // An archived task needs no language server, whatever happens to its
      // folder. Stopping is the whole cleanup: PHPantom writes nothing to disk.
      // stopPhpantom never throws; the catch keeps that true here whatever it
      // becomes, because an optional server must never leave a task that cannot
      // be archived (docs/REGRESSIONS.md, "Cleanup paths").
      await stopPhpantom(task.worktreePath).catch((err: unknown) => console.warn('[phpantom] stop on archive', err));
      // `owned` is checked here as well as in the render: the render decides
      // what is offered, this decides what runs, and the two failing together
      // is the only way a not-owned directory could be touched.
      if (owned && mode !== 'keep-worktree') {
        await removeWorktree({
          repoPath: task.repoPath,
          path: task.worktreePath,
          branch: task.branch,
          // `force` means the user acknowledged losing work, and is also what
          // turns `git branch -d` into `-D`. It can only be true via the tick.
          force: ack,
          // Re-checked here as well as in the render, like `owned`: a branch
          // the task did not create is never deleted.
          deleteBranch: mode === 'remove-delete-branch' && branchDeletable(probe),
          // What the tick was given for. removeWorktree probes again and
          // refuses if Claude has added to it since the dialog opened.
          acknowledged: {
            risk: { files: probe.files, ahead: probe.ahead, aheadBase: probe.aheadBase, head: probe.head },
            baseBranch: task.baseBranch || null,
          },
        });
      }
      // Git is done (or was not needed). Only now is it safe to touch the row.
      if (deleting) (onDeleted ?? onArchived)(task.id);
      else onArchived(task.id);
    } catch (e) {
      if (e instanceof RiskChangedError) {
        // Show what is there now and take the tick away: it was given for
        // less than is now at stake.
        setProbe(fromWorkProbe(e.now, probe.createdBranch));
        setAck(false);
        setRiskChanged(true);
        setError(e.message);
      } else {
        setRiskChanged(false);
        setError(e instanceof GitError ? e.message : `${messageOf(e)}\n(not a git failure)`);
      }
    } finally {
      setBusy(false);
    }
  }, [task, busy, mode, ack, owned, deleting, probe, onArchived, onDeleted]);

  if (!task) return null;

  /**
   * A chat (#49) made nothing: no worktree, no branch. `owned` is already
   * false for it (albedoOwnsWorktree), so nothing is probed or offered; this
   * only picks the words. Archiving a chat just closes it.
   */
  const chat = task.kind === 'chat';

  const risk: WorkAtRisk = {
    files: probe.files,
    ahead: probe.ahead,
    aheadBase: probe.aheadBase,
    head: probe.head,
  };
  // Not owned means there is nothing to remove, so nothing is offered and the
  // dialog is a different act with a different name. See the render below.
  const removing = owned && mode !== 'keep-worktree';
  const canDeleteBranch = branchDeletable(probe);
  const deleteBranch = mode === 'remove-delete-branch' && canDeleteBranch;
  const loss = assessLoss(risk, { deleteBranch });
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
            {deleting ? 'Delete Task' : owned || chat ? 'Archive Task' : 'Remove from List'}
          </h2>
          <span className="wt-modal-sub">{task.title}</span>
        </div>

        <div className="wt-modal-body">
          <div className="wt-derived">
            {chat ? (
              <div className="wt-derived-row">
                <span className="wt-derived-key">Kind</span>
                <span className="wt-derived-val">Chat — no branch</span>
              </div>
            ) : (
              <div className="wt-derived-row">
                <span className="wt-derived-key">Branch</span>
                <span className="wt-derived-val">
                  {task.branch} <span className="wt-modal-sub">off {task.baseBranch}</span>
                </span>
              </div>
            )}
            <div className="wt-derived-row">
              <span className="wt-derived-key">{chat ? 'Folder' : 'Worktree'}</span>
              <span className="wt-derived-val">{task.worktreePath}</span>
            </div>
            {owned && (
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
            )}
          </div>

          {/* --- not ours: say so plainly, offer nothing ---------------------- */}
          {chat && (
            <div className="wt-notice" data-tone="safe" style={{ marginTop: 14 }}>
              <strong>Nothing on disk is touched.</strong> This chat ran in your main checkout,{' '}
              <span className="wt-mono">{task.worktreePath}</span>, and created no worktree and no
              branch, so there is nothing to remove.{' '}
              {deleting
                ? 'Deleting removes the task and its conversation from Albedo.'
                : 'Archiving closes it; the conversation and its transcript are kept.'}
            </div>
          )}
          {!owned && !chat && (
            <div className="wt-notice" data-tone="safe" style={{ marginTop: 14 }}>
              <strong>Nothing on disk is touched.</strong> This task is a resumed session, so
              Albedo did not create <span className="wt-mono">{task.worktreePath}</span> — it is
              your own working directory. No worktree is removed, no branch is deleted, and the
              directory is not even inspected.{' '}
              {deleting
                ? 'Deleting removes the task from Albedo only.'
                : 'Removing the task drops it from the list.'}{' '}
              {deleting
                ? 'Its conversation is removed from Albedo too.'
                : 'The conversation and its transcript are kept.'}
            </div>
          )}

          {/* --- the choice ------------------------------------------------ */}
          {owned && (
          <div className="wt-field" style={{ marginTop: 14 }}>
            <span className="wt-label">What Happens to the Worktree</span>

            {option(
              'remove-keep-branch',
              'Remove the Worktree, Keep the Branch',
              <>
                <span className="wt-mono">git worktree remove</span> then{' '}
                <span className="wt-mono">git worktree prune</span>. Committed work stays reachable
                on <span className="wt-mono">{task.branch}</span>.
              </>,
            )}

            {/* A branch this task's `worktree add -b` cut, or any branch whose
                deletion loses nothing (see branchDeletable). Otherwise it may
                be the user's own, and "could not tell" is treated the same. */}
            {probe.done && !canDeleteBranch && (
              <div className="wt-hint">
                Deleting <span className="wt-mono">{task.branch}</span> is not offered: Albedo
                cannot show that this task created it, so it may be a branch you already had.
              </div>
            )}

            {canDeleteBranch && option(
              'remove-delete-branch',
              'Remove the Worktree and Delete the Branch',
              <>
                Also runs <span className="wt-mono">git branch -d</span>
                {!probe.createdBranch ? (
                  <>
                    . Nothing on <span className="wt-mono">{task.branch}</span> is outside{' '}
                    <span className="wt-mono">{probe.aheadBase ?? task.baseBranch}</span>, so nothing is
                    lost, and git refuses if that changes. The remote branch is not touched.
                  </>
                ) : hasUnmerged ? (
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
              'keep-worktree',
              deleting
                ? 'Delete the Task Only, Leave the Worktree on Disk'
                : 'Archive Only, Leave the Worktree on Disk',
              <>
                No git commands run. <strong>The worktree stays at</strong>{' '}
                <span className="wt-mono">{task.worktreePath}</span> and will be listed under
                Orphaned in the reconcile view, where you can remove it later.
              </>,
            )}
          </div>
          )}

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
          {deleteBranch && hasUnmerged && (
            <div className="wt-notice" data-tone="unmerged">
              <strong>
                {probe.ahead} commit(s) on {task.branch} are not merged into{' '}
                <span className="wt-mono">{probe.aheadBase}</span>.
              </strong>{' '}
              Deleting the branch discards them — they are not in the working tree, so the file list
              above does not cover them. Keep the branch instead and nothing committed is lost.
            </div>
          )}

          {deleteBranch && probe.aheadError && (
            <div className="wt-notice">
              Could not work out whether this branch has unmerged commits, so there may be committed
              work here that exists nowhere else.
              <pre className="wt-error-body">{probe.aheadError}</pre>
            </div>
          )}

          {/* A separate kind of loss from the worktree warnings above, and the
              user should be able to tell which one they are agreeing to: this
              is about the Albedo row, not about their files. */}
          {deleting && (
            <div className="wt-notice" data-tone="unmerged">
              <strong>The task is removed from Albedo and cannot be brought back.</strong> Its
              title, branch and status are gone.{' '}
              <strong>Its conversation is removed from Albedo too</strong> — it will no longer be
              searchable here. Claude Code's own transcript file is not touched. Use Archive
              instead to keep the history.
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
              <span>{ackLabel(risk, { deleteBranch })}</span>
            </label>
          )}

          {error && (
            <div className="wt-error">
              <div className="wt-error-head">
                {riskChanged
                  ? 'The worktree changed — nothing was removed or archived'
                  : 'git refused — the task has NOT been archived'}
              </div>
              <pre className="wt-error-body">{error}</pre>
              <div className="wt-error-actions">
                <span className="wt-modal-sub">
                  Nothing was archived, so you can fix this and try again, or choose “Archive Only”.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">
            {chat
              ? 'Your main checkout is left exactly as it is.'
              : !owned
                ? 'Albedo only forgets the task. Your files and your branch are untouched.'
              : removing
                ? `The worktree is removed first; the task is ${deleting ? 'deleted' : 'archived'} only if that succeeds.`
                : `The task is ${deleting ? 'deleted' : 'archived'}. The worktree is left exactly as it is.`}
          </span>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={needsAck || deleting ? 'btn wt-btn-danger' : 'btn btn-primary'}
            // Archive only runs no git, so it does not wait for the probe.
            disabled={busy || (removing && !probe.done) || (needsAck && !ack)}
            onClick={() => void confirm()}
          >
            {busy
              ? deleting
                ? 'Deleting…'
                : owned || chat
                  ? 'Archiving…'
                  : 'Removing…'
              : deleting
                ? !owned
                  ? 'Delete Task'
                  : needsAck
                    ? 'Delete Task and Discard Work'
                    : removing
                      ? deleteBranch
                        ? 'Delete Task, Worktree and Branch'
                        : 'Delete Task and Remove Worktree'
                      : 'Delete Task Only'
                : chat
                  ? 'Archive Task'
                  : !owned
                  ? 'Remove from List'
                  : needsAck
                    ? 'Archive and Discard Work'
                    : removing
                      ? deleteBranch
                        ? 'Archive, Remove Worktree and Branch'
                        : 'Archive and Remove Worktree'
                      : 'Archive Only'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ArchiveTaskDialog;
