/**
 * The editor's open files, as tabs. Pure, so the rules are tested apart from
 * the components that render them:
 *
 *  - opening a file that is not open adds a tab right after the active one;
 *    opening one that is open activates its tab (and its line);
 *  - closing a tab activates the one used before it, so a ⌘B into another
 *    file and a close lands back where the jump started;
 *  - a step through the change set (‹ ›) replaces the active tab's file,
 *    so walking twenty changed files does not leave twenty tabs.
 */

import type { OpenFileRequest } from '../../types';

export interface EditorTab {
  id: number;
  /** Identity of the file: worktree-relative where possible. */
  key: string;
  /** The latest request for this file; a new object asks for its line again. */
  request: OpenFileRequest;
}

export interface TabsState {
  tabs: EditorTab[];
  active: number | null;
  /** Tab ids, most recently active first. */
  mru: number[];
  nextId: number;
}

export const EMPTY_TABS: TabsState = { tabs: [], active: null, mru: [], nextId: 1 };

function touch(mru: readonly number[], id: number): number[] {
  return [id, ...mru.filter((x) => x !== id)];
}

export function activateTab(state: TabsState, id: number): TabsState {
  if (!state.tabs.some((t) => t.id === id)) return state;
  return { ...state, active: id, mru: touch(state.mru, id) };
}

export function openTab(state: TabsState, key: string, request: OpenFileRequest): TabsState {
  const existing = state.tabs.find((t) => t.key === key);
  if (existing) {
    const tabs = state.tabs.map((t) => (t.id === existing.id ? { ...t, request } : t));
    return activateTab({ ...state, tabs }, existing.id);
  }
  const id = state.nextId;
  const at = state.active === null ? state.tabs.length : state.tabs.findIndex((t) => t.id === state.active) + 1;
  const tabs = [...state.tabs.slice(0, at), { id, key, request }, ...state.tabs.slice(at)];
  return { tabs, active: id, mru: touch(state.mru, id), nextId: id + 1 };
}

/** The active tab now shows another file; an already-open file is switched to instead. */
export function replaceActiveTab(state: TabsState, key: string, request: OpenFileRequest): TabsState {
  if (state.active === null) return openTab(state, key, request);
  const existing = state.tabs.find((t) => t.key === key);
  if (existing) return openTab(state, key, request);
  const tabs = state.tabs.map((t) => (t.id === state.active ? { ...t, key, request } : t));
  return { ...state, tabs };
}

export function closeTab(state: TabsState, id: number): TabsState {
  const tabs = state.tabs.filter((t) => t.id !== id);
  const mru = state.mru.filter((x) => x !== id);
  const active = state.active === id ? (mru[0] ?? null) : state.active;
  return { ...state, tabs, mru: active === null ? mru : touch(mru, active), active };
}
