/**
 * @vitest-environment jsdom
 *
 * Where a project tab lands (#181), through the two hooks wired the way
 * App.tsx wires them: useProjectTabs' `switchTab` tells useSelection's `land`,
 * and `select` moves the tab. The bug this replaces: a new, empty tab showed
 * its empty list beside another project's task, composer and files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useRef } from 'react';

import type { Project, Task } from '../../types';
import { KEYS } from '../persisted';
import useProjectTabs from './useProjectTabs';
import useSelection, { landingFor } from './useSelection';

function project(id: number, name: string): Project {
  return {
    id,
    name,
    repoPath: `/code/${name}`,
    worktreeRoot: `/code/${name}-worktrees`,
    defaultBaseBranch: null,
    taskPromptTemplate: null,
    createdAt: 0,
    archivedAt: null,
  } as Project;
}

function task(id: number, projectId: number, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    projectId,
    repoPath: '/code/x',
    baseBranch: 'main',
    branch: `b${id}`,
    worktreePath: `/code/x-${id}`,
    sessionId: null,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 0,
    lastActivityAt: null,
    seenAt: null,
    summary: null,
    ...over,
  };
}

const ACME = project(1, 'acme-api');
const WEB = project(2, 'acme-web');
const INFRA = project(3, 'infra');

/** App.tsx's wiring of the two hooks, and nothing else. */
function useWhereabouts({ projects, tasks, loading = false }: { projects: Project[]; tasks: Task[]; loading?: boolean }) {
  const landRef = useRef<(key: string) => void>(() => {});
  const tabs = useProjectTabs(projects, tasks, (key) => landRef.current(key));
  const selection = useSelection({
    tasks,
    projects,
    loading,
    tabs: tabs.tabs,
    activeTab: tabs.activeProjectTab,
    activeKey: tabs.activeProjectTabKey,
    selectTab: tabs.selectTab,
    switchTab: tabs.switchTab,
  });
  landRef.current = selection.land;
  return { ...tabs, ...selection };
}

