import { GROUP_HUE, GROUP_PIE, type GroupKey } from './taskGroups';

/**
 * A task group's icon (#278): a ring in the group's edge colour, with a pie
 * inside that fills as work moves along (Running a quarter, Approved almost
 * full). Needs You is a solid dot, Done a solid dot with a check, Idle the
 * empty ring, Archived a thin one, Stopped on an Error a heavier empty one
 * (2px, r 5), so it is told from Idle by more than its colour (#338). Drawn
 * on the group headers, and in the rail's popover, never on a task row.
 * Decorative: the group's name is next to it, so it is hidden from
 * assistive tech.
 *
 * Inline SVG on a 12px grid: a 1.5px ring (r 5.25), a 1.5px gap, and a pie
 * of radius 3 starting at twelve o'clock, clockwise.
 */
export default function GroupPie({ group }: { group: GroupKey }) {
  const shape = GROUP_PIE[group];
  return (
    <svg
      className="group-pie"
      data-hue={GROUP_HUE[group]}
      data-pie={typeof shape === 'number' ? String(Math.round(shape * 8)) : shape}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      {shape === 'full' || shape === 'check' ? (
        <circle cx="6" cy="6" r="6" fill="currentColor" />
      ) : (
        <circle
          cx="6"
          cy="6"
          r={shape === 'thin' ? 5.5 : shape === 'ring' ? 5 : 5.25}
          fill="none"
          stroke="currentColor"
          strokeWidth={shape === 'thin' ? 1 : shape === 'ring' ? 2 : 1.5}
        />
      )}
      {shape === 'check' && (
        <path
          className="group-pie-check"
          d="M3.6 6.2 5.3 7.8 8.4 4.4"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {typeof shape === 'number' && shape > 0 && <path d={wedge(shape)} fill="currentColor" />}
    </svg>
  );
}

/** A pie of radius 3 about (6, 6), from twelve o'clock clockwise. Exported for tests. */
export function wedge(fraction: number): string {
  const r = 3;
  if (fraction >= 1) return 'M6 3a3 3 0 1 1 0 6a3 3 0 1 1 0-6Z';
  const a = fraction * 2 * Math.PI;
  const x = +(6 + r * Math.sin(a)).toFixed(3);
  const y = +(6 - r * Math.cos(a)).toFixed(3);
  return `M6 6L6 3A3 3 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y}Z`;
}
