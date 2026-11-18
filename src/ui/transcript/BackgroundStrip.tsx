/**
 * The Background band: what the selected task's session keeps running
 * outside the turn (#122), between the transcript and the composer, beside
 * the Queued band and drawn like it. Absent while nothing runs.
 *
 * One line each: the kind; for what will wake the task, when ("every 30 min
 * · next 14:13", "once · 15:00", a wake-up's "13:58", #443); the
 * description cut to one line (the whole of it in the tooltip); and how long
 * it has run -- or, for what wakes the task, how long until it does. A click
 * takes the transcript to the call that started it.
 *
 * What counts, and why only since the pty was spawned, is
 * `useBackgroundWork`'s (BackgroundWork.tsx). Agents are left to the Agents
 * strip (`backgroundShown`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { BackgroundItem } from '../../capture';
import { formatDuration } from '../../lib/duration';
import { BACKGROUND_KIND_LABEL, runIsNear, scheduleText } from '../BackgroundWork';

/** The clocks' cadence. Nothing is re-queried; only while the band shows. */
const CLOCK_MS = 1_000;

/**
 * "3m 12s" running, or "in 4m 20s" for what wakes the task -- a wake-up, a
 * timer -- while its run is under 12 hours ahead (by distance: a wake-up at
 * 00:10 seen at 23:50 is "in 20m 0s"). A run further off says nothing here:
 * its day and time beside it say it, and "in 67h 3m" would only be noise.
 */
export function backgroundClock(item: BackgroundItem, now: number): string {
  if (item.nextRunAt !== null) return runIsNear(item.nextRunAt, now) ? `in ${formatDuration(item.nextRunAt - now)}` : '';
  if (item.kind === 'wakeup' && item.until !== null) return `in ${formatDuration(item.until - now)}`;
  return formatDuration(now - item.startedAt);
}

export function BackgroundStrip({
  items,
  onReveal,
}: {
  /** What to list, oldest first; the band is absent when empty. */
  items: readonly BackgroundItem[];
  /** Scroll the transcript to the row with this id. */
  onReveal: (rowId: number) => void;
}): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const ticking = items.length > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);

  if (items.length === 0) return null;
  return (
    // A group, not a live region: the clocks change every second.
    <div className="tx-queued tx-background" role="group" aria-label="Running in the background">
      <div className="tx-queued-head">
        Background <span className="tx-queued-count">{items.length}</span>
      </div>
      {items.map((item) => {
        const when = scheduleText(item, now);
        return (
          <button
            key={item.key}
            type="button"
            className="tx-background-item"
            data-when={when === null ? undefined : 'true'}
            title={item.description || undefined}
            onClick={() => onReveal(item.rowId)}
          >
            <span className="tx-background-kind">{BACKGROUND_KIND_LABEL[item.kind]}</span>
            {when !== null && <span className="tx-background-when">{when}</span>}
            <span className="tx-background-desc">{item.description}</span>
            <span className="tx-background-time">{backgroundClock(item, now)}</span>
          </button>
        );
      })}
    </div>
  );
}

export default BackgroundStrip;