let store: Map<string, string>;
beforeEach(() => {
  // Never the environment's own storage (docs/REGRESSIONS.md, "Green locally,
  // red on CI: a different Node"): a fresh one per test.
  store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

afterEach(cleanup);

const TASKS = [task(10, 1), task(11, 1), task(20, 2), task(21, 2)];

function mount(tasks: Task[] = TASKS, projects: Project[] = [ACME, WEB, INFRA]) {
  return renderHook((props: { projects: Project[]; tasks: Task[]; loading?: boolean }) => useWhereabouts(props), {
    initialProps: { projects, tasks },
  });
}

describe('switching project tab', () => {
  it('lands on the task last viewed in that project', () => {
    const { result } = mount();
    act(() => result.current.select(11));
    act(() => result.current.select(20));
    expect(result.current.activeProjectTab?.key).toBe('p2');

    act(() => result.current.switchTab('p1'));
    expect(result.current.activeProjectTab?.key).toBe('p1');
    expect(result.current.selectedId).toBe(11);

    act(() => result.current.switchTab('p2'));
    expect(result.current.selectedId).toBe(20);
  });

  it('lands on the project view in a project not visited yet, never on one of its tasks', () => {
    const { result } = mount();
    act(() => result.current.select(10));
    act(() => result.current.switchTab('p2'));
    expect(result.current.activeProjectTab?.key).toBe('p2');
    expect(result.current.selectedId).toBeNull();
  });

  it('lands on the project view in an empty project', () => {
    const { result } = mount();
    act(() => result.current.select(20));
    act(() => result.current.switchTab('p3'));
    expect(result.current.activeProjectTab?.key).toBe('p3');
    expect(result.current.selectedId).toBeNull();
  });

  it('remembers the project view as a place too', () => {
    const { result } = mount();
    act(() => result.current.select(10));
    act(() => result.current.showProjectView('p1'));
    act(() => result.current.switchTab('p2'));
    act(() => result.current.switchTab('p1'));
    expect(result.current.selectedId).toBeNull();
  });

  it('lands on the project view when the remembered task was archived', () => {
    const { result, rerender } = mount();
    act(() => result.current.select(21));
    act(() => result.current.switchTab('p1'));
    rerender({ projects: [ACME, WEB, INFRA], tasks: TASKS.map((t) => (t.id === 21 ? { ...t, status: 'archived' } : t)) });
    act(() => result.current.switchTab('p2'));
    expect(result.current.selectedId).toBeNull();
  });

  it('lands on the project view when the remembered task is gone', () => {
    const { result, rerender } = mount();
    act(() => result.current.select(21));
    act(() => result.current.switchTab('p1'));
    rerender({ projects: [ACME, WEB, INFRA], tasks: TASKS.filter((t) => t.id !== 21) });
    act(() => result.current.switchTab('p2'));
    expect(result.current.selectedId).toBeNull();
  });

  it('closing the active tab, and restoring a closed one, land like a switch', () => {
    const { result } = mount();
    act(() => result.current.select(20));
    act(() => result.current.select(10));
    // Closing the active tab lands on its neighbour, at its remembered task.
    act(() => result.current.hideProject(1));
    expect(result.current.activeProjectTab?.key).toBe('p2');
    expect(result.current.selectedId).toBe(20);
    // Restoring it goes back to where it was left.
    act(() => result.current.restoreProject(1));
    expect(result.current.activeProjectTab?.key).toBe('p1');
    expect(result.current.selectedId).toBe(10);
  });
});

describe('selecting a task', () => {
  it('in another tab lands on that task, not the one remembered there', () => {
    const { result } = mount();
    act(() => result.current.select(20)); // p2 remembers 20
    act(() => result.current.select(10));
    act(() => result.current.select(21));
    expect(result.current.activeProjectTab?.key).toBe('p2');
    expect(result.current.selectedId).toBe(21);
    // ...and that is now what p2 remembers.
    act(() => result.current.switchTab('p1'));
    act(() => result.current.switchTab('p2'));
    expect(result.current.selectedId).toBe(21);
  });

  it('archived while on screen leaves its project view, not another task', () => {
    const { result, rerender } = mount();
    act(() => result.current.select(10));
    rerender({ projects: [ACME, WEB, INFRA], tasks: TASKS.map((t) => (t.id === 10 ? { ...t, status: 'archived' } : t)) });
    expect(result.current.selectedId).toBeNull();
    expect(result.current.activeProjectTab?.key).toBe('p1');
  });

  it('deleted while on screen leaves its project view', () => {
    const { result, rerender } = mount();
    act(() => result.current.select(11));
    rerender({ projects: [ACME, WEB, INFRA], tasks: TASKS.filter((t) => t.id !== 11) });
    expect(result.current.selectedId).toBeNull();
    expect(result.current.activeProjectTab?.key).toBe('p1');
  });
});

describe('to the project view from a task', () => {
  it('clicking the tab already showing', () => {
    const { result } = mount();
    act(() => result.current.select(20));
    act(() => result.current.clickTab('p2'));
    expect(result.current.selectedId).toBeNull();
    expect(result.current.activeProjectTab?.key).toBe('p2');
  });

  it('clicking another tab is a switch, not its project view', () => {
    const { result } = mount();
    act(() => result.current.select(20));
    act(() => result.current.select(10));
    act(() => result.current.clickTab('p2'));
    expect(result.current.selectedId).toBe(20);
  });

  it('the breadcrumb (showProjectView on the task’s project)', () => {
    const { result } = mount();
    act(() => result.current.select(21));
    act(() => result.current.showProjectView('p2'));
    expect(result.current.selectedId).toBeNull();
    expect(result.current.activeProjectTab?.key).toBe('p2');
  });
});

describe('across a reload', () => {
  it('restores the tab, the selection and each project’s place', () => {
    const first = mount();
    act(() => first.result.current.select(11));
    act(() => first.result.current.select(20));
    act(() => first.result.current.showProjectView('p2'));
    first.unmount();

    const { result } = mount();
    expect(result.current.activeProjectTab?.key).toBe('p2');
    expect(result.current.selectedId).toBeNull();
    act(() => result.current.switchTab('p1'));
    expect(result.current.selectedId).toBe(11);
  });

  it('a restored task keeps its selection once the tasks load', () => {
    const first = mount();
    act(() => first.result.current.select(21));
    first.unmount();

    const { result, rerender } = renderHook(
      (props: { projects: Project[]; tasks: Task[]; loading?: boolean }) => useWhereabouts(props),
      { initialProps: { projects: [] as Project[], tasks: [] as Task[], loading: true } },
    );
    rerender({ projects: [ACME, WEB, INFRA], tasks: TASKS, loading: false });
    expect(result.current.selectedId).toBe(21);
    expect(result.current.activeProjectTab?.key).toBe('p2');
  });

  it('a selection the stored tab disagrees with takes the scope to its own tab', () => {
    // What the old app could leave behind: an empty tab active, another
    // project's task selected.
    store.set(KEYS.activeProject, 'p3');
    store.set(KEYS.selectedTask, '10');
    const { result } = mount();
    expect(result.current.selectedId).toBe(10);
    expect(result.current.activeProjectTab?.key).toBe('p1');
  });

  it('nothing stored: the project view, not a task picked for the user', () => {
    const { result } = mount([task(10, 1, { status: 'blocked' }), task(20, 2)]);
    expect(result.current.selectedId).toBeNull();
  });
});

describe('landingFor', () => {
  it('only a live task still filed under that tab', () => {
    const tasks = [task(10, 1), task(11, 1, { status: 'archived' }), task(20, 2)];
    const projects = [ACME, WEB];
    expect(landingFor('p1', { p1: 10 }, tasks, projects)).toBe(10);
    expect(landingFor('p1', { p1: 11 }, tasks, projects)).toBeNull();
    expect(landingFor('p1', { p1: 20 }, tasks, projects)).toBeNull(); // moved to another project
    expect(landingFor('p1', { p1: 99 }, tasks, projects)).toBeNull();
    expect(landingFor('p1', { p1: null }, tasks, projects)).toBeNull();
    expect(landingFor('p2', {}, tasks, projects)).toBeNull();
  });
});
