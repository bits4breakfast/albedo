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
 * composer for the selected task (transcript/BackgroundStrip.tsx), and "N in
 * background" on every other idle row.
 *
 * Not measured: what `/resume` typed inside a session does to work running
 * in it. Albedo follows the session the task is on, so work started in the
 * session it left is not shown -- nor after `/clear`, which keeps it running
 * (adapter.ts). Missing, not false.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nextChangeAt, onCaptureUpdate, runningInBackground, type BackgroundItem, type BackgroundKind } from '../capture';
import { backgroundRowsSince } from '../db';
import type { Message, Task } from '../types';
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
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
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

/** "Shell: Poll CI until green", one per line, for a tooltip. */
export function backgroundSummary(items: readonly BackgroundItem[]): string {
  return items.map((i) => (i.description ? `${BACKGROUND_KIND_LABEL[i.kind]}: ${i.description}` : BACKGROUND_KIND_LABEL[i.kind])).join('\n');
}

/**
 * "2 in background" in an idle row's caption, so a task that will wake
 * itself does not read as finished. Nothing while nothing runs. The list
 * puts it only on rows that are not selected: the selected task's band says
 * the same, with more.
 */
export function BackgroundMark({ task }: { task: Pick<Task, 'id' | 'sessionId'> }): ReactNode {
  const shown = backgroundShown(useBackgroundWork(task));
  if (shown.length === 0) return null;
  return (
    <span className="task-background" title={`Running in the background:\n${backgroundSummary(shown)}`}>
      {shown.length} in background
    </span>
  );
}
