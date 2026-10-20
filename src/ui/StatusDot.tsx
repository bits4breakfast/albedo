import type { TaskStatus } from '../types';

const LABEL: Record<TaskStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  blocked: 'Needs You',
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

// ---------------------------------------------------------------------------
// Context-window indicators
//
// A session near the end of its context window is about to compact, and will
// get slower and worse afterwards. With several sessions running the useful
// question is the same one the status dots answer: *which* one.
//
// These must not compete with the status dots for attention. The motion budget
// is unchanged -- `running` breathes, `blocked` pings, and nothing here moves
// at all. Below the warn threshold the meter is drawn at roughly the contrast
// of the row border: legible when looked at, invisible when not.
// ---------------------------------------------------------------------------

import type { ContextUsage } from '../capture';

export type ContextLevel = 'quiet' | 'warn' | 'high';

/** Past this the session is worth noticing. */
export const CONTEXT_WARN = 0.7;
/** Past this compaction is imminent. */
export const CONTEXT_HIGH = 0.9;

export function contextLevel(fraction: number): ContextLevel {
  if (!Number.isFinite(fraction)) return 'quiet';
  if (fraction >= CONTEXT_HIGH) return 'high';
  if (fraction >= CONTEXT_WARN) return 'warn';
  return 'quiet';
}

export function formatContextTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * What we are willing to *assert*.
 *
 * The transcript does not record the model's context limit, so when
 * `limitBasis` is `inferred` the denominator is a guess from the session's
 * observed peak — and a percentage computed from a guessed denominator is a
 * guess wearing a measurement's clothes. The token count, on the other hand,
 * is always exactly true. So: a hard percentage only when the limit is known,
 * and the raw count (marked with `~`) when it is not.
 */
export function contextReadout(usage: ContextUsage): string {
  if (usage.limitBasis === 'known' && usage.limit > 0) {
    return `${Math.round(usage.fraction * 100)}%`;
  }
  return `~${formatContextTokens(usage.used)}`;
}

export function contextTitle(usage: ContextUsage): string {
  const used = formatContextTokens(usage.used);
  const model = usage.model || 'unknown model';
  if (usage.limitBasis === 'known' && usage.limit > 0) {
    return (
      `Context: ${used} of ${formatContextTokens(usage.limit)} tokens ` +
      `(${Math.round(usage.fraction * 100)}%) — ${model}`
    );
  }
  return (
    `Context: ${used} tokens used — ${model}.\n` +
    'The transcript does not record this model’s context limit, so the ' +
    'window size is inferred from this session’s observed peak. The token ' +
    'count is exact; the fill level is an estimate, not a measurement.'
  );
}

export interface ContextMeterProps {
  usage: ContextUsage | null | undefined;
  /** `hairline` sits along the bottom edge of a task row. */
  variant?: 'hairline' | 'inline';
}

export function ContextMeter({ usage, variant = 'inline' }: ContextMeterProps) {
  if (!usage || !Number.isFinite(usage.fraction)) return null;
  const level = contextLevel(usage.fraction);
  const pct = Math.max(0, Math.min(100, usage.fraction * 100));
  const title = contextTitle(usage);

  if (variant === 'hairline') {
    return (
      <span className="task-ctx" data-level={level} data-basis={usage.limitBasis} title={title}>
        <span className="task-ctx-fill" style={{ width: `${pct.toFixed(1)}%` }} />
      </span>
    );
  }

  return (
    <span className="ctx" data-level={level} data-basis={usage.limitBasis} title={title}>
      <span className="ctx-bar" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${pct.toFixed(1)}%` }} />
      </span>
      <span className="ctx-text">{contextReadout(usage)}</span>
    </span>
  );
}
