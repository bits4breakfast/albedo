/**
 * The editor as tabs: one per open file, for one task.
 *
 * Every tab keeps its own FileEditor mounted (hidden when not on screen), so
 * switching tabs keeps unsaved edits, undo history, the cursor and the
 * scroll. A tab's editor is only created the first time the tab is shown:
 * tabs restored for a task do not all read their files and fight for focus.
 *
 * The tabs are not drawn here but in the reading pane's own head row (`headSlot`),
 * after its Transcript / Editor tabs, so the file's name is on screen once.
 * The active editor's controls follow them in the same row.
 *
 * The rules for opening and closing live in tabsModel.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { OpenFileRequest, Task } from '../../types';
import { worktreeRelative } from '../quickOpenModel';
import FileEditor from './FileEditor';
import { activateTab, closeTab, EMPTY_TABS, openTab, replaceActiveTab, type TabsState } from './tabsModel';
import './editortabs.css';

export interface EditorTabsProps {
  task: Task;
  /** The latest open request from anywhere in the app; a new object opens it. */
  request: OpenFileRequest | null;
  /** That request walks a Files list: it replaces the active tab (OpenFileOptions.step). */
  step?: boolean;
  readOnly: boolean;
  /** The last tab was closed. */
  onCloseAll: () => void;
  /** Bumped by ⌘W: close the active tab. */
  closeSignal: number;
  /** The active tab's file, for the files list and Quick Open. */
  onActivePath?: (path: string | null) => void;
  /** The pane head's slot the tab row is drawn into; null while it is not on screen. */
  headSlot: HTMLElement | null;
}

/** Open tabs per task, so switching tasks and back keeps them (not their unsaved edits). */
const remembered = new Map<number, TabsState>();

/**
 * The last File / Diff choice, for every task: reviewing as diffs should not
 * have to be switched on again for each file opened.
 */
let preferredMode: 'file' | 'diff' = 'file';

/** Forget a task's tabs: the editor was closed on purpose. */
export function forgetEditorTabs(taskId: number): void {
  remembered.delete(taskId);
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export default function EditorTabs({
  task,
  request,
  step: stepRequest = false,
  readOnly,
  onCloseAll,
  closeSignal,
  onActivePath,
  headSlot,
}: EditorTabsProps): ReactNode {
  const [state, setState] = useState<TabsState>(() => {
    const kept = remembered.get(task.id);
    // A restored tab must not re-jump to a line it was opened at long ago.
    return kept ? { ...kept, tabs: kept.tabs.map((t) => ({ ...t, request: { path: t.request.path } })) } : EMPTY_TABS;
  });
  const keyFor = useCallback((path: string) => worktreeRelative(task.worktreePath, path) ?? path, [task.worktreePath]);

  const [dirty, setDirty] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Every new request object opens (or switches to) its file. A step replaces
  // the active tab, unless that tab has unsaved edits: those are never swapped out.
  const seen = useRef<OpenFileRequest | null>(null);
  useEffect(() => {
    if (request === null || request === seen.current) return;
    seen.current = request;
    setState((s) =>
      stepRequest && !(s.active !== null && dirtyRef.current.get(s.active))
        ? replaceActiveTab(s, keyFor(request.path), request)
        : openTab(s, keyFor(request.path), request),
    );
  }, [request, stepRequest, keyFor]);

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

  /** Tabs showing their diff, for the tab's marker. */
  const [diffing, setDiffing] = useState<ReadonlySet<number>>(() => new Set());
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
    setDiffing((m) => {
      const next = new Set(m);
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

  const rememberMode = useCallback((mode: 'file' | 'diff') => {
    preferredMode = mode;
  }, []);

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
  const modeHandlers = useRef(new Map<number, (mode: 'file' | 'diff') => void>());
  const modeHandler = (id: number) => {
    let h = modeHandlers.current.get(id);
    if (!h) {
      h = (mode: 'file' | 'diff') =>
        setDiffing((m) => {
          if (m.has(id) === (mode === 'diff')) return m;
          const next = new Set(m);
          if (mode === 'diff') next.add(id);
          else next.delete(id);
          return next;
        });
      modeHandlers.current.set(id, h);
    }
    return h;
  };

  // The active tab scrolled into view when the row is too narrow for all of them.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [state.active, headSlot]);

  /** Where the active editor draws its ‹ ›, Save and ⋯. */
  const [controlsSlot, setControlsSlot] = useState<HTMLDivElement | null>(null);

  const head = (
    <div className="ed-head">
      <span className="ed-head-sep" aria-hidden="true" />
      <div className="ed-tabstrip" role="tablist" aria-label="Open files" ref={stripRef}>
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
              {diffing.has(t.id) ? (
                <span className="ed-tab-mark" title="Showing this task's change to the file (⇧⌘D for the file)">
                  Diff
                </span>
              ) : null}
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
      <div className="ed-head-controls" ref={setControlsSlot} />
    </div>
  );

  return (
    <div className="ed-tabs-root">
      {headSlot ? createPortal(head, headSlot) : null}
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
                onModeChange={modeHandler(t.id)}
                controlsSlot={controlsSlot}
                onStep={step}
                closeSignal={closeAsks.get(t.id) ?? 0}
                // A new file opens in the last mode chosen. One opened at a
                // line (a ⌘B jump, a path:line link) still shows that line in
                // File, without changing what is remembered.
                initialMode={preferredMode}
                onModeChosen={rememberMode}
              />
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
