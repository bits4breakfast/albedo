/**
 * Keep the Mac awake while tasks run (#283).
 *
 * When the Mac sleeps idle, every `claude` session stops mid-work; when
 * Albedo's window is hidden, App Nap delays its timers (the "waiting on you"
 * alert, the CI and PR checks). So while work is going on, Albedo holds one
 * user-initiated process activity (`set_keep_awake`, src-tauri/src/keep_awake.rs):
 * no idle system sleep, no App Nap. The display may still sleep, and closing
 * a laptop's lid still sleeps it -- no app prevents that, and the owner does
 * not want it prevented. When nothing runs the activity is ended, and macOS
 * naps and sleeps as usual.
 *
 * What counts, per task (`keepAwakeState`, pure):
 *  - its status is Running;
 *  - or it has background work by `runningInBackground` (capture/background.ts,
 *    #122), which counts only for a live terminal: a shell, an agent or a
 *    monitor until it ends (a monitor at its timeout), a wake-up until it is
 *    due, so it can fire.
 *  - A recurring timer (CronCreate) does not. It can last 7 days and the Mac
 *    would never sleep; the session wakes for it only while something else
 *    keeps the Mac awake.
 *
 * Re-read when the tasks change, when a live session's rows land, and at the
 * next deadline (`nextAt`) -- never on a tick, and never while switched off.
 * Released when the count drops to 0, when the switch is turned off, on
 * unmount, and in Rust on exit; the OS drops it with the process on a crash.
 *
 * The switch: "Keep the Mac Awake While Tasks Run" in ⋯, on by default,
 * remembered in localStorage like the other ⋯ preferences (persisted.ts).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { onCaptureUpdate, runningInBackground } from '../capture';
import type { BackgroundItem } from '../capture/background';
import { backgroundRowsSince } from '../db';
import type { Message, Task, TaskStatus } from '../types';
import { KEYS, persistedSwitch, usePersistedSwitch } from './persisted';
import { onPtyPresenceChange, ptyLiveSince } from './Terminal';

// --- what counts (pure) -------------------------------------------------------

type Row = Parameters<typeof runningInBackground>[0][number];

export interface AwakeTask {
  status: TaskStatus;
  /** The live session's background rows (`backgroundRowsSince`); empty when unknown. */
  rows: readonly Row[];
  /** When its live pty was spawned; null with none, and then no background work counts. */
  since: number | null;
}

export interface AwakeState {
  /** Tasks running, or with background work that keeps the Mac awake. */
  count: number;
  /** When the count can next change with no new row or status: the earliest deadline ahead. */
  nextAt: number | null;
}

/** The background work that keeps the Mac awake: everything but a recurring timer. */
export function keepsAwake(item: BackgroundItem): boolean {
  return item.kind !== 'timer';
}

export function keepAwakeState(tasks: readonly AwakeTask[], now: number): AwakeState {
  let count = 0;
  let nextAt: number | null = null;
  for (const t of tasks) {
    if (t.status === 'archived') continue;
    const work = runningInBackground(t.rows, t.since, now).filter(keepsAwake);
    if (t.status === 'running' || work.length > 0) count += 1;
    // A running task is counted whatever its deadlines say, but one may end
    // its turn before them, so they are still watched.
    for (const i of work) {
      if (i.until !== null && i.until > now && (nextAt === null || i.until < nextAt)) nextAt = i.until;
    }
  }
  return { count, nextAt };
}

/** The activity's reason, as `pmset -g assertions` lists it. */
export function keepAwakeReason(count: number): string {
  return `${count} Claude Code ${count === 1 ? 'task' : 'tasks'} running`;
}

// --- the switch ---------------------------------------------------------------

const keepAwakeSwitch = persistedSwitch(KEYS.keepAwake);

/** "Keep the Mac Awake While Tasks Run". Never throws: no storage reads as "on". */
export const keepAwakeEnabled = keepAwakeSwitch.get;

export const setKeepAwakeEnabled = keepAwakeSwitch.set;

/** The setting, for the menu that shows it and the hook that obeys it. */
export function useKeepAwakeEnabled(): [boolean, (on: boolean) => void] {
  return usePersistedSwitch(keepAwakeSwitch);
}

// --- the hook -----------------------------------------------------------------

/** Bursts of capture events for one session are looked up once. Nothing here is drawn per row. */
const COALESCE_MS = 1_000;

const NO_ROWS: readonly Message[] = [];

