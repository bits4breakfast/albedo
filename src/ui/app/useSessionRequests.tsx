import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Project, Task } from '../../types';
import { startInbox, stopInbox } from '../../capture/inbox';
import { startPreviewGate } from '../../capture/previewGate';
import type { NewTaskPrefill } from '../followUp';
import Requests from '../Requests';
import { denyRequest, dismissRequest, receiveRequest, useRequests, type QueuedRequest, type SessionRequest } from '../requestQueue';
import { proposalProjectId } from '../proposals';

/**
 * The approved request's New Task prefill: the request's title and prompt, in
 * the project it names when that is one of ours (by name, ignoring case),
 * else the requesting task's. Pure for tests.
 */
export function prefillFor(req: SessionRequest, tasks: readonly Task[], projects: readonly Project[]): NewTaskPrefill {
  const asking = tasks.find((t) => t.id === req.taskId);
  return {
    projectId: proposalProjectId(req, tasks, projects),
    title: req.title,
    prompt: req.prompt,
    request: { id: req.id },
    // The asking task (#332): the new one is spun out of it, and a fork
    // copies its session. Claude's `start` is only the preselected choice.
    ...(asking
      ? {
          from: {
            taskId: asking.id,
            title: asking.title,
            sessionId: asking.sessionId,
            kind: asking.kind,
            start: req.start,
          },
        }
      : {}),
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
    // Previews (#348) listen first: a line read at launch must reach them.
    startPreviewGate()
      .then(() =>
        startInbox((req) => {
          const t = tasksRef.current.find((x) => x.id === req.taskId);
          receiveRequest(req, { title: t?.title, archived: t?.status === 'archived' });
        }),
      )
      .catch((err: unknown) => {
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
    // Recorded, so the asking task's transcript can say "Not spun out" (#332).
    deny: denyRequest,
  };
}
