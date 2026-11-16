/**
 * The base a comment on removed lines points at (#402), where no diff is on
 * screen to hand it over: the editor's File mode, and the Files pane's list
 * of comments. Read as the Diff mode reads its old side (the task's merge
 * base with `measuredBase`'s branch, renames followed), once per file and
 * only when the file has such a comment: every other file reads nothing.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../../types';
import { readTaskBaseText } from '../../git/fileDiff';
import { reviewBase, type ReviewTask } from '../reviewDrafts';

/** The file's text at the task's base; null when it has none there or it cannot be read. */
export async function baseTextOf(task: ReviewTask, path: string): Promise<string | null> {
  try {
    return await readTaskBaseText(task.worktreePath, await reviewBase(task), path);
  } catch (err) {
    console.warn('[comments] could not read the base of', path, err);
    return null;
  }
}

/**
 * {@link baseTextOf} for `path` while `needed`: undefined until read (and
 * whenever not needed), then the text or null. Read again when `again`
 * changes.
 */
export function useBaseText(
  task: Pick<Task, 'id' | 'reviewUrl' | 'worktreePath' | 'baseBranch' | 'kind' | 'branch'>,
  path: string | null,
  needed: boolean,
  again: unknown = null,
): string | null | undefined {
  const [read, setRead] = useState<{ key: string; text: string | null } | null>(null);
  const key = `${task.id}\n${task.worktreePath}\n${task.baseBranch}\n${path ?? ''}`;
  useEffect(() => {
    if (!needed || path === null) return;
    let live = true;
    void baseTextOf(task, path).then((text) => {
      if (live) setRead({ key, text });
    });
    return () => {
      live = false;
    };
    // The key carries everything the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needed, again]);
  return needed && read?.key === key ? read.text : undefined;
}
