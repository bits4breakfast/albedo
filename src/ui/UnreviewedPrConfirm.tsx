import type { Task } from '../types';
import { gateOf } from '../guide/gate';
import { askCreatePr } from './createPr';
import { useMeasuredBase } from './useMeasuredBase';
import UnreviewedPrDialog from './UnreviewedPrDialog';

/**
 * The confirmation for a task's ⋯ menu (App): into the base the header shows
 * (#237), the gate as it stands, and on confirm the same Create PR as the
 * task bar's, marked as without review.
 */
export default function UnreviewedPrConfirm({ task, onClose }: { task: Task; onClose: () => void }) {
  const base = useMeasuredBase(task).base;
  return (
    <UnreviewedPrDialog
      task={task}
      gate={gateOf(task.id)}
      base={base}
      onConfirm={() => void askCreatePr(task, base, { escape: true })}
      onClose={onClose}
    />
  );
}
