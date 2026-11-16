import { useMemo } from 'react';
import type { Project, Task } from '../../types';

/**
 * With no task selected, Go to File and Find in Files search the active
 * project's main checkout -- the repo folder itself -- and open what they
 * find read-only. This stands in for a task so the search dialogs and the
 * editor need no second code path. Its id is negative, so it can never meet
 * a real task's id, and it is never written anywhere: the editor is
 * read-only for it (the folder is the user's real repo, not a worktree).
 */
export default function useBrowseTask(selected: Task | null, activeProject: Project | null): Task | null {
  return useMemo<Task | null>(() => {
    if (selected !== null || activeProject === null || !activeProject.repoPath) return null;
    return {
      id: -activeProject.id,
      title: activeProject.name,
      projectId: activeProject.id,
      repoPath: activeProject.repoPath,
      baseBranch: '',
      branch: '',
      worktreePath: activeProject.repoPath,
      sessionId: null,
      ownsWorktree: false,
      createdBranch: false,
      // Never spawned and never stored: only searched and read.
      kind: 'work',
      status: 'idle',
      createdAt: 0,
      lastActivityAt: null,
      seenAt: null,
      summary: null,
      reviewUrl: null,
      apiError: null,
      apiErrorText: null,
      spunFromTaskId: null,
    };
  }, [selected, activeProject]);
}
