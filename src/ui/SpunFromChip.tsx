/**
 * "from <source>" in the task bar (#332): the task this one was spun out of,
 * by an approved request or Fork Conversation…. A click shows the source.
 *
 * The task list holds live tasks only, so an archived source is read once
 * from the database: it is named, in the floor tier, and is not a link (an
 * archived task has nowhere in the list to go). A deleted source has no
 * title left to name, so nothing is shown.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { getTask } from '../db';
import { spunFromLink } from './spinOut';

export interface SpunFromChipProps {
  task: Pick<Task, 'id' | 'spunFromTaskId'>;
  /** The live tasks, as the list has them. */
  tasks: readonly Pick<Task, 'id' | 'title' | 'status'>[];
  onOpen: (taskId: number) => void;
}

export default function SpunFromChip({ task, tasks, onOpen }: SpunFromChipProps) {
  const live = spunFromLink(task, tasks);
  const sourceId = task.spunFromTaskId;
  const [stored, setStored] = useState<{ id: number; title: string; status: Task['status'] } | null>(null);

  useEffect(() => {
    if (sourceId === null || live) return;
    let alive = true;
    void getTask(sourceId)
      .then((t) => {
        if (alive) setStored(t ? { id: t.id, title: t.title, status: t.status } : null);
      })
      .catch(() => {
        if (alive) setStored(null);
      });
    return () => {
      alive = false;
    };
  }, [sourceId, live]);

  const link = live ?? (stored && stored.id === sourceId ? spunFromLink(task, [stored]) : null);
  if (!link) return null;
  if (!link.live) {
    return (
      <span className="main-ident-from" data-gone="true" title={`Spun out of “${link.title}”, since archived`}>
        from {link.title}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="main-ident-from"
      title={`Spun out of “${link.title}”\nShow it`}
      onClick={() => onOpen(link.taskId)}
    >
      from {link.title}
    </button>
  );
}
