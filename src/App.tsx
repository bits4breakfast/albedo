import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Task } from './types';
import useTasks from './ui/useTasks';
import Header from './ui/Header';
import TaskList from './ui/TaskList';
import Terminal from './ui/Terminal';
import NewTaskDialog from './ui/NewTaskDialog';
import WorktreeReconcile from './ui/WorktreeReconcile';
import TranscriptPane from './ui/transcript/TranscriptPane';

/**
 * The frame.
 *
 * Three panes: tasks on the left, then the main area split between the pty
 * (input and live progress) and the transcript (reading). The user picks which
 * of the two they want at full width; both stay mounted either way, because
 * unmounting the pty pane would kill running Claude sessions.
 */

type PaneMode = 'pty' | 'split' | 'transcript';
type Orientation = 'row' | 'column';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 260;
const RATIO_MIN = 0.18;
const RATIO_MAX = 0.86;

const LS = {
  sidebar: 'albedo.shell.sidebarWidth',
  mode: 'albedo.shell.paneMode',
  ratio: 'albedo.shell.splitRatio',
  orientation: 'albedo.shell.orientation',
  selected: 'albedo.shell.selectedTask',
} as const;

function readStored<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = parse(raw);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — layout preference is not worth an error */
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------------------
// Error boundary
//
// The only class in the codebase. React has no hook equivalent, and a sibling
// module that is still being written must not be able to white-screen the app:
// a throw inside the transcript pane has to stay inside the transcript pane.
// ---------------------------------------------------------------------------

interface BoundaryProps {
  label: string;
  children: ReactNode;
}
interface BoundaryState {
  error: Error | null;
}

class PaneErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[albedo] ${this.props.label} crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pane-error">
        {this.props.label} failed to render.
        <pre>{error.message}</pre>
        <button className="btn" onClick={() => this.setState({ error: null })} style={{ marginTop: 12 }}>
          Retry
        </button>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------

