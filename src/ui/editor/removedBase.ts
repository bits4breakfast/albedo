/**
 * The base a comment on removed lines points at (#402), where no diff is on
 * screen to hand it over: the editor's File mode, and the Files pane's list
 * of comments. Read as the Diff mode reads its old side -- the task's merge
 * base with the measured base (`useMeasuredBase`), renames followed -- once
 * per file and base, and only when the file has such a comment: every other
 * file reads nothing, and its task asks nothing about its base.
 *
 * `settled` is the measured base's: until gh has answered for the PR, the
 * base may still move to the PR's. A read made before then places a comment
 * but never moves or resolves one.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../../types';
import { readTaskBaseText } from '../../git/fileDiff';
import { useMeasuredBase } from '../useMeasuredBase';

/** The file's text at the task's merge base with `base`; null without one, or when it cannot be read. */
export async function baseTextOf(worktreePath: string, base: string, path: string): Promise<string | null> {
  if (base === '') return null;
  try {
    return await readTaskBaseText(worktreePath, base, path);
  } catch (err) {
    console.warn('[comments] could not read the base of', path, err);
    return null;
  }
}

export interface BaseRead {
  /** The base's text, or null: no merge base, or unreadable. Decides nothing then. */
  text: string | null;
  /** The measured base was final when read: a move or a resolve may follow from it. */
  settled: boolean;
}

/** The measured base, asked for only while `needed`: a task with no removed comment asks nothing. */
export function useRemovedBase(task: Task, needed: boolean): { base: string; settled: boolean } {
  const m = useMeasuredBase(needed ? task : null);
  return { base: needed ? m.base : '', settled: needed && m.settled };
}

/**
 * The file at the task's base, for `path`, while `needed`: undefined until
 * read (and whenever not needed). Read again when the measured base, the
 * file or `again` changes.
 */
export function useBaseText(task: Task, path: string | null, needed: boolean, again: unknown = null): BaseRead | undefined {
  const { base, settled } = useRemovedBase(task, needed);
  const [read, setRead] = useState<{ key: string; read: BaseRead } | null>(null);
  const key = `${task.id}\n${task.worktreePath}\n${base}\n${settled}\n${path ?? ''}`;
  useEffect(() => {
    if (!needed || path === null) return;
    let live = true;
    void baseTextOf(task.worktreePath, base, path).then((text) => {
      if (live) setRead({ key, read: { text, settled } });
    });
    return () => {
      live = false;
    };
    // The key carries everything the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needed, again]);
  return needed && read?.key === key ? read.read : undefined;
}
