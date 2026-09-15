/**
 * EmptyState — one decision, rendered in several places.
 *
 * Owner: shell workstream (M2).
 *
 * This exists because the same bug shipped twice. "What should an empty state
 * say, and what should its button do" was written inline at each site, so
 * fixing the sidebar left the pty pane still telling a user who had just
 * created a project to create a project. A button offering the thing you have
 * already done is worse than no button: it implies the previous step did not
 * take.
 *
 * The rule that got it wrong both times: **never infer "nothing is set up"
 * from a count of something else.** `tasks.length === 0` does not mean "no
 * projects"; it means no tasks. The two questions are answered separately
 * below and neither is allowed to stand in for the other.
 *
 * Any new empty state should render from here. If it cannot, that is worth
 * noticing rather than working around.
 */

import type { ReactNode } from 'react';
import type { Project } from '../types';

export interface EmptyStateProps {
  /** How many projects exist AT ALL — not how many tasks, not how many rows. */
  projectCount: number;
  /** The project the view is scoped to, when there is one. */
  activeProject: Project | null;
  onAddProject?: () => void;
  onNewTask?: () => void;
  /** `pane` centres in a large area; `list` reads as a paragraph in a column. */
  variant?: 'pane' | 'list';
}

interface Content {
  key: 'no-projects' | 'project-empty' | 'no-tasks';
  headline: ReactNode;
  body: ReactNode;
  action: 'add-project' | 'new-task';
}

/** Exported for tests and for anyone who needs the decision without the markup. */
export function emptyStateContent(
  projectCount: number,
  activeProject: Project | null,
): Content {
  // Nothing exists yet: the only useful next step is creating a project, and
  // this is the ONLY state in which that is true.
  if (projectCount === 0) {
    return {
      key: 'no-projects',
      headline: 'No projects yet',
      body: (
        <>
          A task is cut from a <strong>project</strong> — a repo Albedo keeps worktrees for.
        </>
      ),
      action: 'add-project',
    };
  }

  // A project is in scope. ⌘N now has somewhere to go, so say where.
  if (activeProject) {
    return {
      key: 'project-empty',
      headline: (
        <>
          No tasks in <strong>{activeProject.name}</strong> yet
        </>
      ),
      body: (
        <>
          <span className="placeholder-key">⌘N</span> cuts a worktree in {activeProject.name} and
          starts a session in it.
        </>
      ),
      action: 'new-task',
    };
  }

  return {
    key: 'no-tasks',
    headline: 'No tasks yet',
    body: (
      <>
        <span className="placeholder-key">⌘N</span> cuts a worktree and starts a session.
      </>
    ),
    action: 'new-task',
  };
}

export default function EmptyState({
  projectCount,
  activeProject,
  onAddProject,
  onNewTask,
  variant = 'list',
}: EmptyStateProps) {
  const content = emptyStateContent(projectCount, activeProject);
  const handler = content.action === 'add-project' ? onAddProject : onNewTask;
  const label = content.action === 'add-project' ? 'Add a project' : 'New task';

  return (
    <div className="empty-state" data-variant={variant} data-state={content.key}>
      <p className="empty-state-headline">{content.headline}</p>
      <p className="empty-state-body">{content.body}</p>
      {handler && (
        <button
          className={content.action === 'new-task' ? 'btn btn-primary' : 'btn'}
          onClick={handler}
        >
          {label}
        </button>
      )}
    </div>
  );
}
