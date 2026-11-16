import { useCallback, useEffect, useState } from 'react';
import type { SetStateAction } from 'react';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';
import type { RightTab } from './useLayout';

/**
 * The reading pane's tab, one per task (#314): each task comes back on the
 * tab it was left on, rather than on whichever tab was chosen last anywhere.
 * A task not looked at yet shows Transcript, where the message box is.
 *
 * Kept across restarts for Transcript, Files and Guide, newest
 * {@link TASK_TABS_MAX} tasks. Editor is held only in memory: no file is open
 * after a restart, and App's derivation turns an Editor with no file for the
 * task back into Transcript anyway.
 *
 * The project view (no task selected) keeps its own tab in useLayout.
 */

export const TASK_TABS_MAX = 100;
const DEFAULT_TAB: RightTab = 'transcript';
const KEPT: readonly RightTab[] = ['transcript', 'files', 'guide'];

/** Oldest first: the order is the recency, so trimming drops the front. */
type TaskTabs = ReadonlyMap<number, RightTab>;

/** Stored as a JSON array of [taskId, tab] pairs, oldest first. */
export const taskTabsCodec: Codec<TaskTabs> = {
  decode: (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out = new Map<number, RightTab>();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, tab] = entry as [unknown, unknown];
      if (typeof id !== 'number' || !Number.isInteger(id)) continue;
      if (typeof tab !== 'string' || !KEPT.includes(tab as RightTab)) continue;
      out.delete(id);
      out.set(id, tab as RightTab);
    }
    return out;
  },
  encode: (tabs) => JSON.stringify([...tabs].filter(([, tab]) => KEPT.includes(tab))),
};

/** `tabs` with `taskId` on `tab`, moved to the newest end and trimmed. Same object when nothing changed. */
export function withTaskTab(tabs: TaskTabs, taskId: number, tab: RightTab, max = TASK_TABS_MAX): TaskTabs {
  if (tabs.get(taskId) === tab) return tabs;
  const next = new Map(tabs);
  next.delete(taskId);
  next.set(taskId, tab);
  for (const id of next.keys()) {
    if (next.size <= max) break;
    next.delete(id);
  }
  return next;
}

export default function useTaskTabs() {
  const [tabs, setTabs] = useState<TaskTabs>(() => readPersisted(KEYS.taskTabs, taskTabsCodec, new Map()));
  useEffect(() => writePersisted(KEYS.taskTabs, taskTabsCodec, tabs), [tabs]);

  const tabFor = useCallback((taskId: number): RightTab => tabs.get(taskId) ?? DEFAULT_TAB, [tabs]);

  /** Stable: callers hold it in callbacks with no dependencies. */
  const setTabFor = useCallback((taskId: number, action: SetStateAction<RightTab>) => {
    setTabs((prev) => {
      const current = prev.get(taskId) ?? DEFAULT_TAB;
      const next = typeof action === 'function' ? action(current) : action;
      return withTaskTab(prev, taskId, next);
    });
  }, []);

  return { tabFor, setTabFor };
}
