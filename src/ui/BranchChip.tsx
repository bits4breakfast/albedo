/**
 * The header's git unit: `⑂ branch → base`. Its own component so a PR poll
 * re-renders this chip, not the shell around it.
 */

import type { ReactNode } from 'react';
import { usePrStatus } from '../gh/prStore';
import type { Task } from '../types';
import { BranchIcon } from './icons';
import { branchTooltip, mergeTarget } from './mergeTarget';

export default function BranchChip({ task }: { task: Task }): ReactNode {
  const pr = usePrStatus(task);
  const target = mergeTarget(task, pr);
  return (
    <span className="main-ident-branch" title={branchTooltip(task.branch, target, pr?.number ?? null)}>
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
        </span>
      ) : null}
    </span>
  );
}
