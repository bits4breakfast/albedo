/**
 * The task bar's identity for the project view (#181): the project, the
 * branch its main checkout is on, and New Task. The same row and the same
 * tiers a task's identity uses; nothing that needs a session.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Project } from '../types';
import { checkedOutBranch } from '../git/branchSync';
import { BranchIcon } from './icons';

/** Same cadence as the task's branch sync: a checkout happens in a terminal, unannounced. */
const BRANCH_POLL_MS = 60_000;

/**
 * The main checkout's branch, or null on a detached HEAD or any failure. Read
 * on mount, on window focus and every minute while the window is visible.
 */
function useCheckoutBranch(repoPath: string): string | null {
  const [found, setFound] = useState<{ path: string; branch: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    const run = () => {
      if (document.hidden) return;
      void checkedOutBranch(repoPath).then((branch) => {
        if (live) setFound({ path: repoPath, branch });
      });
    };
    run();
    const timer = window.setInterval(run, BRANCH_POLL_MS);
    window.addEventListener('focus', run);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
    };
  }, [repoPath]);
  return found?.path === repoPath ? found.branch : null;
}

export interface ProjectBarProps {
  project: Project;
  onNewTask: () => void;
}

export default function ProjectBar({ project, onNewTask }: ProjectBarProps): ReactNode {
  const branch = useCheckoutBranch(project.repoPath);
  return (
    <>
      <span className="main-ident-title" title={`${project.name}\n${project.repoPath}`}>
        {project.name}
      </span>
      {branch !== null && (
        <span className="main-ident-branch" title={`The main checkout is on ${branch}`}>
          <BranchIcon />
          <span className="main-ident-text">{branch}</span>
        </span>
      )}
      <button type="button" className="btn main-ident-action" onClick={onNewTask}>
        New Task
      </button>
    </>
  );
}
