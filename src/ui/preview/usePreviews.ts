/**
 * React's view of the previews (#348): what is waiting (capture/previewGate.ts,
 * in memory) and the stored versions (db/previews.ts).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Preview } from '../../types';
import { onPreviewChange, pendingPreview, tasksWaitingOnPreview } from '../../capture/previewGate';
import { onPreviewsChanged, previewByToolUse, previewVersions } from '../../db/previews';

function subscribeWaiting(cb: () => void): () => void {
  return onPreviewChange(() => cb());
}

/** The version a task is waiting on, or null. */
export function useWaitingPreview(taskId: number): Preview | null {
  const read = () => pendingPreview(taskId);
  return useSyncExternalStore(subscribeWaiting, read, read);
}

let waitingKey = '';
let waitingSet: ReadonlySet<number> = new Set();

/** Tasks with a version waiting: a stable set while nothing changes. */
function readWaitingTasks(): ReadonlySet<number> {
  const now = tasksWaitingOnPreview();
  const key = [...now].sort((a, b) => a - b).join(',');
  if (key !== waitingKey) {
    waitingKey = key;
    waitingSet = now;
  }
  return waitingSet;
}

/** Every task waiting on a preview: for the task list's "Preview to approve". */
export function useTasksWaitingOnPreview(): ReadonlySet<number> {
  return useSyncExternalStore(subscribeWaiting, readWaitingTasks, readWaitingTasks);
}

/** Re-runs `load` whenever a preview row changes; undefined until it answers. */
function useStored<T>(load: (() => Promise<T>) | null, deps: readonly unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    setValue(undefined);
    if (load === null) return;
    let live = true;
    const run = () =>
      void load()
        .then((v) => {
          if (live) setValue(v);
        })
        .catch((err: unknown) => console.warn('[previews] could not read previews', err));
    run();
    const off = onPreviewsChanged(run);
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Every stored version of one title on a task, v1 first; undefined while loading. */
export function usePreviewVersions(taskId: number, title: string): readonly Preview[] | undefined {
  return useStored(() => previewVersions(taskId, title), [taskId, title]);
}

/**
 * The version a transcript's call made: undefined while loading, null when
 * none was kept (a session Albedo did not start, or a task's history purged).
 */
export function usePreviewByToolUse(toolUseId: string | null): Preview | null | undefined {
  const v = useStored(toolUseId === null ? null : () => previewByToolUse(toolUseId), [toolUseId]);
  return toolUseId === null ? null : v;
}
