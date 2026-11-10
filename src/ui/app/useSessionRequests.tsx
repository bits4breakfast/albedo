import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Project, Task } from '../../types';
import { startInbox, stopInbox } from '../../capture/inbox';
import type { NewTaskPrefill } from '../followUp';
import Requests from '../Requests';
import { dismissRequest, receiveRequest, useRequests, type QueuedRequest, type SessionRequest } from '../requestQueue';
import { proposalProjectId } from '../proposals';

/**
 * The approved request's New Task prefill: the request's title and prompt, in
 * the project it names when that is one of ours (by name, ignoring case),
 * else the requesting task's. Pure for tests.
 */
export function prefillFor(req: SessionRequest, tasks: readonly Task[], projects: readonly Project[]): NewTaskPrefill {
  return {
    projectId: proposalProjectId(req, tasks, projects),
    title: req.title,
    prompt: req.prompt,
    request: { id: req.id },
  };
}

export interface SessionRequests {
  /** The header's Requests button: every kind but `request_session` (#332). */
  button: ReactNode;
  /** The whole queue, oldest first: the list's Proposed group takes the `request_session` ones (proposals.ts). */
  items: readonly QueuedRequest[];
  /** Approve…: New Task opens filled in from the request. Nothing is created until Create. */
  approve: (req: SessionRequest) => void;
  /** Deny: the request leaves the queue. */
  deny: (id: string) => void;
}

/**
 * Albedo's MCP inbox in the shell (#157): starts reading it once the task
 * list has loaded -- a request is checked against the tasks, and an empty
 * list while loading would turn every one away. Gives the header its
 * Requests button, and the task list the requests for new sessions, which it
 * shows in its Proposed group (#332).
 */
export default function useSessionRequests(opts: {
  tasks: Task[];
  loading: boolean;
  projects: Project[];
  select: (taskId: number) => void;
  /** Opens New Task with this prefill. Nothing is created until Create. */
  openNewTask: (prefill: NewTaskPrefill) => void;
}): SessionRequests {
  const { tasks, loading, projects, select, openNewTask } = opts;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const items = useRequests();

  useEffect(() => {
    if (loading) return;
    startInbox((req) => {
      const t = tasksRef.current.find((x) => x.id === req.taskId);
      receiveRequest(req, { title: t?.title, archived: t?.status === 'archived' });
    }).catch((err: unknown) => {
      // Optional, like the hooks: without it sessions still run; say so.
      console.warn('[inbox] not started: requests from sessions will not appear', err);
    });
  }, [loading]);

  useEffect(
    () => () => {
      void stopInbox();
    },
    [],
  );

  return {
    button: (
      <Requests
        items={items}
        titleOf={(id) => tasks.find((t) => t.id === id)?.title ?? null}
        onDismiss={dismissRequest}
        onOpenTask={select}
      />
    ),
    items,
    approve: (req) => openNewTask(prefillFor(req, tasks, projects)),
    deny: dismissRequest,
  };
}
