/**
 * The header's git unit: `⑂ branch → base`. Its own component so a PR poll or
 * a stack check re-renders this chip, not the shell around it.
 */

import type { ReactNode } from 'react';
import { usePrStatus } from '../gh/prStore';
import type { Task } from '../types';
import { BranchIcon } from './icons';
import { branchTooltip, mergeTarget } from './mergeTarget';
import { useStackBase } from './useMeasuredBase';

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
