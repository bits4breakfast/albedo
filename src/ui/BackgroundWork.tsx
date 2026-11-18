/**
 * Work running in the background of a task's session: shells, monitors,
 * wake-ups and timers Claude Code keeps going after a turn ends (#122). The
 * terminal says "1 shell still running"; without this the task reads as
 * Idle and nothing else, so one that will wake itself in four minutes looks
 * finished.
 *
 * Read from the transcript, never from the terminal: the rows say what
 * started and what ended (`runningInBackground`, capture/background.ts).
 * Nothing is written when the claude process ends, and the work ends with
 * it, so only starts written since the task's live pty was spawned count,
 * and nothing counts without one -- as with Remote Control (RemoteMark.tsx).
 *
 * Shown in two places, one per screen: the Background band above the
 * composer for the selected task (transcript/BackgroundStrip.tsx), and on
 * every other Idle or Done row, when the task will next wake itself ("next
 * check 14:13", #443) or else "N in background".
 *
 * Not measured: what `/resume` typed inside a session does to work running
 * in it. Albedo follows the session the task is on, so work started in the
 * session it left is not shown -- nor after `/clear`, which keeps it running
 * (adapter.ts). Missing, not false.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nextChangeAt, onCaptureUpdate, runningInBackground, type BackgroundItem, type BackgroundKind } from '../capture';
import { backgroundRowsSince } from '../db';
import { cronEvery, everyText } from '../lib/cron';
import { clockText, dateText } from '../reminders/when';
import type { Message, Task } from '../types';
import { ClockIcon } from './icons';
import { usePtyLiveSince } from './Terminal';

/** Bursts of capture events for one session are looked up once (as RemoteMark does). */
const COALESCE_MS = 250;

/** What each kind is called, in the band and the row's tooltip. */
export const BACKGROUND_KIND_LABEL: Record<BackgroundKind, string> = {
  shell: 'Shell',
  agent: 'Agent',
  monitor: 'Monitor',
  wakeup: 'Wake-up',
  timer: 'Timer',
};

const NO_ROWS: readonly Message[] = [];
/** The longest delay setTimeout keeps; anything longer fires at once. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * What runs in the background of the task's live session, oldest first.
 * Looked up when the pty or session changes and on each capture burst for
 * that session; re-read, with no lookup, when a wake-up falls due or a
 * monitor times out. Never while there is no live pty.
 */
export function useBackgroundWork(task: Pick<Task, 'id' | 'sessionId'> | null): readonly BackgroundItem[] {
  const taskId = task?.id ?? null;
  const sessionId = task?.sessionId ?? null;
  const liveSince = usePtyLiveSince(taskId);
  const key = taskId === null || sessionId === null || liveSince === null ? null : `${taskId}\n${sessionId}\n${liveSince}`;
  const [found, setFound] = useState<{ key: string; rows: readonly Message[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (key === null || sessionId === null || liveSince === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      backgroundRowsSince(sessionId, liveSince).then(
        (rows) => {
          if (!alive) return;
          setFound({ key, rows });
          setNow(Date.now());
        },
        () => {
          /* unknown, which shows nothing */
        },
      );
    };
    look();
    const off = onCaptureUpdate((u) => {
      if (u?.sessionId !== sessionId) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        look();
      }, COALESCE_MS);
    });
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      off();
    };
    // `key` carries everything the lookup reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rows = key !== null && found?.key === key ? found.rows : NO_ROWS;
  const since = key !== null ? liveSince : null;

  // A deadline passing changes the answer with no new row: re-read the clock
  // then, once, rather than on a tick.
  const next = useMemo(() => nextChangeAt(rows, since, now), [rows, since, now]);
  useEffect(() => {
    if (next === null) return;
    // setTimeout fires at once past 2^31-1 ms (24.8 days): wait at most that.
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, next - Date.now()) + 1, MAX_TIMEOUT_MS));
    return () => clearTimeout(t);
  }, [next]);

  return useMemo(() => runningInBackground(rows, since, now), [rows, since, now]);
}

/**
 * The items worth a line of their own. An agent is not: the Agents strip
 * above the transcript lists each running one with its label and time, and
 * its row already counts it ("·2") and reads Running while it works.
 * Listing it here too would put the same agent on screen twice.
 */
