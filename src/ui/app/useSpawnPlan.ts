import { useCallback, useState } from 'react';
import type { Project, Task } from '../../types';
import { displayName } from '../text';
import { fillPromptTemplate } from '../../lib/issueKey';

/**
 * Build the initial prompt for a task's first session.
 *
 * Opt-in by design: an empty or absent template yields null, and null means no
 * argv prompt at all. Silently prompting an agent the user has just launched
 * is a side effect they did not ask for, so the default is to say nothing.
 */
function renderPromptTemplate(task: Task, project: Project | null): string | null {
  // The template is written for work on a branch ("pick up {key} on
  // {branch}"); sent to a chat it would contradict the chat's own
  // instruction not to change anything. A chat starts with no prompt.
  if (task.kind === 'chat') return null;
  // Shared with the ProjectsDialog preview on purpose. A preview that drifts
  // from what the agent is actually told is worse than no preview, and two
  // expanders in two files is precisely how that drift happens.
  return fillPromptTemplate(project?.taskPromptTemplate, {
    title: task.title,
    branch: task.branch,
  });
}

/**
 * How each task's `claude` is spawned: History's one-off resume args, the
 * `--name` to give a session Albedo creates, and the prompt for a task's
 * first spawn.
 */
export default function useSpawnPlan(projects: readonly Project[]) {
  /**
   * The prompt a follow-up was created with, for its first spawn. In memory
   * on purpose: the session starts the moment the task is created, and a
   * prompt for a session that has already started is never sent again.
   */
  const [promptOverrides, setPromptOverrides] = useState<Map<number, string>>(() => new Map());
  /**
   * Resume argv for tasks created in THIS run. A fork lands under a new
   * session id that the task does not yet know, so the args cannot be derived
   * from the row until capture has adopted it.
   */
  const [pendingResume, setPendingResume] = useState<Map<number, string[]>>(() => new Map());

  /**
   * FIRST SPAWN ONLY. A task with a sessionId has already been told this; a
   * re-spawn after a kill or crash must not re-prompt, or the agent starts the
   * work over. That would read as bizarre agent behaviour rather than as a
   * spawn bug, which is exactly why the gate lives here and is stated twice.
   */
  /**
   * How this task's `claude` should be started.
   *
   * A task Albedo cut spawns fresh. A RESUMED task — `ownsWorktree === false`
   * with a session id — resumes, and keeps resuming across restarts, which is
   * what makes the feature survive closing the app. Deliberately scoped to
   * not-owned tasks: making every task resume its own session on relaunch is
   * arguably right too, but it is a behaviour change to existing tasks that
   * nobody asked for, so it is a separate decision.
   */
  /**
   * EVERY task with a session id resumes it — not only ones opened from the
   * browser. A cockpit for long-lived sessions whose sessions evaporate on
   * restart is not tracking them; before this, reopening a task started a
   * fresh `claude` and quietly discarded the conversation, and the pane looked
   * perfectly fine while the agent had no idea what it had been doing.
   *
   * `--resume` can legitimately fail (a pruned transcript), which the exit code
   * reports without anything reading the stream. Terminal handles that by
   * offering a fresh session rather than leaving a dead pane.
   *
   * Terminal decides the resume itself, from the task's LIVE session id
   * (ui/sessionSpawn.ts): only History's one-off args are passed down here.
   */
  const spawnArgsFor = useCallback(
    (task: Task): string[] | undefined => pendingResume.get(task.id),
    [pendingResume],
  );

  /**
   * `--name` for this spawn, or undefined to leave the session's name alone.
   *
   * Naming happens exactly where we are CREATING a session:
   *  - a brand new task (no session id yet)
   *  - a fork, which is a new session under a new id — and marked as a fork so
   *    the user can tell it from the original in their own /resume picker
   *
   * Never on a plain re-open, and never on a straight continue from the
   * browser: those sessions already have whatever name their owner gave them,
   * and overwriting it with something Albedo derived would be a quiet mutation
   * of the user's own data.
   */
  const sessionNameFor = useCallback(
    (task: Task): string | undefined => {
      /*
       * Shortened, because this one leaves our app.
       *
       * `--name` surfaces in Claude Code's prompt box, its /resume picker and
       * the terminal title. A task title created from a long prompt is a whole
       * paragraph, and a paragraph-length name degrades the very surfaces this
       * flag was added to improve. The full title stays in the database and on
       * the row; only the label we hand to another program is trimmed.
       */
      const name = displayName(task.title);
      const pending = pendingResume.get(task.id);
      if (pending) return pending.includes('--fork-session') ? `${name} (fork)` : undefined;
      if (task.sessionId === null) return name;
      return undefined;
    },
    [pendingResume],
  );

  /**
   * The user gave up on a failed resume. Drop any stale args so the retry
   * starts clean instead of re-attempting the same dead session id.
   */
  const forgetResume = useCallback((taskId: number) => {
    setPendingResume((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const initialPromptFor = useCallback(
    (task: Task): string | null => {
      if (task.sessionId !== null) return null;
      // A review task (#287) starts with no prompt: the project's Initial
      // Prompt is for your own work (it may name a ticket key), not someone
      // else's pull request. The session waits for your questions.
      if (!!task.reviewUrl) return null;
      // A follow-up's prompt was written in the dialog; empty is "none".
      const override = promptOverrides.get(task.id);
      if (override !== undefined) return override || null;
      const project = projects.find((p) => p.id === task.projectId) ?? null;
      return renderPromptTemplate(task, project);
    },
    [projects, promptOverrides],
  );

  return { setPendingResume, setPromptOverrides, spawnArgsFor, sessionNameFor, forgetResume, initialPromptFor };
}
