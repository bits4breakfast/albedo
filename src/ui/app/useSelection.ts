import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, Task } from '../../types';
import { idCodec, KEYS, readPersisted, writePersisted, type Codec } from '../persisted';
import type { ProjectTab } from './ProjectTabs';

/*
 * Where the user is: a task, or a project with no task (the project view,
 * #181). The selection and the project tab move together both ways:
 *
 *   - selecting a task moves the tab to the task's project (`select`);
 *   - switching tab moves the selection to the place last left in that
 *     project (`land`): its task, or its project view. A project never
 *     visited, or whose task has gone or been archived, lands on the
 *     project view -- never on a task picked for the user.
 *
 * Null is a place, not an absence: with a project in scope it is that
 * project's view. Nothing here picks a task on the user's behalf.
 */

/** Per tab key: the task last on screen there, or null for the project view. */
export type Places = Record<string, number | null>;

const placesCodec: Codec<Places> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Places = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value === 'number') out[key] = value;
    }
    return out;
  },
  encode: (value) => JSON.stringify(value),
};

/** The selected task, or none: none removes the key rather than storing a word for it. */
const selectedCodec: Codec<number | null> = {
  decode: idCodec.decode,
  encode: (value) => (value === null ? null : String(value)),
};

export function readPlaces(): Places {
  return readPersisted(KEYS.projectPlaces, placesCodec, {});
}

function rememberPlace(key: string, id: number | null): void {
  const places = readPlaces();
  if (key in places && places[key] === id) return;
  writePersisted(KEYS.projectPlaces, placesCodec, { ...places, [key]: id });
}

/** The tab a task lives in, as `buildTabs` files it: its project's, else "Other". */
export function tabKeyOf(task: Task, projects: readonly Project[]): string {
  const id = task.projectId;
  return id !== null && projects.some((p) => p.id === id) ? `p${id}` : 'orphans';
}

/**
 * What switching to `key` shows: the remembered task while it is still there,
 * still live and still in that tab; otherwise the project view (null).
 */
export function landingFor(key: string, places: Places, tasks: readonly Task[], projects: readonly Project[]): number | null {
  const id = places[key];
  if (id === undefined || id === null) return null;
  const task = tasks.find((t) => t.id === id);
  if (!task || task.status === 'archived') return null;
  return tabKeyOf(task, projects) === key ? id : null;
}

export interface SelectionInput {
  tasks: Task[];
  projects: Project[];
  loading: boolean;
  /** The visible tabs (useProjectTabs). */
  tabs: ProjectTab[];
  /** The tab the list shows, resolved; null without a bar. */
  activeTab: ProjectTab | null;
  /** The stored active key, which can name a project not loaded yet. */
  activeKey: string;
  /** Moves the list's scope only (useProjectTabs' `selectTab`). */
  selectTab: (key: string) => void;
  /** Goes to a tab: scope, then `land` (useProjectTabs' `switchTab`). */
  switchTab: (key: string) => void;
  /** A task came on screen: open its terminal, clear its mark. */
  onShow?: (id: number) => void;
}

export default function useSelection({
  tasks,
  projects,
  loading,
  tabs,
  activeTab,
  activeKey,
  selectTab,
  switchTab,
  onShow,
}: SelectionInput) {
  const [selectedId, setSelectedId] = useState<number | null>(() =>
    readPersisted(KEYS.selectedTask, selectedCodec, null),
  );

  // The callbacks below are stable, so they read the latest of these through refs.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const switchTabRef = useRef(switchTab);
  switchTabRef.current = switchTab;
  const activeTabKeyRef = useRef<string | null>(null);

  /** Put `id` on screen, or the project view for null. The scope is the caller's business. */
  const show = useCallback((id: number | null) => {
    setSelectedId(id);
    writePersisted(KEYS.selectedTask, selectedCodec, id);
    if (id !== null) onShowRef.current?.(id);
  }, []);

  const select = useCallback(
    (id: number) => {
      // The scope moves first. A task in another project's tab would otherwise be
      // selected behind a list that does not show it, which reads as nothing
      // happening. Only a visible tab can take the scope; a hidden one is the
      // user's choice and is left alone. The scope-only move, never `land`: the
      // task asked for is the place, not the one remembered there.
      const home = tabsRef.current.find((t) => t.tasks.some((task) => task.id === id));
      if (home) selectTabRef.current(home.key);
      show(id);
    },
    [show],
  );

  /** The selection half of a tab switch: the place last left in `key`. */
  const land = useCallback(
    (key: string) => show(landingFor(key, readPlaces(), tasksRef.current, projectsRef.current)),
    [show],
  );

  /** The project view of `key`'s project: the tab takes the scope, nothing is selected. */
  const showProjectView = useCallback(
    (key: string) => {
      selectTabRef.current(key);
      show(null);
    },
    [show],
  );

  /**
   * A click on a project tab. The tab already showing, clicked again, is the
   * way from a task to its project's view; any other goes to the place last
   * left there.
   */
  const clickTab = useCallback(
    (key: string) => {
      if (key === activeTabKeyRef.current) showProjectView(key);
      else switchTabRef.current(key);
    },
    [showProjectView],
  );

  const selected = selectedId === null ? null : (tasks.find((t) => t.id === selectedId) ?? null);
  const activeTabKey = activeTab?.key ?? null;
  activeTabKeyRef.current = activeTabKey;

  // A task that went (deleted, archived, gone from the database) leaves its
  // project's view in its place, not another task. Then the other direction of
  // the rule: a selection whose tab is showing but not active takes the scope
  // with it -- a task moved to another project, or a selection restored at
  // launch that the stored tab disagrees with.
  useEffect(() => {
    if (loading || selectedId === null) return;
    if (!selected || selected.status === 'archived') {
      show(null);
      return;
    }
    if (activeTabKey === null) return;
    const home = tabs.find((t) => t.tasks.some((task) => task.id === selectedId));
    if (home && home.key !== activeTabKey) selectTab(home.key);
  }, [loading, selectedId, selected, activeTabKey, tabs, selectTab, show]);

  // Remember where each project was left. A task is remembered for its own
  // project, even one whose tab is closed, so restoring the tab lands on it;
  // the project view is remembered for the tab that shows it.
  useEffect(() => {
    // Before the projects load every task reads as "Other": nothing to file yet.
    if (loading || projects.length === 0) return;
    if (selectedId === null) {
      if (activeKey) rememberPlace(activeKey, null);
      return;
    }
    if (!selected || selected.status === 'archived') return;
    rememberPlace(tabKeyOf(selected, projects), selected.id);
  }, [loading, selectedId, selected, activeKey, projects]);

  return { selectedId, select, land, showProjectView, clickTab };
}