/** Switched off: nothing counts, and no deadline is watched. */
const OFF: AwakeState = { count: 0, nextAt: null };

/** Tasks whose background work can count: a live pty and a session. */
function liveKeys(tasks: readonly Task[]): string {
  return tasks
    .filter((t) => t.status !== 'archived' && t.sessionId !== null)
    .map((t) => {
      const since = ptyLiveSince(t.id);
      return since === null ? null : `${t.id}\t${t.sessionId}\t${since}`;
    })
    .filter((k): k is string => k !== null)
    .join('\n');
}

/**
 * Holds the activity while `enabled` and anything counts, and returns the
 * count while it is held (0 otherwise), for the status strip's note.
 * `set_keep_awake` is called only when holding starts, stops, or its reason
 * changes.
 */
export function useKeepAwake(tasks: readonly Task[], enabled: boolean): number {
  // Which tasks have a live pty, re-read when one comes or goes. None while
  // switched off (#364): nothing is held then, so nothing is looked up.
  const [presence, setPresence] = useState(0);
  useEffect(() => onPtyPresenceChange(() => setPresence((n) => n + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const live = useMemo(() => (enabled ? liveKeys(tasks) : ''), [tasks, presence, enabled]);

  const [rows, setRows] = useState<ReadonlyMap<string, readonly Message[]>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (live === '') {
      setRows(new Map());
      return;
    }
    const entries = live.split('\n').map((k) => {
      const [, sessionId, since] = k.split('\t');
      return { key: k, sessionId: sessionId!, since: Number(since) };
    });
    let alive = true;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const look = (e: (typeof entries)[number]) => {
      backgroundRowsSince(e.sessionId, e.since).then(
        (found) => {
          if (!alive) return;
          setRows((prev) => {
            const next = new Map(prev);
            next.set(e.key, found);
            for (const k of next.keys()) if (!entries.some((x) => x.key === k)) next.delete(k);
            return next;
          });
          setNow(Date.now());
        },
        (err) => console.warn('[keep-awake] background lookup failed', err),
      );
    };
    for (const e of entries) look(e);
    const off = onCaptureUpdate((u) => {
      for (const e of entries) {
        if (u?.sessionId !== e.sessionId || timers.has(e.key)) continue;
        timers.set(
          e.key,
          setTimeout(() => {
            timers.delete(e.key);
            look(e);
          }, COALESCE_MS),
        );
      }
    });
    return () => {
      alive = false;
      for (const t of timers.values()) clearTimeout(t);
      off();
    };
  }, [live]);

  const state = useMemo((): AwakeState => {
    if (!enabled) return OFF;
    const byTask = new Map<number, { key: string; since: number }>();
    for (const k of live === '' ? [] : live.split('\n')) {
      const [id, , since] = k.split('\t');
      byTask.set(Number(id), { key: k, since: Number(since) });
    }
    return keepAwakeState(
      tasks.map((t) => {
        const l = byTask.get(t.id);
        return { status: t.status, rows: (l && rows.get(l.key)) ?? NO_ROWS, since: l?.since ?? null };
      }),
      now,
    );
  }, [enabled, tasks, live, rows, now]);

  // A deadline passing changes the answer with no new row: re-read the clock
  // then, once.
  useEffect(() => {
    if (state.nextAt === null) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, state.nextAt - Date.now()) + 1);
    return () => clearTimeout(t);
  }, [state.nextAt]);

  const hold = enabled && state.count > 0;
  const reason = hold ? keepAwakeReason(state.count) : '';
  // What Rust was last told: the reason held, '' for nothing. Called only on
  // a change, so a re-render or a re-read with the same answer costs nothing.
  const sent = useRef('');
  useEffect(() => {
    if (reason === sent.current) return;
    sent.current = reason;
    callKeepAwake(reason !== '', reason);
  }, [reason]);
  // Released when the app's tree goes (a reload, HMR); Rust releases on exit.
  useEffect(
    () => () => {
      if (sent.current === '') return;
      sent.current = '';
      callKeepAwake(false, '');
    },
    [],
  );

  return hold ? state.count : 0;
}

function callKeepAwake(on: boolean, reason: string): void {
  invoke('set_keep_awake', { on, reason }).catch((err: unknown) => {
    // Outside Tauri (the browser preview) there is nothing to hold; in the app
    // a failure is worth seeing.
    console.warn('[keep-awake] set_keep_awake failed', err);
  });
}
