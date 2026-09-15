import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { OpenFileRequest, Project, Task } from './types';
import { useTheme } from './ui/theme';
import type { ThemeChoice } from './ui/theme';
import useTasks from './ui/useTasks';
import Header from './ui/Header';
import TaskList from './ui/TaskList';
import StatusDot from './ui/StatusDot';
import Terminal from './ui/Terminal';
import NewTaskDialog from './ui/NewTaskDialog';
import WorktreeReconcile from './ui/WorktreeReconcile';
import TranscriptPane from './ui/transcript/TranscriptPane';
import ArchiveTaskDialog from './ui/ArchiveTaskDialog';
import TouchedFiles from './ui/TouchedFiles';
import FileEditor from './ui/editor/FileEditor';
import { FileOpenContext } from './ui/editor/openFile';
import UsagePanel from './ui/gauges/UsagePanel';
import ProjectsDialog from './ui/ProjectsDialog';
import { backfillProjectsFromTasks } from './db/projects';
import { parseIssueKey } from './lib/issueKey';

/**
 * The frame.
 *
 * Three panes: tasks on the left, then the main area split between the pty
 * (input and live progress) and a reading pane. The user picks which of the two
 * they want at full width; both stay mounted either way, because unmounting the
 * pty pane would kill running Claude sessions.
 *
 * The reading pane is tabbed rather than split further: transcript (time axis),
 * files (change-set axis) and — only once a file has been requested — editor.
 * A fourth resizable pane would leave every one of them too narrow to read at
 * 1440px, which is the width this app is actually used at.
 */

type PaneMode = 'pty' | 'split' | 'transcript';
type Orientation = 'row' | 'column';
/** Tabs of the right-hand reading pane. `editor` appears on demand. */
type RightTab = 'transcript' | 'files' | 'editor';

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
  project: 'albedo.shell.activeProject',
  rightTab: 'albedo.shell.rightTab',
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

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'auto',
  light: 'light',
  dark: 'dark',
};

const THEME_TITLE: Record<ThemeChoice, string> = {
  system: 'Follow the system appearance',
  light: 'Always light',
  dark: 'Always dark',
};

function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (next: ThemeChoice) => void;
}) {
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((choice) => (
        <button
          key={choice}
          aria-pressed={value === choice}
          onClick={() => onChange(choice)}
          title={THEME_TITLE[choice]}
        >
          {THEME_LABEL[choice]}
        </button>
      ))}
    </div>
  );
}

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
// Project tabs
//
// Deliberately absent until they are needed. One project is the expected case,
// and in that case this is a no-op: no bar, no chrome, no vertical space — the
// app exactly as it was. The second project summons the bar, and that is the
// entire interaction. No reordering, no per-tab state, nothing else: a rare
// case earns correctness, not a surface.
//
// The one thing the bar MUST do is keep the app's core promise working. Tabs
// hide every task outside the active project, so a session that blocks in a
// background project would go invisible — the app failing at its only job
// exactly when several things are running. Each tab therefore carries its own
// status in the same visual language as the rows: blocked pings, running
// breathes, and those stay the only two moving things in the app.
// ---------------------------------------------------------------------------

interface ProjectTab {
  key: string;
  /** null = the "Other" tab: tasks belonging to no known project. */
  project: Project | null;
  label: string;
  tasks: Task[];
  blocked: number;
  running: number;
}

function buildTabs(projects: Project[], tasks: Task[]): ProjectTab[] {
  const byProject = new Map<number, Task[]>();
  const orphans: Task[] = [];
  for (const task of tasks) {
    const id = task.projectId;
    if (id === null || !projects.some((p) => p.id === id)) orphans.push(task);
    else {
      const bucket = byProject.get(id);
      if (bucket) bucket.push(task);
      else byProject.set(id, [task]);
    }
  }
  const count = (list: Task[], status: Task['status']) =>
    list.filter((t) => t.status === status).length;

  const tabs: ProjectTab[] = projects.map((project) => {
    const list = byProject.get(project.id) ?? [];
    return {
      key: `p${project.id}`,
      project,
      label: project.name,
      tasks: list,
      blocked: count(list, 'blocked'),
      running: count(list, 'running'),
    };
  });
  // Only when it has something in it. A task with no project means the backfill
  // failed, and an invisible task is the one outcome worth a whole extra tab.
  if (orphans.length > 0) {
    tabs.push({
      key: 'orphans',
      project: null,
      label: 'Other',
      tasks: orphans,
      blocked: count(orphans, 'blocked'),
      running: count(orphans, 'running'),
    });
  }
  return tabs;
}

