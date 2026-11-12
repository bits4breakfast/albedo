import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { archiveProject } from '../../db/projects';
import type useTasks from '../useTasks';
import type useLaunchNotices from './useLaunchNotices';

type Notices = ReturnType<typeof useLaunchNotices>;

/**
 * Under the header: the error banner (loading, launch or capture) with
 * Retry, and the one-line offers launch housekeeping leaves behind
 * (useLaunchNotices).
 */
export default function LaunchNotices({
  banner,
  refresh,
  worktreeProjects,
  unclaimed,
  dismiss,
  setImportOpen,
}: {
  banner: string | null;
  refresh: ReturnType<typeof useTasks>['refresh'];
  worktreeProjects: Notices['worktreeProjects'];
  unclaimed: Notices['unclaimed'];
  dismiss: Notices['dismiss'];
  setImportOpen: Dispatch<SetStateAction<boolean>>;
}): ReactNode {
  return (
    <>
      {banner && (
        <div className="banner" role="status">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          <span className="banner-text" title={banner}>
            {banner}
          </span>
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {/* Detection, never correction: a project whose root is another
          project's repo_path IS a linked worktree of it -- git says so. But
          merging or deleting a row the user created, with the wrong survivor
          picked automatically, costs far more to undo than the duplicate costs
          to live with. So: say what it is, offer the reversible action. */}
      {worktreeProjects.map((finding) => (
        <div className="notice" key={`wt-${finding.project.id}`}>
          <span className="notice-text">
            <strong>{finding.project.name}</strong> looks like a worktree of{' '}
            <strong>{finding.parent.name}</strong>. Archiving it re-associates its tasks.
          </span>
          <button
            className="btn"
            onClick={() => {
              const id = finding.project.id;
              dismiss(`wt:${id}`);
              void archiveProject(id)
                .then(() => refresh())
                .catch(() => {});
            }}
          >
            Archive It
          </button>
          <button className="btn btn-ghost" onClick={() => dismiss(`wt:${finding.project.id}`)}>
            Dismiss
          </button>
        </div>
      ))}

      {unclaimed.length > 0 && (
        <div className="notice">
          <span className="notice-text">
            {unclaimed.length} repositor{unclaimed.length === 1 ? 'y' : 'ies'} in your history{' '}
            {unclaimed.length === 1 ? 'has' : 'have'} no project yet.
          </span>
          <button className="btn" onClick={() => setImportOpen(true)}>
            Review
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => unclaimed.forEach((r) => dismiss(`repo:${r.repoRoot}`))}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