export default function App() {
  const { tasks, loading, loadError, captureError, refresh, upsertTask } = useTasks();

  const [selectedId, setSelectedId] = useState<number | null>(() =>
    readStored(LS.selected, (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null), null),
  );
  /** Tasks whose terminal has been brought up. Kept alive until the task goes. */
  const [openIds, setOpenIds] = useState<number[]>([]);

  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStored(LS.sidebar, (raw) => clamp(Number(raw) || SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_DEFAULT),
  );
  const [mode, setMode] = useState<PaneMode>(() =>
    readStored(LS.mode, (raw) => (raw === 'pty' || raw === 'split' || raw === 'transcript' ? raw : null), 'split'),
  );
  const [orientation, setOrientation] = useState<Orientation>(() =>
    readStored(LS.orientation, (raw) => (raw === 'row' || raw === 'column' ? raw : null), 'row'),
  );
  const [ratio, setRatio] = useState(() =>
    readStored(LS.ratio, (raw) => clamp(Number(raw) || 0.55, RATIO_MIN, RATIO_MAX), 0.55),
  );

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [dragging, setDragging] = useState<null | 'sidebar' | 'split'>(null);

  const panesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => store(LS.sidebar, String(Math.round(sidebarWidth))), [sidebarWidth]);
  useEffect(() => store(LS.mode, mode), [mode]);
  useEffect(() => store(LS.orientation, orientation), [orientation]);
  useEffect(() => store(LS.ratio, ratio.toFixed(3)), [ratio]);

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const select = useCallback((id: number) => {
    setSelectedId(id);
    store(LS.selected, String(id));
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  // Pick something sensible once tasks land: whatever is blocked first.
  useEffect(() => {
    if (loading || tasks.length === 0) return;
    if (selectedId !== null && tasks.some((t) => t.id === selectedId)) return;
    const candidate =
      tasks.find((t) => t.status === 'blocked') ??
      tasks.find((t) => t.status === 'running') ??
      tasks.find((t) => t.status !== 'archived') ??
      tasks[0];
    if (candidate) select(candidate.id);
  }, [loading, tasks, selectedId, select]);

  // Terminals outlive tab switches, but not the task itself.
  useEffect(() => {
    setOpenIds((prev) => {
      const live = prev.filter((id) => tasks.some((t) => t.id === id && t.status !== 'archived'));
      return live.length === prev.length ? prev : live;
    });
  }, [tasks]);

  const openTasks = useMemo(
    () =>
      openIds
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => t !== undefined),
    [openIds, tasks],
  );

  // --- splitter drags ------------------------------------------------------

  const startSidebarDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging('sidebar');
    const move = (ev: PointerEvent) => setSidebarWidth(clamp(ev.clientX, SIDEBAR_MIN, SIDEBAR_MAX));
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startSplitDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = panesRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging('split');
    const move = (ev: PointerEvent) => {
      const next =
        orientation === 'row'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      setRatio(clamp(next, RATIO_MIN, RATIO_MAX));
    };
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- shortcuts -----------------------------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '\\') {
        e.preventDefault();
        setMode((m) => (m === 'pty' ? 'split' : m === 'split' ? 'transcript' : 'pty'));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // --- render --------------------------------------------------------------

  const showPty = mode !== 'transcript';
  const showTranscript = mode !== 'pty';
  const split = mode === 'split';

  const primaryStyle = split
    ? { flex: `0 0 ${(ratio * 100).toFixed(2)}%` }
    : { flex: '1 1 auto' };
  const secondaryStyle = { flex: '1 1 0' };

  const banner = loadError ?? captureError;

  return (
    <div className="app" data-dragging={dragging !== null}>
      <Header
        onNewTask={() => setNewTaskOpen(true)}
        onReconcile={() => setReconcileOpen(true)}
        blockedCount={tasks.filter((t) => t.status === 'blocked').length}
      />

      {banner && (
        <div className="banner">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          <span className="banner-text" title={banner}>
            {banner}
          </span>
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      <div className="app-body">
        <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
          <TaskList
            tasks={tasks}
            selectedId={selectedId}
            onSelect={select}
            onNew={() => setNewTaskOpen(true)}
          />
        </aside>

        <div
          className="splitter splitter-v"
          data-dragging={dragging === 'sidebar'}
          onPointerDown={startSidebarDrag}
          role="separator"
          aria-orientation="vertical"
        />

        <main className="main">
          <div className="main-bar">
            <div className="main-ident">
              {selected ? (
                <>
                  <span className="main-ident-title">{selected.title}</span>
                  <span className="main-ident-path">{selected.worktreePath}</span>
                </>
              ) : (
                <span className="main-ident-path">no task selected</span>
              )}
            </div>

            <div className="seg" role="group" aria-label="Pane layout">
              <button aria-pressed={mode === 'pty'} onClick={() => setMode('pty')} title="Terminal only (⌘\)">
                pty
              </button>
              <button aria-pressed={mode === 'split'} onClick={() => setMode('split')} title="Split (⌘\)">
                split
              </button>
              <button
                aria-pressed={mode === 'transcript'}
                onClick={() => setMode('transcript')}
                title="Transcript only (⌘\)"
              >
                transcript
              </button>
            </div>

            <button
              className="btn btn-ghost"
              onClick={() => setOrientation((o) => (o === 'row' ? 'column' : 'row'))}
              title="Split direction"
              disabled={!split}
            >
              {orientation === 'row' ? '↔' : '↕'}
            </button>
          </div>

          <div className="panes" data-orientation={orientation} ref={panesRef}>
            {/* Kept mounted in every mode: unmounting it would kill live ptys. */}
            <section className="pane pane-pty" style={primaryStyle} hidden={!showPty}>
              <div className="pane-head">
                <span>pty</span>
                <span className="pane-head-note">
                  {openTasks.length} session{openTasks.length === 1 ? '' : 's'} alive
                </span>
              </div>
              <div className="pane-body">
                <div className="term-stack">
                  {openTasks.map((task) => (
                    <Terminal key={task.id} task={task} active={task.id === selectedId} />
                  ))}
                </div>
                {openTasks.length === 0 && (
                  <div className="placeholder">
                    {loading ? (
                      'loading tasks…'
                    ) : tasks.length === 0 ? (
                      <>
                        Nothing running.
                        <span className="placeholder-key">⌘N</span>
                        cuts a worktree and starts a Claude Code session in it.
                      </>
                    ) : (
                      'Pick a task to attach a terminal.'
                    )}
                  </div>
                )}
              </div>
            </section>

            {split && (
              <div
                className={`splitter ${orientation === 'row' ? 'splitter-v' : 'splitter-h'}`}
                data-dragging={dragging === 'split'}
                onPointerDown={startSplitDrag}
                role="separator"
                aria-orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
              />
            )}

            <section className="pane pane-transcript" style={secondaryStyle} hidden={!showTranscript}>
              <div className="pane-head">
                <span>transcript</span>
                <span className="pane-head-note">{selected?.sessionId ?? 'no session yet'}</span>
              </div>
              <div className="pane-body">
                <PaneErrorBoundary key={selected?.id ?? 'none'} label="Transcript">
                  <TranscriptPane
                    taskId={selected?.id ?? null}
                    sessionId={selected?.sessionId ?? null}
                  />
                </PaneErrorBoundary>
              </div>
            </section>
          </div>
        </main>
      </div>

      <PaneErrorBoundary label="New task">
        <NewTaskDialog
          open={newTaskOpen}
          onClose={() => setNewTaskOpen(false)}
          onCreated={(task: Task) => {
            upsertTask(task);
            select(task.id);
            setNewTaskOpen(false);
          }}
        />
      </PaneErrorBoundary>

      <PaneErrorBoundary label="Worktree reconcile">
        <WorktreeReconcile
          open={reconcileOpen}
          onClose={() => {
            setReconcileOpen(false);
            void refresh();
          }}
        />
      </PaneErrorBoundary>
    </div>
  );
}
