/**
 * The Files pane of the project view (#181): the main checkout's tree, and
 * nothing that acts on it.
 *
 * A task's Files pane (TouchedFiles) is a change set with git actions on it --
 * Push, Create PR, squash, "ask Claude" -- every one of which writes or needs a
 * session. The main checkout has neither a task nor a session, so this is the
 * same ProjectTree with the same status letters and the same opener, and none
 * of the rest. Files open through the app's opener, which opens them for the
 * browse stand-in (App.tsx `browseTask`), read-only.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../types';
import { uncommittedChanges } from '../git/worktree';
import ProjectTree from './ProjectTree';
import { statusTone } from './TouchedFiles';
import { useOpenFile, type OpenFileOptions } from './editor/openFile';
import './touched.css';

export interface ProjectFilesProps {
  /** The browse stand-in: its worktreePath is the main checkout. */
  task: Task;
  /** The file in the editor's active tab, checkout-relative: its row is marked. */
  activePath?: string | null;
}

export default function ProjectFiles({ task, activePath = null }: ProjectFilesProps): ReactNode {
  const [status, setStatus] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const openFile = useOpenFile();

  // `git status`, for the same letters a task's tree shows. A nicety: a
  // failure leaves the tree without them rather than failing it.
  useEffect(() => {
    let live = true;
    void uncommittedChanges(task.worktreePath)
      .then((r) => {
        if (live) setStatus(new Map(r.entries.map((e) => [e.path, `${e.x}${e.y}`])));
      })
      .catch(() => {
        if (live) setStatus(new Map());
      });
    return () => {
      live = false;
    };
  }, [task.worktreePath, reloadKey]);

  // Changes here are made outside Albedo, so coming back to it is when to
  // look again -- the rule the task's Files pane follows.
  useEffect(() => {
    const onFocus = () => setReloadKey((k) => k + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const onOpen = useCallback((path: string, options?: OpenFileOptions) => openFile({ path }, options), [openFile]);

  return (
    /* A stop of the Tab cycle (focusAreas.ts), as the task's Files pane is. */
    <div className="tf-pane" data-focus-area="files">
      <div className="tf-scroll">
        <ProjectTree
          taskId={task.id}
          worktreePath={task.worktreePath}
          status={status}
          toneOf={statusTone}
          activePath={activePath}
          reloadKey={reloadKey}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}
