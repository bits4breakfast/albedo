/**
 * The editor as tabs: one per open file, for one task.
 *
 * Every tab keeps its own FileEditor mounted (hidden when not on screen), so
 * switching tabs keeps unsaved edits, undo history, the cursor and the
 * scroll. A tab's editor is only created the first time the tab is shown:
 * tabs restored for a task do not all read their files and fight for focus.
 *
 * The rules for opening and closing live in tabsModel.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { OpenFileRequest, Task } from '../../types';
import { worktreeRelative } from '../quickOpenModel';
import FileEditor from './FileEditor';
import { activateTab, closeTab, EMPTY_TABS, openTab, replaceActiveTab, type TabsState } from './tabsModel';
import './editortabs.css';

export interface EditorTabsProps {
  task: Task;
  /** The latest open request from anywhere in the app; a new object opens it. */
  request: OpenFileRequest | null;
  readOnly: boolean;
  /** The last tab was closed. */
  onCloseAll: () => void;
  /** Bumped by ⌘W: close the active tab. */
  closeSignal: number;
  /** The active tab's file, for the pane header and Quick Open. */
  onActivePath?: (path: string | null) => void;
}

/** Open tabs per task, so switching tasks and back keeps them (not their unsaved edits). */
const remembered = new Map<number, TabsState>();

/** Forget a task's tabs: the editor was closed on purpose. */
export function forgetEditorTabs(taskId: number): void {
  remembered.delete(taskId);
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export default function EditorTabs({ task, request, readOnly, onCloseAll, closeSignal, onActivePath }: EditorTabsProps): ReactNode {
  const [state, setState] = useState<TabsState>(() => {
    const kept = remembered.get(task.id);
    // A restored tab must not re-jump to a line it was opened at long ago.
    return kept ? { ...kept, tabs: kept.tabs.map((t) => ({ ...t, request: { path: t.request.path } })) } : EMPTY_TABS;
  });
  const keyFor = useCallback((path: string) => worktreeRelative(task.worktreePath, path) ?? path, [task.worktreePath]);

  // Every new request object opens (or switches to) its file.
  const seen = useRef<OpenFileRequest | null>(null);
  useEffect(() => {
    if (request === null || request === seen.current) return;
    seen.current = request;
    setState((s) => openTab(s, keyFor(request.path), request));
  }, [request, keyFor]);

  useEffect(() => {
    remembered.set(task.id, state);
  }, [task.id, state]);

  const activeTab = state.tabs.find((t) => t.id === state.active) ?? null;
  useEffect(() => {
    onActivePath?.(activeTab?.request.path ?? null);
  }, [activeTab?.request.path, onActivePath]);

  // Tabs that have been on screen at least once; only those have an editor.
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    if (state.active !== null && !mounted.has(state.active)) setMounted((m) => new Set(m).add(state.active!));
  }, [state.active, mounted]);

  const [dirty, setDirty] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [closeAsks, setCloseAsks] = useState<ReadonlyMap<number, number>>(() => new Map());
  /** Ask a tab to close: through its own editor, so unsaved edits are asked about. */
  const askClose = useCallback(
    (id: number) => {
      if (!mounted.has(id)) {
        // Never shown, so nothing in it can be unsaved.
        setState((s) => closeTab(s, id));
        return;
      }
      setState((s) => activateTab(s, id));
      setCloseAsks((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1));
    },
    [mounted],
  );

  // ⌘W closes the active tab.
  const lastSignal = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal === lastSignal.current) return;
    lastSignal.current = closeSignal;
    if (state.active !== null) askClose(state.active);
  }, [closeSignal, state.active, askClose]);

  const closed = useCallback((id: number) => {
    setState((s) => closeTab(s, id));
    setMounted((m) => {
      const next = new Set(m);
      next.delete(id);
      return next;
    });
    setDirty((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }, []);

  // The last tab gone: the editor closes.
  const hadTabs = useRef(state.tabs.length > 0);
  useEffect(() => {
    if (state.tabs.length > 0) hadTabs.current = true;
    else if (hadTabs.current) {
      forgetEditorTabs(task.id);
      onCloseAll();
    }
  }, [state.tabs.length, task.id, onCloseAll]);

  const step = useCallback(
    (path: string) => setState((s) => replaceActiveTab(s, keyFor(path), { path })),
    [keyFor],
  );

  // Stable per-tab callbacks, so an editor is not re-rendered for nothing.
  const dirtyHandlers = useRef(new Map<number, (d: boolean) => void>());
  const dirtyHandler = (id: number) => {
    let h = dirtyHandlers.current.get(id);
    if (!h) {
      h = (d: boolean) =>
        setDirty((m) => {
          if ((m.get(id) ?? false) === d) return m;
          return new Map(m).set(id, d);
        });
      dirtyHandlers.current.set(id, h);
    }
    return h;
  };

  return (
    <div className="ed-tabs-root">
      <div className="ed-tabstrip" role="tablist" aria-label="Open files">
        {state.tabs.map((t) => {
          const isActive = t.id === state.active;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className="ed-tab"
              title={t.key}
              onMouseDown={(e) => {
                // Middle click closes, as in every browser and IDE.
                if (e.button === 1) {
                  e.preventDefault();
                  askClose(t.id);
                }
              }}
              onClick={() => setState((s) => activateTab(s, t.id))}
            >
              <span className="ed-tab-name">{baseName(t.key)}</span>
              {dirty.get(t.id) ? <span className="ed-tab-dot" aria-label="unsaved changes" /> : null}
              <button
                type="button"
                className="ed-tab-close"
                aria-label={`Close ${baseName(t.key)}`}
                title="Close (⌘W)"
                onClick={(e) => {
                  e.stopPropagation();
                  askClose(t.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <div className="ed-tabs-body">
        {state.tabs.map((t) =>
          mounted.has(t.id) ? (
            <div key={t.id} className="ed-tab-panel" hidden={t.id !== state.active}>
              <FileEditor
                task={task}
                request={t.request}
                readOnly={readOnly}
                active={t.id === state.active}
                onClose={() => closed(t.id)}
                onDirtyChange={dirtyHandler(t.id)}
                onStep={step}
                closeSignal={closeAsks.get(t.id) ?? 0}
              />
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
