/**
 * @vitest-environment jsdom
 *
 * Closed project tabs (#367): every change -- close, restore, reopen from the
 * projects manager or a reveal, reopen on blocked -- goes through one path
 * that writes state and storage together, outside a state updater.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import type { Project, Task } from '../../types';
import { KEYS } from '../persisted';
import useProjectTabs from './useProjectTabs';

const project = (id: number, name: string): Project =>
  ({ id, name, repoPath: `/code/${name}`, worktreeRoot: `/code/${name}-w`, defaultBaseBranch: null, createdAt: 0 }) as Project;
const task = (id: number, projectId: number, status: Task['status'] = 'idle'): Task =>
  ({ id, projectId, status, title: `t${id}`, worktreePath: `/w/${id}`, kind: 'work' }) as Task;

const PROJECTS = [project(1, 'a'), project(2, 'b'), project(3, 'c')];
const TASKS = [task(10, 1), task(20, 2), task(30, 3)];

let store: Map<string, string>;
beforeEach(() => {
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

const stored = () => JSON.parse(store.get(KEYS.hiddenProjects) ?? 'null') as number[] | null;
const mount = (tasks: Task[] = TASKS) =>
  renderHook((p: { tasks: Task[] }) => useProjectTabs(PROJECTS, p.tasks), { initialProps: { tasks } });

describe('closed project tabs', () => {
  it('reads the stored set once, and writes the same JSON array back', () => {
    store.set(KEYS.hiddenProjects, '[2]');
    const { result } = mount();
    expect([...result.current.hiddenProjectIds]).toEqual([2]);
    act(() => result.current.hideProject(3));
    expect(store.get(KEYS.hiddenProjects)).toBe('[2,3]');
  });

  it('two changes in one batch both land, in state and in storage', () => {
    const { result } = mount();
    act(() => {
      result.current.hideProject(2);
      result.current.hideProject(3);
    });
    expect([...result.current.hiddenProjectIds].sort()).toEqual([2, 3]);
    expect(stored()?.sort()).toEqual([2, 3]);
    act(() => {
      result.current.unhideProject(2);
      result.current.hideProject(1);
    });
    expect([...result.current.hiddenProjectIds].sort()).toEqual([1, 3]);
    expect(stored()?.sort()).toEqual([1, 3]);
  });

  it('unhideProject reopens without moving the scope; restoreProject moves it', () => {
    const { result } = mount();
    act(() => result.current.selectTab('p1'));
    act(() => {
      result.current.hideProject(2);
      result.current.hideProject(3);
    });
    act(() => result.current.unhideProject(2));
    expect(stored()).toEqual([3]);
    expect(result.current.activeProjectTabKey).toBe('p1');
    act(() => result.current.restoreProject(3));
    expect(stored()).toEqual([]);
    expect(result.current.activeProjectTabKey).toBe('p3');
  });

  it('writes on an unhide of a project that is not hidden, as the manager’s button always did', () => {
    const { result } = mount();
    act(() => result.current.unhideProject(2));
    expect(store.get(KEYS.hiddenProjects)).toBe('[]');
  });

  it('reopens a closed tab when one of its tasks starts waiting on you, and stores it', () => {
    const { result, rerender } = mount();
    act(() => {
      result.current.hideProject(2);
      result.current.hideProject(3);
    });
    rerender({ tasks: [task(10, 1), task(20, 2, 'blocked'), task(30, 3)] });
    expect([...result.current.hiddenProjectIds]).toEqual([3]);
    expect(stored()).toEqual([3]);
  });
});
