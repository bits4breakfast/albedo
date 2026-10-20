import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Task } from '../../types';
import { KEYS, numberListCodec, readPersisted, writePersisted, type Codec } from '../persisted';
import { readHiddenProjectIds } from '../projectPrefs';
import { buildTabs, orderProjects } from './ProjectTabs';

/** The active project tab's key; empty reads as none. */
const tabKeyCodec: Codec<string> = {
  decode: (raw) => raw || null,
  encode: (key) => key,
};

/**
 * The project tab bar's state: order, closed tabs, the active one. See
 * ProjectTabs.tsx for why the bar exists at all and what it must never hide.
 */
export default function useProjectTabs(projects: Project[], tasks: Task[]) {
  const [activeProjectTabKey, setActiveProjectTabKey] = useState<string>(() =>
    readPersisted(KEYS.activeProject, tabKeyCodec, ''),
  );
  /**
   * Closed project tabs. VIEW STATE, not a lifecycle change: the project, its
   * tasks and its worktrees are untouched, exactly like closing a browser tab.
   * Deliberately not conflated with archiving, which touches worktrees and asks
   * for confirmation — this one is only "not right now".
   */
  const [hiddenProjectIds, setHiddenProjectIds] = useState<Set<number>>(
    () => new Set(readHiddenProjectIds()),
  );
  const selectTabRef = useRef<((key: string) => void) | null>(null);

  /** Tab order as the user dragged it. View state, like hiding: ids only. */
  const [projectOrder, setProjectOrder] = useState<number[]>(() =>
    readPersisted(KEYS.projectOrder, numberListCodec, []),
  );
  const allTabs = useMemo(
    () => buildTabs(orderProjects(projects, projectOrder), tasks),
    [projects, projectOrder, tasks],
  );

  /**
   * Hidden projects keep their slot: the dragged ids are the visible ones, so
   * they are written back into the full order around the hidden ones rather
   * than replacing it.
   */
  const reorderProjects = useCallback(
    (visibleIds: number[]) => {
      const full = orderProjects(projects, projectOrder).map((p) => p.id);
      const moved = new Set(visibleIds);
      const queue = [...visibleIds];
      const next = full.map((id) => (moved.has(id) ? queue.shift()! : id));
      setProjectOrder(next);
      writePersisted(KEYS.projectOrder, numberListCodec, next);
    },
    [projects, projectOrder],
  );

  /**
   * A closed tab must never swallow the one signal this app exists to deliver.
   *
   * Chosen over refusing to close a blocked project: blocked is a state a task
   * enters LATER, so a check at close time would not cover the case that
   * matters — closing a quiet project that goes blocked an hour afterwards. It
   * also makes the refusal explicable only at the moment it happens, whereas a
   * tab reappearing with a pinging dot explains itself. The hide is dropped
   * rather than merely overridden, so what is stored matches what is shown.
   */
  useEffect(() => {
    if (hiddenProjectIds.size === 0) return;
    const blocked = new Set(
      tasks.filter((t) => t.status === 'blocked' && t.projectId !== null).map((t) => t.projectId),
    );
    const revive = [...hiddenProjectIds].filter((id) => blocked.has(id));
    if (revive.length === 0) return;
    setHiddenProjectIds((prev) => {
      const next = new Set(prev);
      for (const id of revive) next.delete(id);
      writePersisted(KEYS.hiddenProjects, numberListCodec, [...next]);
      return next;
    });
  }, [tasks, hiddenProjectIds]);

  const tabs = useMemo(
    () => allTabs.filter((t) => t.project === null || !hiddenProjectIds.has(t.project.id)),
    [allTabs, hiddenProjectIds],
  );

  const hiddenProjects = useMemo(
    () => projects.filter((p) => hiddenProjectIds.has(p.id)),
    [projects, hiddenProjectIds],
  );

  const hideProject = useCallback((projectId: number) => {
    const key = `p${projectId}`;
    // Closing the active tab lands on a neighbour, the way a browser does --
    // next if there is one, otherwise previous. Falling back to "first tab"
    // would jump the user across the bar for no reason.
    if (activeProjectTabKey === key) {
      const i = tabs.findIndex((t) => t.key === key);
      const neighbour = tabs[i + 1] ?? tabs[i - 1] ?? null;
      if (neighbour) selectTabRef.current?.(neighbour.key);
    }
    setHiddenProjectIds((prev) => {
      const next = new Set(prev);
      next.add(projectId);
      writePersisted(KEYS.hiddenProjects, numberListCodec, [...next]);
      return next;
    });
  }, [tabs, activeProjectTabKey]);

  const restoreProject = useCallback(
    (projectId: number) => {
      setHiddenProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        writePersisted(KEYS.hiddenProjects, numberListCodec, [...next]);
        return next;
      });
      selectTabRef.current?.(`p${projectId}`);
    },
    [],
  );

  /**
   * One tab is not a tab bar. With a single project the app is exactly what it
   * was before projects existed: no bar, nothing hidden, nothing to switch.
   */
  /**
   * `|| hiddenProjects.length > 0` is what stops closing being a one-way door:
   * hide one of two projects and the bar would otherwise vanish, taking the
   * only route back with it.
   */
  const showTabs = tabs.length >= 2 || hiddenProjects.length > 0;

  const activeProjectTab = useMemo(() => {
    if (!showTabs) return null;
    return tabs.find((t) => t.key === activeProjectTabKey) ?? tabs[0] ?? null;
  }, [showTabs, tabs, activeProjectTabKey]);

  const selectTab = useCallback((key: string) => {
    setActiveProjectTabKey(key);
    writePersisted(KEYS.activeProject, tabKeyCodec, key);
  }, []);
  // Restoring selects the restored tab; the ref avoids ordering the two
  // callbacks against each other.
  selectTabRef.current = selectTab;

  return {
    tabs,
    hiddenProjectIds,
    setHiddenProjectIds,
    hiddenProjects,
    hideProject,
    restoreProject,
    reorderProjects,
    showTabs,
    activeProjectTab,
    selectTab,
    selectTabRef,
  };
}