/**
 * Build the initial prompt for a task's first session.
 *
 * Opt-in by design: an empty or absent template yields null, and null means no
 * argv prompt at all. Silently prompting an agent the user has just launched
 * is a side effect they did not ask for, so the default is to say nothing.
 */
function renderPromptTemplate(task: Task, project: Project | null): string | null {
  const template = project?.taskPromptTemplate?.trim();
  if (!template) return null;
  const issue = parseIssueKey(task.title);
  const filled = template
    .replaceAll('{key}', issue?.key ?? '')
    .replaceAll('{title}', task.title)
    // Not in the interface doc, but parseIssueKey already hands it over and a
    // template wanting "ACME-2398: <the descriptive bit>" has no other way to
    // get it. Falls back to the whole title when there is no key.
    .replaceAll('{rest}', issue?.rest || task.title)
    .replaceAll('{branch}', task.branch)
    .trim();
  return filled.length > 0 ? filled : null;
}

function ProjectTabs({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: ProjectTab[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="project-tabs" role="tablist" aria-label="Projects">
      {tabs.map((tab) => {
        const status = tab.blocked > 0 ? 'blocked' : tab.running > 0 ? 'running' : null;
        const badge =
          tab.blocked > 0 ? tab.blocked : tab.running > 0 ? tab.running : tab.tasks.length;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={tab.key === activeKey}
            className="project-tab"
            data-status={status ?? 'quiet'}
            onClick={() => onSelect(tab.key)}
            title={
              tab.blocked > 0
                ? `${tab.label}: ${tab.blocked} waiting on you`
                : (tab.project?.repoPath ?? tab.label)
            }
          >
            {status && <StatusDot status={status} />}
            <span className="project-tab-name">{tab.label}</span>
            <span className="project-tab-count">{badge}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function App() {
  const { tasks, loading, loadError, captureError, projects, contextBySession, refresh, upsertTask, archive } =
    useTasks();

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

  const [rightTab, setRightTab] = useState<RightTab>(() =>
    readStored(
      LS.rightTab,
      (raw) => (raw === 'transcript' || raw === 'files' || raw === 'editor' ? raw : null),
      'transcript',
    ),
  );
  /** Pending file-open, scoped to the task it was requested from. */
  const [openRequest, setOpenRequest] = useState<{ taskId: number; request: OpenFileRequest } | null>(
    null,
  );

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [activeProjectTabKey, setActiveProjectTabKey] = useState<string>(() =>
    readStored(LS.project, (raw) => raw || null, ''),
  );
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  const [startupError, setStartupError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Task | null>(null);
  const [dragging, setDragging] = useState<null | 'sidebar' | 'split'>(null);

  const panesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => store(LS.sidebar, String(Math.round(sidebarWidth))), [sidebarWidth]);
  useEffect(() => store(LS.mode, mode), [mode]);
  useEffect(() => store(LS.orientation, orientation), [orientation]);
  useEffect(() => store(LS.ratio, ratio.toFixed(3)), [ratio]);
  useEffect(() => {
    if (rightTab !== 'editor') store(LS.rightTab, rightTab);
  }, [rightTab]);

  const tabs = useMemo(() => buildTabs(projects, tasks), [projects, tasks]);

  /**
   * One tab is not a tab bar. With a single project the app is exactly what it
   * was before projects existed: no bar, nothing hidden, nothing to switch.
   */
  const showTabs = tabs.length >= 2;

  const activeProjectTab = useMemo(() => {
    if (!showTabs) return null;
    return tabs.find((t) => t.key === activeProjectTabKey) ?? tabs[0] ?? null;
  }, [showTabs, tabs, activeProjectTabKey]);

  const selectTab = useCallback((key: string) => {
    setActiveProjectTabKey(key);
    store(LS.project, key);
  }, []);

  /**
   * Scoped only while the bar is showing. With the bar hidden nothing is
   * filtered, so no task can be concealed by a tab the user cannot see.
   */
  const visibleTasks = useMemo(
    () => (activeProjectTab ? activeProjectTab.tasks : tasks),
    [activeProjectTab, tasks],
  );

  /**
   * What the list is scoped to. With no bar this is the sole project, so the
   * empty state can still name it — which is the actual bug report: creating
   * the first project looked like nothing happened.
   */
  const activeProject = useMemo(
    () => (showTabs ? (activeProjectTab?.project ?? null) : (projects[0] ?? null)),
    [showTabs, activeProjectTab, projects],
  );

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  /**
   * FIRST SPAWN ONLY. A task with a sessionId has already been told this; a
   * re-spawn after a kill or crash must not re-prompt, or the agent starts the
   * work over. That would read as bizarre agent behaviour rather than as a
   * spawn bug, which is exactly why the gate lives here and is stated twice.
   */
  const initialPromptFor = useCallback(
    (task: Task): string | null => {
      if (task.sessionId !== null) return null;
      const project = projects.find((p) => p.id === task.projectId) ?? null;
      return renderPromptTemplate(task, project);
    },
    [projects],
  );

  const select = useCallback((id: number) => {
    setSelectedId(id);
    store(LS.selected, String(id));
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  /**
   * Adopt pre-projects task rows on launch.
   *
   * Idempotent by design -- it only touches `project_id IS NULL` and reuses an
   * existing project for a repo path -- so running it every start is intended.
   * It ends with `emitTasksChanged()`, which the task list is already
   * subscribed to, so the backfilled rows arrive without a second fetch here.
   *
   * A failure is caught but NOT swallowed: if this does not run, new tasks get
   * created without a project, and the first symptom would be somewhere else
   * entirely. It goes in the banner.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await backfillProjectsFromTasks();
        if (!cancelled) setStartupError(null);
      } catch (err) {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setStartupError(
          `Could not assign existing tasks to projects: ${detail}. ` +
            'New tasks may be created without one.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // File-open entry point handed to every renderer via context. Reads the
  // selection through a ref so the context value stays referentially stable --
  // transcript rows subscribe to it and should not re-render on every select.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const openFile = useCallback((request: OpenFileRequest) => {
    const taskId = selectedIdRef.current;
    if (taskId === null) return;
    setOpenRequest({ taskId, request });
    setRightTab('editor');
    // The editor is useless behind a full-width terminal.
    setMode((m) => (m === 'pty' ? 'split' : m));
  }, []);

  const closeEditor = useCallback(() => {
    setOpenRequest(null);
    setRightTab((t) => (t === 'editor' ? 'transcript' : t));
  }, []);

  // Pick something sensible once tasks land: whatever is blocked first, and
  // always something the active tab can actually show.
  useEffect(() => {
    if (loading || visibleTasks.length === 0) return;
    if (selectedId !== null && visibleTasks.some((t) => t.id === selectedId)) return;
    const candidate =
      visibleTasks.find((t) => t.status === 'blocked') ??
      visibleTasks.find((t) => t.status === 'running') ??
      visibleTasks.find((t) => t.status !== 'archived') ??
      visibleTasks[0];
    if (candidate) select(candidate.id);
  }, [loading, visibleTasks, selectedId, select]);

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

  /** The editor only exists for the task its request came from. */
  const editorTask = useMemo(() => {
    if (!openRequest || !selected) return null;
    return openRequest.taskId === selected.id ? selected : null;
  }, [openRequest, selected]);

  // Derived rather than corrected in an effect: switching task while the editor
  // tab is showing falls straight back to the transcript, with no flash.
  const activeTab: RightTab = rightTab === 'editor' && !editorTask ? 'transcript' : rightTab;

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

  const noteFor = (tab: RightTab): string => {
    if (tab === 'files') return selected ? selected.branch : 'no task';
    if (tab === 'editor') return openRequest?.request.path ?? '';
    return selected?.sessionId ?? 'no session yet';
  };

  const banner = loadError ?? startupError ?? captureError;

  return (
    <FileOpenContext.Provider value={openFile}>
    <div className="app" data-dragging={dragging !== null}>
      <Header
        onNewTask={() => setNewTaskOpen(true)}
        onReconcile={() => setReconcileOpen(true)}
        onProjects={() => setProjectsOpen(true)}
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
          {showTabs && activeProjectTab && (
            <ProjectTabs tabs={tabs} activeKey={activeProjectTab.key} onSelect={selectTab} />
          )}
          <TaskList
            tasks={visibleTasks}
            selectedId={selectedId}
            onSelect={select}
            onNew={() => setNewTaskOpen(true)}
            onArchive={(task) => setArchiveTarget(task)}
            onManageProjects={() => setProjectsOpen(true)}
            contextBySession={contextBySession}
            projects={projects}
            activeProject={activeProject}
          />
          {/* Pinned below the list, outside its scroller, so it is on screen
              permanently. The panel carries its own boundary for render
              throws; this one catches a failure to mount at all. */}
          <PaneErrorBoundary label="Usage panel">
            <UsagePanel task={selected} />
          </PaneErrorBoundary>
          <div className="sidebar-foot">
            <span className="sidebar-foot-label">theme</span>
            <ThemeToggle value={themeChoice} onChange={setThemeChoice} />
          </div>
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
                    <Terminal
                      key={task.id}
                      task={task}
                      active={task.id === selectedId}
                      initialPrompt={initialPromptFor(task) ?? undefined}
                    />
                  ))}
                </div>
                {openTasks.length === 0 && (
                  <div className="placeholder">
                    {loading ? (
                      'loading tasks…'
                    ) : tasks.length === 0 ? (
                      <>
                        {/* One <p> per flex line: .placeholder is a column flex
                            container, so a bare inline <span> would break out
                            onto a line of its own mid-sentence. */}
                        <p>Nothing running.</p>
                        <p>
                          A task is cut from a project — a repo Albedo keeps worktrees for — so
                          there has to be one before <span className="placeholder-key">⌘N</span>{' '}
                          has anywhere to go.
                        </p>
                        <button className="btn" onClick={() => setProjectsOpen(true)}>
                          Add a project
                        </button>
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
                <div className="tabs" role="tablist" aria-label="Reading pane">
                  <button
                    role="tab"
                    aria-selected={activeTab === 'transcript'}
                    onClick={() => setRightTab('transcript')}
                  >
                    transcript
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'files'}
                    onClick={() => setRightTab('files')}
                  >
                    files
                  </button>
                  {editorTask && (
                    <button
                      role="tab"
                      aria-selected={activeTab === 'editor'}
                      onClick={() => setRightTab('editor')}
                    >
                      editor
                    </button>
                  )}
                </div>
                <span className="pane-head-note" title={noteFor(activeTab)}>
                  {noteFor(activeTab)}
                </span>
                {activeTab === 'editor' && (
                  <button className="pane-head-close" onClick={closeEditor} title="Close editor">
                    ✕
                  </button>
                )}
              </div>

              {/* All three panels stay mounted so scroll position and editor
                  buffer survive a tab flip; only the task identity resets them. */}
              <div className="pane-body">
                <div className="tabpanel" hidden={activeTab !== 'transcript'}>
                  <PaneErrorBoundary key={`tx-${selected?.id ?? 'none'}`} label="Transcript">
                    <TranscriptPane
                      taskId={selected?.id ?? null}
                      sessionId={selected?.sessionId ?? null}
                    />
                  </PaneErrorBoundary>
                </div>

                <div className="tabpanel" hidden={activeTab !== 'files'}>
                  {selected ? (
                    <PaneErrorBoundary key={`tf-${selected.id}`} label="Touched files">
                      <TouchedFiles task={selected} />
                    </PaneErrorBoundary>
                  ) : (
                    <div className="placeholder">No task selected.</div>
                  )}
                </div>

                <div className="tabpanel" hidden={activeTab !== 'editor'}>
                  {editorTask && (
                    <PaneErrorBoundary key={`ed-${editorTask.id}`} label="Editor">
                      <FileEditor
                        task={editorTask}
                        request={openRequest?.request ?? null}
                        onClose={closeEditor}
                      />
                    </PaneErrorBoundary>
                  )}
                </div>
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

      {/* Archiving is not a status flip: the dialog does `git worktree remove`
          and branch cleanup behind a confirmation. The task row is only marked
          archived once the dialog reports the worktree work succeeded --
          flipping first would strand the worktree, reachable from nothing. */}
      <PaneErrorBoundary label="Projects">
        <ProjectsDialog
          open={projectsOpen}
          onClose={() => setProjectsOpen(false)}
          onChanged={() => void refresh()}
          onCreateTaskIn={(project) => {
            // The dialog already remembers the project it just created as the
            // new-task default, so this only has to switch to its tab and open
            // the dialog.
            selectTab(`p${project.id}`);
            setProjectsOpen(false);
            setNewTaskOpen(true);
          }}
        />
      </PaneErrorBoundary>

      <PaneErrorBoundary label="Archive task">
        <ArchiveTaskDialog
          task={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onArchived={(taskId) => {
            void archive(taskId);
            setArchiveTarget(null);
          }}
        />
      </PaneErrorBoundary>
    </div>
    </FileOpenContext.Provider>
  );
}
