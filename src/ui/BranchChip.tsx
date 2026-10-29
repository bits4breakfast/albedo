/**
 * The header's git unit: `⑂ branch → base`. Its own component so a PR poll or
 * a stack check re-renders this chip, not the shell around it.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { usePrStatus } from '../gh/prStore';
import { detectStackBase, type StackBase } from '../git/stackBase';
import type { Task } from '../types';
import { BranchIcon } from './icons';
import { branchTooltip, mergeTarget } from './mergeTarget';

/** Same cadence as the PR poll and the branch sync. */
const STACK_POLL_MS = 60_000;

/**
 * What git shows the task's branch stacked on, when that is not its stored
 * base. Checked on selection, on window focus, and every minute while the
 * window is visible: a restack happens in the terminal, unannounced.
 */
function useStackBase(task: Task): StackBase | null {
  const key = `${task.id}\n${task.worktreePath}\n${task.branch}\n${task.baseBranch}`;
  const [found, setFound] = useState<{ key: string; value: StackBase | null } | null>(null);
  const checks = task.kind !== 'chat' && task.status !== 'archived' && task.branch !== '';
  useEffect(() => {
    if (!checks) return;
    let live = true;
    const run = () => {
      if (document.hidden) return;
      void detectStackBase(task.worktreePath, task.branch, task.baseBranch).then((value) => {
        if (live) setFound({ key, value });
      });
    };
    run();
    const timer = window.setInterval(run, STACK_POLL_MS);
    window.addEventListener('focus', run);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
    };
    // `key` carries everything the check reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, checks]);
  return found?.key === key ? found.value : null;
}

export default function BranchChip({ task }: { task: Task }): ReactNode {
  const pr = usePrStatus(task);
  const stack = useStackBase(task);
  const target = mergeTarget(task, pr, stack);
  return (
    <span className="main-ident-branch" title={branchTooltip(task.branch, target, pr?.number ?? null, task.baseBranch)}>
      <BranchIcon />
      <span className="main-ident-text">{task.branch}</span>
      {target ? (
        <span className="main-ident-base">
          <span className="main-ident-arrow" aria-hidden="true">
            →
          </span>
          {/* The arrow is drawn, not read: a screen reader hears "into". */}
          <span className="sr-only">into </span>
          <span className="main-ident-text">{target.base}</span>
          {target.from === 'older' ? <span className="main-ident-stale">needs rebase</span> : null}
        </span>
      ) : null}
    </span>
  );
}
