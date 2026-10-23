/**
 * The editor's Diff mode: the open file against the task's base.
 *
 * A thin shell. What the two sides are is decided in `src/git/fileDiff.ts`;
 * how a diff looks is decided by the one diff component, `transcript/Diff.tsx`
 * -- same colours, same word-level highlight, same row budget for a huge
 * change, same split/unified switch. A second renderer here would be the first
 * place the two drifted.
 *
 * Both whole files go to the renderer as `expand`, so every collapsed region
 * can be opened: this is a file, not a transcript fragment, and nothing is
 * outside what we hold.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../../types';
import type { ResolvedPath } from '../../lib/paths';
import { loadTaskFileDiff, type ChangeKind, type TaskFileDiff } from '../../git/fileDiff';
import { Diff, DiffAnnotationsContext } from '../transcript/Diff';
import { useDiffComments } from './diffComments';
import { dismissAfterFocusedTime } from '../../lib/focusTimer';
import './diffview.css';

/** The working-tree side: the file on disk, null when it does not exist. */
async function readWorking(absolute: string): Promise<string | null> {
  const fs = await import('@tauri-apps/plugin-fs');
  try {
    return await fs.readTextFile(absolute);
  } catch (err) {
    // Missing is a deletion, which is an answer; unreadable is not.
    if (!(await fs.exists(absolute).catch(() => true))) return null;
    throw err;
  }
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: TaskFileDiff };

export interface FileDiffViewProps {
  task: Task;
  target: ResolvedPath;
  /** Bumped by the editor after a save, so the diff follows the file. */
  reloadKey: number;
  /** True when the editor holds edits that are not on disk yet. */
  unsaved: boolean;
}

export default function FileDiffView({ task, target, reloadKey, unsaved }: FileDiffViewProps): ReactNode {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [again, setAgain] = useState(0);

  // Another file: drop the old diff at once. Declared first, so on a step it
  // runs before the load below and the "keep while refreshing" rule there
  // never sees the previous file's result.
  useEffect(() => {
    setLoad({ kind: 'loading' });
  }, [target.relative]);

  /**
   * A refresh that changes nothing changes nothing on screen either, which
   * reads exactly like a button that does not work -- so it confirms itself.
   */
  const [outcome, setOutcome] = useState<'refreshing' | 'refreshed' | null>(null);
  useEffect(() => {
    if (outcome !== 'refreshed') return;
    // Five seconds of the window having focus: not missed by looking away.
    return dismissAfterFocusedTime(5000, () => setOutcome(null));
  }, [outcome]);

  useEffect(() => {
    let live = true;
    // Keep the previous diff on screen while a refresh of the SAME file runs;
    // a step to another file clears it, so the wrong file never shows.
    setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    void loadTaskFileDiff(task.worktreePath, task.baseBranch, target.relative, () => readWorking(target.absolute))
      .then((data) => {
        if (!live) return;
        setLoad({ kind: 'ready', data });
        setOutcome((o) => (o === 'refreshing' ? 'refreshed' : o));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        setOutcome(null);
      });
    return () => {
      live = false;
    };
  }, [task.worktreePath, task.baseBranch, target.relative, target.absolute, reloadKey, again]);

  const refresh = () => {
    setOutcome('refreshing');
    setAgain((n) => n + 1);
  };

  // Review comments on the new side: only when there is a current file for
  // them to point at (not a deleted file, not a binary).
  const currentText =
    load.kind === 'ready' && 'newText' in load.data.result && load.data.result.change !== 'deleted'
      ? load.data.result.newText
      : null;
  const comments = useDiffComments(task.id, target.relative, currentText, unsaved);

  if (load.kind === 'loading') return <div className="ed-message">Reading the change…</div>;
  if (load.kind === 'error') {
    return (
      <div className="ed-message" data-tone="error">
        Could not build the diff
        <div className="ed-message-sub">{load.message}</div>
        <button type="button" className="ed-btn ed-diff-retry" onClick={() => setAgain((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  const { result, base, fromMergeBase } = load.data;
  const against = fromMergeBase ? `${base.slice(0, 7)}, where this branch left ${task.baseBranch}` : 'HEAD';

  return (
    <div className="ed-diff">
      <div className="ed-diff-meta">
        {'change' in result ? <span className="ed-diff-change" data-change={result.change}>{CHANGE_LABEL[result.change]}</span> : null}
        <span className="ed-diff-against" title={fromMergeBase ? base : 'No merge base with the base branch; uncommitted changes only'}>
          Against {against}
        </span>
        {unsaved ? <span className="ed-diff-unsaved">Unsaved edits are not included</span> : null}
        <button
          type="button"
          className="ed-btn ed-diff-refresh"
          onClick={refresh}
          disabled={outcome === 'refreshing'}
          title="Re-read the file and git"
          aria-live="polite"
        >
          {outcome === 'refreshing' ? 'Refreshing…' : outcome === 'refreshed' ? 'Refreshed' : 'Refresh'}
        </button>
      </div>
      {comments.notice ? (
        <div className="ed-notice" data-tone="warn">
          <span>{comments.notice}</span>
          <button type="button" className="ed-btn" onClick={comments.clearNotice}>
            OK
          </button>
        </div>
      ) : null}
      <div className="ed-diff-scroll">
        <DiffAnnotationsContext.Provider value={comments.annotations}>
          <DiffBody data={load.data} />
        </DiffAnnotationsContext.Provider>
      </div>
    </div>
  );
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  added: 'New on This Branch',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  unchanged: 'No Net Change',
};

function DiffBody({ data }: { data: TaskFileDiff }): ReactNode {
  const { result } = data;
  switch (result.kind) {
    case 'diff':
      if (result.change === 'unchanged') {
        return (
          <div className="ed-message">
            No difference from the base.
            {/* Also every file the branch never touched, opened from the Project
                view: a diff has no lines to comment on, so say where they are. */}
            <div className="ed-message-sub">
              This branch never changed the file, or changed it back. Switch to File to comment on it.
            </div>
          </div>
        );
      }
      return (
        <Diff
          // Keyed by file: opened gaps and the row budget are per diff, and a
          // step to the next file must not inherit the last one's.
          key={result.diff.path}
          diff={result.diff}
          expand={{ oldText: result.oldText, newText: result.newText }}
          absoluteLines={result.change !== 'deleted'}
          contextPath={null}
          // The title bar above already names the file.
          showPath={false}
        />
      );
    case 'binary':
      return <div className="ed-message">Binary file — {CHANGE_LABEL[result.change]}. No text diff to show.</div>;
    case 'too-large':
      return (
        <div className="ed-message">
          Too large to diff here ({(result.bytes / 1_000_000).toFixed(1)} MB).
          <div className="ed-message-sub">Switch to File to read it, or run git diff in the terminal.</div>
        </div>
      );
    case 'not-a-file':
      return <div className="ed-message">This path is a directory or a submodule on one side; there is no file to diff.</div>;
    case 'absent':
      return <div className="ed-message">This file exists neither at the base nor in the worktree.</div>;
  }
}
