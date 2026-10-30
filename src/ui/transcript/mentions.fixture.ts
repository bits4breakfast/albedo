/** A task for the `@` reference tests (#154). */
import type { Task } from '../../types';

export function task(id: number, title: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title,
    projectId: 1,
    repoPath: '/code/app',
    baseBranch: 'main',
    branch: `b-${id}`,
    worktreePath: `/code/app-wt/${id}`,
    sessionId: `0000000${id}-aaaa-bbbb-cccc-dddddddddddd`,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 1000 + id,
    lastActivityAt: 2000 + id,
    seenAt: null,
    ...over,
  } as Task;
}
