/**
 * The Files pane's view per task (#335): the branch's changes, or every file
 * as a tree. A task opens on Changes the first time; after that it comes
 * back to the view it was left on. The Files tab and the pinned Files column
 * read and write the same value, so switching between them never changes it.
 *
 * Held for the app's run only: after a restart every task opens on Changes.
 */

import { useCallback, useSyncExternalStore } from 'react';

export type FilesView = 'changes' | 'project';

const views = new Map<number, FilesView>();
const listeners = new Set<() => void>();

export function filesViewFor(taskId: number): FilesView {
  return views.get(taskId) ?? 'changes';
}

export function setFilesViewFor(taskId: number, view: FilesView): void {
  if (filesViewFor(taskId) === view) return;
  views.set(taskId, view);
  for (const l of [...listeners]) l();
}

/** For tests. */
export function resetFilesViews(): void {
  views.clear();
  for (const l of [...listeners]) l();
}

export function useFilesView(taskId: number): [FilesView, (view: FilesView) => void] {
  const view = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => filesViewFor(taskId),
  );
  const set = useCallback((v: FilesView) => setFilesViewFor(taskId, v), [taskId]);
  return [view, set];
}