export function backgroundShown(items: readonly BackgroundItem[]): BackgroundItem[] {
  return items.filter((i) => i.kind !== 'agent');
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_MS = 60 * 60_000;
/** Under this far ahead, a run is read by its time alone, and the band counts down to it. */
const NEAR_MS = 12 * HOUR_MS;

/**
 * Whether a run is near enough to need no day: under 12 hours ahead. By
 * distance, not by calendar day, so 00:10 seen at 23:50 is "00:10", "in 20m".
 */
export function runIsNear(at: number, now: number): boolean {
  return at - now < NEAR_MS;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * A run's time, local and 24-hour (`clockText`): "14:13" later today or
 * under 12 hours ahead (00:10 seen at 23:50), "Mon 09:00" under 6 days,
 * "Oct 28 09:00" past that.
 */
export function runTimeText(at: number, now: number): string {
  if (runIsNear(at, now) || sameDay(at, now)) return clockText(at);
  if (at - now < 6 * 24 * HOUR_MS) return `${DAY_NAMES[new Date(at).getDay()]} ${clockText(at)}`;
  return `${dateText(at, new Date(now))} ${clockText(at)}`;
}

/**
 * When an item wakes the task, as the band says it beside its kind: "every
 * 30 min · next 14:13", "next 17:00" (runs not evenly spaced), "once ·
 * 15:00", or a wake-up's "13:58". Null when it does not wake the task, or
 * when is not known.
 */
export function scheduleText(item: BackgroundItem, now: number): string | null {
  if (item.nextRunAt === null) return null;
  const at = runTimeText(item.nextRunAt, now);
  if (item.kind === 'wakeup') return at;
  if (item.kind !== 'timer') return null;
  if (item.schedule?.once) return `once · ${at}`;
  const every = item.schedule?.cron ? cronEvery(item.schedule.cron) : null;
  return every === null ? `next ${at}` : `${everyText(every)} · next ${at}`;
}

/**
 * The row's words for when the task next wakes itself: "next check 14:13" (a
 * recurring timer), "check at 15:00" (a one-shot), "wakes 13:58" (a
 * wake-up). Null for an item that does not wake it.
 */
export function wakeText(item: BackgroundItem, now: number): string | null {
  if (item.nextRunAt === null) return null;
  const at = runTimeText(item.nextRunAt, now);
  if (item.kind === 'wakeup') return `wakes ${at}`;
  if (item.kind !== 'timer') return null;
  return item.schedule?.once ? `check at ${at}` : `next check ${at}`;
}

/** The item that wakes the task soonest, or null when none will. */
export function soonestWake(items: readonly BackgroundItem[]): BackgroundItem | null {
  let best: BackgroundItem | null = null;
  for (const i of items) {
    if (i.nextRunAt === null || (i.kind !== 'timer' && i.kind !== 'wakeup')) continue;
    if (best === null || i.nextRunAt < best.nextRunAt!) best = i;
  }
  return best;
}

/**
 * One per line, for a tooltip: "Shell: Poll CI until green", and with its
 * time for what wakes the task, "Timer (every 30 min · next 14:13): Check
 * the error rate".
 */
export function backgroundSummary(items: readonly BackgroundItem[], now: number): string {
  return items
    .map((i) => {
      const when = scheduleText(i, now);
      const head = when === null ? BACKGROUND_KIND_LABEL[i.kind] : `${BACKGROUND_KIND_LABEL[i.kind]} (${when})`;
      return i.description ? `${head}: ${i.description}` : head;
    })
    .join('\n');
}

/**
 * In an Idle or Done row's caption, so a task that will wake itself does not
 * read as finished: when it next does, with a clock ("next check 14:13",
 * "check at 15:00", "wakes 13:58"; the soonest, when several will), or else
 * "2 in background". A clock time, not a countdown: it stays true as you
 * read it, with no ticking row. Nothing while nothing runs. The list puts it
 * only on rows that are not selected: the selected task's band says the
 * same, with more.
 */
export function BackgroundMark({ task }: { task: Pick<Task, 'id' | 'sessionId'> }): ReactNode {
  const shown = backgroundShown(useBackgroundWork(task));
  if (shown.length === 0) return null;
  const now = Date.now();
  const title = `Running in the background:\n${backgroundSummary(shown, now)}`;
  const soonest = soonestWake(shown);
  const wake = soonest === null ? null : wakeText(soonest, now);
  if (wake !== null) {
    return (
      <span className="task-background" data-wake="true" title={title}>
        <ClockIcon size={12} />
        {wake}
      </span>
    );
  }
  return (
    <span className="task-background" title={title}>
      {shown.length} in background
    </span>
  );
}
