import type { TaskStatus } from '../types';

const LABEL: Record<TaskStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  blocked: 'Needs you',
  done: 'Done',
  archived: 'Archived',
};

export function statusLabel(status: TaskStatus): string {
  return LABEL[status] ?? status;
}

export interface StatusDotProps {
  status: TaskStatus;
  /** Render the word next to the dot. */
  withLabel?: boolean;
  title?: string;
}

/**
 * The one piece of motion in the app. `running` breathes, `blocked` pings —
 * everything else is still, so a blocked session is the only thing that pulls
 * the eye across a 3-pane layout.
 */
export default function StatusDot({ status, withLabel = false, title }: StatusDotProps) {
  const label = statusLabel(status);
  if (!withLabel) {
    return <span className="status-dot" data-status={status} title={title ?? label} role="img" aria-label={label} />;
  }
  return (
    <span className="status-dot-row" title={title ?? label}>
      <span className="status-dot" data-status={status} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
