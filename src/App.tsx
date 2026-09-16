import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { OpenFileRequest, Project, Task } from './types';
import { useTheme } from './ui/theme';
import type { ThemeChoice } from './ui/theme';
import useTasks from './ui/useTasks';
import Header from './ui/Header';
import TaskList from './ui/TaskList';
import Subagents from './ui/Subagents';
import { attentionMarks, clearAttention, onAttention, watchFocus, type AttentionKind } from './ui/attention';
import { useShortcuts } from './ui/shortcuts';
import StatusDot from './ui/StatusDot';
import Terminal from './ui/Terminal';
import NewTaskDialog from './ui/NewTaskDialog';
import WorktreeReconcile from './ui/WorktreeReconcile';
import TranscriptPane from './ui/transcript/TranscriptPane';
import ArchiveTaskDialog from './ui/ArchiveTaskDialog';
import TouchedFiles from './ui/TouchedFiles';
import FileEditor from './ui/editor/FileEditor';
import { FileOpenContext, FileTextContext } from './ui/editor/openFile';
import { resolveInWorktree } from './lib/paths';
import UsagePanel from './ui/gauges/UsagePanel';
import ProjectsDialog from './ui/ProjectsDialog';
import SessionBrowser from './ui/SessionBrowser';
import EmptyState from './ui/EmptyState';
import { archiveProject, backfillProjectsFromTasks, listProjects } from './db/projects';
import { listTasks } from './db';
import type { BackfillResult } from './db/projects';
import { repoRootFor } from './git/worktree';
import ImportProjects from './ui/ImportProjects';
import { displayName, wrapForTooltip } from './ui/text';
import { fillPromptTemplate } from './lib/issueKey';
import { grantProjectDirs } from './lib/fsGrants';

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
/**
 * The pinned files column. Narrow by nature — paths, counts, a status chip —
 * which is why it works where a fourth READING pane does not.
 */
const FILES_MIN = 180;
const FILES_MAX = 420;
const FILES_DEFAULT = 240;
/**
 * What the transcript or editor needs beside it to stay worth reading. Below
 * this the column is not viable and falls back to the tab. Measured: at 1440px
 * in split mode the read pane would be 284px, which is not a diff.
 */
const READ_MIN = 420;

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
  filesPinned: 'albedo.shell.filesPinned',
  filesWidth: 'albedo.shell.filesWidth',
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

const DISMISSED_KEY = 'albedo.shell.dismissedNotices';
const HIDDEN_PROJECTS_KEY = 'albedo.shell.hiddenProjects';

function readHiddenProjects(): number[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_PROJECTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

function writeHiddenProjects(ids: number[]): void {
  try {
    window.localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify(ids));
  } catch {
    /* a reappearing tab is not worth throwing over */
  }
}

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(keys: string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys));
  } catch {
    /* a dismissed notice reappearing is not worth throwing over */
  }
}

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
  // Shared with the ProjectsDialog preview on purpose. A preview that drifts
  // from what the agent is actually told is worse than no preview, and two
  // expanders in two files is precisely how that drift happens.
  return fillPromptTemplate(project?.taskPromptTemplate, {
    title: task.title,
    branch: task.branch,
  });
}

function ProjectTabs({
  tabs,
  activeKey,
  onSelect,
  onHide,
  hidden,
  onRestore,
}: {
  tabs: ProjectTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  onHide: (projectId: number) => void;
  hidden: Project[];
  onRestore: (projectId: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menuOpen]);
  // Never offer to hide the last one: that would leave a bar with nothing in
  // it but the restore chip.
  const canHide = tabs.length > 1;
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
            {canHide && tab.project && (
              <span
                className="project-tab-close"
                role="button"
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label} — the project and its worktrees are untouched`}
                onPointerDown={(e) => {
                  // Beat the tab's own click so closing never also selects.
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.project) onHide(tab.project.id);
                }}
              >
                ✕
              </span>
            )}
          </button>
        );
      })}

      {/* Always reachable from where it was closed. Without this the bar can
          become a one-way door -- close a tab, and with the bar gone there is
          nowhere left that knows the project is merely hidden. */}
      {hidden.length > 0 && (
        <div className="project-tabs-restore">
          <button
            className="project-tab project-tab-more"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            title="Closed projects"
          >
            +{hidden.length} closed
          </button>
          {menuOpen && (
            <div
              className="row-menu project-tabs-menu"
              role="menu"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="row-menu-head">Closed — still here, just not shown</div>
              {hidden.map((project) => (
                <button
                  key={project.id}
                  className="row-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRestore(project.id);
                  }}
                >
                  {project.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
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
  /** Files promoted from a tab to a permanent column. Default off. */
  const [filesPinned, setFilesPinned] = useState(() =>
    readStored(LS.filesPinned, (raw) => (raw === '1' ? true : raw === '0' ? false : null), false),
  );
  const [filesWidth, setFilesWidth] = useState(() =>
    readStored(LS.filesWidth, (raw) => clamp(Number(raw) || FILES_DEFAULT, FILES_MIN, FILES_MAX), FILES_DEFAULT),
  );
  /** Live width of the pane row, so viability is measured rather than guessed. */
  const [panesWidth, setPanesWidth] = useState(0);

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /**
   * Resume argv for tasks created in THIS run. A fork lands under a new
   * session id that the task does not yet know, so the args cannot be derived
   * from the row until capture has adopted it.
   */
  const [pendingResume, setPendingResume] = useState<Map<number, string[]>>(() => new Map());
  const [activeProjectTabKey, setActiveProjectTabKey] = useState<string>(() =>
    readStored(LS.project, (raw) => raw || null, ''),
  );
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  const [startupError, setStartupError] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<BackfillResult | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** Notices the user has waved away, so launch housekeeping cannot nag. */
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(readDismissed()));
  /**
   * Closed project tabs. VIEW STATE, not a lifecycle change: the project, its
   * tasks and its worktrees are untouched, exactly like closing a browser tab.
   * Deliberately not conflated with archiving, which touches worktrees and asks
   * for confirmation — this one is only "not right now".
   */
  const [hiddenProjectIds, setHiddenProjectIds] = useState<Set<number>>(
    () => new Set(readHiddenProjects()),
  );
  const [archiveTarget, setArchiveTarget] = useState<Task | null>(null);
  /** Which verb the end-task dialog was opened with. */
  const [endIntent, setEndIntent] = useState<'archive' | 'delete'>('archive');
  const [dragging, setDragging] = useState<null | 'sidebar' | 'split' | 'files'>(null);

  const panesRef = useRef<HTMLDivElement | null>(null);
  const selectTabRef = useRef<((key: string) => void) | null>(null);

  useEffect(() => store(LS.sidebar, String(Math.round(sidebarWidth))), [sidebarWidth]);
  useEffect(() => store(LS.mode, mode), [mode]);
  useEffect(() => store(LS.orientation, orientation), [orientation]);
  useEffect(() => store(LS.ratio, ratio.toFixed(3)), [ratio]);
  useEffect(() => {
    if (rightTab !== 'editor') store(LS.rightTab, rightTab);
  }, [rightTab]);
  useEffect(() => store(LS.filesPinned, filesPinned ? '1' : '0'), [filesPinned]);
  useEffect(() => store(LS.filesWidth, String(Math.round(filesWidth))), [filesWidth]);

  // Measure the pane row, not the read pane: the read pane's width DEPENDS on
  // whether the column is showing, so observing it would feed back on itself.
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPanesWidth(el.clientWidth));
    observer.observe(el);
    setPanesWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const allTabs = useMemo(() => buildTabs(projects, tasks), [projects, tasks]);

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
      writeHiddenProjects([...next]);
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
      writeHiddenProjects([...next]);
      return next;
    });
  }, [tabs, activeProjectTabKey]);

  const restoreProject = useCallback(
    (projectId: number) => {
      setHiddenProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        writeHiddenProjects([...next]);
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
    store(LS.project, key);
  }, []);
  // Restoring selects the restored tab; the ref avoids ordering the two
  // callbacks against each other.
  selectTabRef.current = selectTab;

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
  /* Read by `readFileText`, which is registered once and must not close over
     the task that was selected when it was created. */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  /**
   * FIRST SPAWN ONLY. A task with a sessionId has already been told this; a
   * re-spawn after a kill or crash must not re-prompt, or the agent starts the
   * work over. That would read as bizarre agent behaviour rather than as a
   * spawn bug, which is exactly why the gate lives here and is stated twice.
   */
  /**
   * How this task's `claude` should be started.
   *
   * A task Albedo cut spawns fresh. A RESUMED task — `ownsWorktree === false`
   * with a session id — resumes, and keeps resuming across restarts, which is
   * what makes the feature survive closing the app. Deliberately scoped to
   * not-owned tasks: making every task resume its own session on relaunch is
   * arguably right too, but it is a behaviour change to existing tasks that
   * nobody asked for, so it is a separate decision.
   */
  /**
   * EVERY task with a session id resumes it — not only ones opened from the
   * browser. A cockpit for long-lived sessions whose sessions evaporate on
   * restart is not tracking them; before this, reopening a task started a
   * fresh `claude` and quietly discarded the conversation, and the pane looked
   * perfectly fine while the agent had no idea what it had been doing.
   *
   * `--resume` can legitimately fail (a pruned transcript), which the exit code
   * reports without anything reading the stream. Terminal handles that by
   * offering a fresh session rather than leaving a dead pane.
   */
  const spawnArgsFor = useCallback(
    (task: Task): string[] | undefined => {
      const pending = pendingResume.get(task.id);
      if (pending) return pending;
      if (task.sessionId !== null) return ['--resume', task.sessionId];
      return undefined;
    },
    [pendingResume],
  );

  /**
   * `--name` for this spawn, or undefined to leave the session's name alone.
   *
   * Naming happens exactly where we are CREATING a session:
   *  - a brand new task (no session id yet)
   *  - a fork, which is a new session under a new id — and marked as a fork so
   *    the user can tell it from the original in their own /resume picker
   *
   * Never on a plain re-open, and never on a straight continue from the
   * browser: those sessions already have whatever name their owner gave them,
   * and overwriting it with something Albedo derived would be a quiet mutation
   * of the user's own data.
   */
  const sessionNameFor = useCallback(
    (task: Task): string | undefined => {
      /*
       * Shortened, because this one leaves our app.
       *
       * `--name` surfaces in Claude Code's prompt box, its /resume picker and
       * the terminal title. A task title created from a long prompt is a whole
       * paragraph, and a paragraph-length name degrades the very surfaces this
       * flag was added to improve. The full title stays in the database and on
       * the row; only the label we hand to another program is trimmed.
       */
      const name = displayName(task.title);
      const pending = pendingResume.get(task.id);
      if (pending) return pending.includes('--fork-session') ? `${name} (fork)` : undefined;
      if (task.sessionId === null) return name;
      return undefined;
    },
    [pendingResume],
  );

  /**
   * The user gave up on a failed resume. Drop any stale args so the retry
   * starts clean instead of re-attempting the same dead session id.
   */
  const forgetResume = useCallback((taskId: number) => {
    setPendingResume((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const initialPromptFor = useCallback(
    (task: Task): string | null => {
      if (task.sessionId !== null) return null;
      const project = projects.find((p) => p.id === task.projectId) ?? null;
      return renderPromptTemplate(task, project);
    },
    [projects],
  );

  /**
   * Read a file's current text for the diff view's context expansion.
   *
   * Resolution lives here rather than in the renderer, exactly as
   * `openFile` does: `resolveInWorktree` is the single containment point, and
   * a transcript path must never reach the filesystem any other way. Null for
   * every failure -- no task, outside the worktree, unreadable -- because the
   * caller's only use for it is deciding whether to offer more context.
   */
  const readFileText = useCallback(
    async (path: string): Promise<string | null> => {
      const task = selectedRef.current;
      if (!task) return null;
      try {
        const target = await resolveInWorktree(task.worktreePath, path);
        if (!target) return null;
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        return await readTextFile(target.absolute);
      } catch {
        return null;
      }
    },
    [],
  );

  const select = useCallback((id: number) => {
    setSelectedId(id);
    store(LS.selected, String(id));
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    // Looking at it is what "seen" means; nothing else clears the mark.
    clearAttention(id);
  }, []);

  /*
   * Which tasks are asking for attention, and the window focus that decides
   * whether the ask is a dock bounce or a pulse in the list. See ui/attention.
   */
  const [attention, setAttention] = useState<ReadonlyMap<number, AttentionKind>>(attentionMarks);
  useEffect(() => onAttention(setAttention), []);
  useEffect(() => watchFocus(), []);

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
        // The resolver is injected rather than imported by db/: resolving a
        // repo root shells out to git, and the db layer has no business
        // spawning subprocesses. It is required, not optional-with-a-fallback,
        // because falling back to the raw path IS the bug it exists to fix.
        const result = await backfillProjectsFromTasks(repoRootFor);
        if (cancelled) return;
        setBackfill(result);
        setStartupError(null);

        // Grant the filesystem scope for every directory we may need to read.
        // The static capability only covers ~/.claude/projects and ~/agents; a
        // project pointed anywhere else -- which is the whole point of letting
        // the user choose -- is outside it, and opening a file in it fails with
        // "forbidden path". See src/lib/fsGrants.ts.
        const projects = await listProjects({ includeArchived: true });
        const tasks = await listTasks({ includeArchived: true });
        if (cancelled) return;
        const denied = await grantProjectDirs({
          repoPaths: projects.map((p) => p.repoPath),
          worktreeRoots: projects.map((p) => p.worktreeRoot),
          worktreePaths: tasks.map((t) => t.worktreePath),
        });
        if (!cancelled && denied.length > 0) {
          // Not fatal, but not silent: files in those projects will not open,
          // and a quiet degradation of a core path has bitten this app before.
          setStartupError(
            `Could not grant file access to ${denied.length} project ` +
              `director${denied.length === 1 ? 'y' : 'ies'}: ${denied[0]}. ` +
              'Opening files in those projects will fail.',
          );
        }
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

  /**
   * Put a task on screen. The ONLY supported way to do so.
   *
   * ## THE RULE
   *
   * SELECTING A TASK THAT IS NOT IN THE ACTIVE SCOPE IS A NO-OP UNLESS THE
   * SCOPE MOVES FIRST. The auto-select effect re-picks from the active tab's
   * task list, so a `select()` into a tab that is not showing is immediately
   * undone — and the symptom is the task appearing to vanish, a long way from
   * the cause.
   *
   * That bug shipped three times, in three call sites that each had to
   * remember the ordering: new task, resume, and open-adopted-session. Hence
   * one function rather than a rule people follow. Every path that wants a
   * task on screen goes through here.
   *
   * Order is load-bearing top to bottom:
   *   1. unhide  — a closed tab cannot be selected, and silently failing to
   *                switch brings the same "task vanished" symptom back through
   *                a new door. Same reasoning as unhiding on blocked.
   *   2. scope   — the tab must be active before the selection can survive.
   *   3. select  — now it sticks.
   *   4. reveal  — "focus" means the thing is actually on screen, not merely
   *                selected behind a FILES or EDITOR tab.
   */
  const revealTask = useCallback(
    (task: Task) => {
      const projectId = task.projectId;

      if (projectId !== null && hiddenProjectIds.has(projectId)) {
        setHiddenProjectIds((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          writeHiddenProjects([...next]);
          return next;
        });
      }

      selectTab(projectId !== null ? `p${projectId}` : 'orphans');
      select(task.id);
      setRightTab((t) => (t === 'transcript' ? t : 'transcript'));
    },
    [hiddenProjectIds, selectTab, select],
  );

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

  /**
   * Is there room for the column, right now?
   *
   * The preference is NOT changed by the answer. A pinned column that stops
   * fitting falls back to the tab and comes back when the window allows, which
   * is the difference between a layout that adapts and a preference that
   * evaporates on resize and never returns.
   */
  const readAreaWidth =
    mode === 'pty'
      ? 0
      : mode === 'split' && orientation === 'row'
        ? panesWidth * (1 - ratio)
        : panesWidth;
  const filesColumnFits = readAreaWidth >= filesWidth + READ_MIN;
  const filesColumnShown = filesPinned && mode !== 'pty' && filesColumnFits;

  // Derived rather than corrected in an effect: switching task while the editor
  // tab is showing falls straight back to the transcript, with no flash.
  // A pinned column also takes FILES out of the tab strip -- a tab that shows
  // you what you are already looking at is noise.
  const activeTab: RightTab =
    rightTab === 'editor' && !editorTask
      ? 'transcript'
      : rightTab === 'files' && filesColumnShown
        ? 'transcript'
        : rightTab;

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

  const startFilesDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = panesRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging('files');
    const move = (ev: PointerEvent) =>
      setFilesWidth(clamp(rect.right - ev.clientX, FILES_MIN, FILES_MAX));
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- shortcuts -----------------------------------------------------------

  /*
   * Cycles only the tabs actually on the strip. `files` leaves it when the
   * column is pinned and fits, and `editor` is there only with a file open --
   * so a fixed list would step onto a tab that is not rendered and land the
   * user on a silently-corrected `transcript`, twice in a row.
   */
  const readingTabs = useMemo<RightTab[]>(
    () => [
      'transcript' as const,
      ...(filesColumnShown ? [] : (['files'] as const)),
      ...(editorTask ? (['editor'] as const) : []),
    ],
    [filesColumnShown, editorTask],
  );

  const stepReadingTab = useCallback(
    (delta: number) => {
      const tabs = readingTabs;
      if (tabs.length < 2) return;
      const at = tabs.indexOf(activeTab);
      const next = tabs[(((at === -1 ? 0 : at) + delta) % tabs.length + tabs.length) % tabs.length];
      if (next) setRightTab(next);
    },
    [readingTabs, activeTab],
  );

  useShortcuts({
    'mod+\\': () => setMode((m) => (m === 'pty' ? 'split' : m === 'split' ? 'transcript' : 'pty')),
    // Exempt while typing: ⌘← / ⌘→ are start/end of line in every macOS text
    // field, and this app has a composer, a title input and a code editor.
    'mod+arrowleft': { run: () => stepReadingTab(-1), whenTyping: 'ignore' },
    'mod+arrowright': { run: () => stepReadingTab(1), whenTyping: 'ignore' },
  });

  // --- render --------------------------------------------------------------

  const showPty = mode !== 'transcript';
  const showTranscript = mode !== 'pty';
  const split = mode === 'split';

  const primaryStyle = split
    ? { flex: `0 0 ${(ratio * 100).toFixed(2)}%` }
    : { flex: '1 1 auto' };
  const secondaryStyle = { flex: '1 1 0' };

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selected?.projectId) ?? null,
    [projects, selected],
  );

  /** The pane is showing work from a project the sidebar is not scoped to. */
  const selectedProjectIsForeign =
    showTabs && selectedProject !== null && selectedProject.id !== activeProject?.id;

  const noteFor = (tab: RightTab): string => {
    if (tab === 'files') return selected ? selected.branch : 'no task';
    if (tab === 'editor') return openRequest?.request.path ?? '';
    return selected?.sessionId ?? 'no session yet';
  };

  const banner = loadError ?? startupError ?? captureError;

  /**
   * Launch housekeeping, deliberately quiet.
   *
   * A user opening Albedo to get to work should not be interrupted by a modal
   * about their database. These are one-line offers they can ignore forever,
   * and dismissing one is remembered.
   */
  const unclaimed = (backfill?.unclaimed ?? []).filter((r) => !dismissed.has(`repo:${r.repoRoot}`));
  const worktreeProjects = (backfill?.worktreeProjects ?? []).filter(
    (f) => !dismissed.has(`wt:${f.project.id}`),
  );

  const dismiss = (key: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      writeDismissed([...next]);
      return next;
    });
  };

  return (
    <FileOpenContext.Provider value={openFile}>
    <FileTextContext.Provider value={readFileText}>
    <div className="app" data-dragging={dragging !== null}>
      <Header
        onReconcile={() => setReconcileOpen(true)}
        onProjects={() => setProjectsOpen(true)}
        onSessions={() => setSessionsOpen(true)}
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

      {/* Detection, never correction: a project whose root is another
          project's repo_path IS a linked worktree of it -- git says so. But
          merging or deleting a row the user created, with the wrong survivor
          picked automatically, costs far more to undo than the duplicate costs
          to live with. So: say what it is, offer the reversible action. */}
      {worktreeProjects.map((finding) => (
        <div className="notice" key={`wt-${finding.project.id}`}>
          <span className="notice-text">
            <strong>{finding.project.name}</strong> looks like a worktree of{' '}
            <strong>{finding.parent.name}</strong>. Archiving it re-associates its tasks.
          </span>
          <button
            className="btn"
            onClick={() => {
              const id = finding.project.id;
              dismiss(`wt:${id}`);
              void archiveProject(id)
                .then(() => refresh())
                .catch(() => {});
            }}
          >
            Archive it
          </button>
          <button className="btn btn-ghost" onClick={() => dismiss(`wt:${finding.project.id}`)}>
            Dismiss
          </button>
        </div>
      ))}

      {unclaimed.length > 0 && (
        <div className="notice">
          <span className="notice-text">
            {unclaimed.length} repositor{unclaimed.length === 1 ? 'y' : 'ies'} in your history{' '}
            {unclaimed.length === 1 ? 'has' : 'have'} no project yet.
          </span>
          <button className="btn" onClick={() => setImportOpen(true)}>
            Review
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => unclaimed.forEach((r) => dismiss(`repo:${r.repoRoot}`))}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="app-body">
        <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
          {/* Not gated on activeProjectTab: hide EVERY project and there is no
              active tab, and gating here would remove the restore chip along
              with the tabs — the one-way door this feature must not become. */}
          {showTabs && (
            <ProjectTabs
              tabs={tabs}
              activeKey={activeProjectTab?.key ?? ''}
              onSelect={selectTab}
              onHide={hideProject}
              hidden={hiddenProjects}
              onRestore={restoreProject}
            />
          )}
          <TaskList
            tasks={visibleTasks}
            selectedId={selectedId}
            onSelect={select}
            onNew={() => setNewTaskOpen(true)}
            onArchive={(task) => {
              setEndIntent('archive');
              setArchiveTarget(task);
            }}
            onDelete={(task) => {
              setEndIntent('delete');
              setArchiveTarget(task);
            }}
            onManageProjects={() => setProjectsOpen(true)}
            contextBySession={contextBySession}
            attention={attention}
            projects={projects}
            activeProject={activeProject}
            nameProject={!showTabs}
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
            {/* These panes follow the SELECTED TASK, not the active tab, so
                the task on screen can belong to a different project than the
                sidebar is scoped to. The two can legitimately disagree, and
                when they do that is precisely when it needs saying. */}
            <div className="main-ident">
              {selected ? (
                <>
                  {selectedProject && (
                    <>
                      <span
                        className="main-ident-project"
                        data-foreign={selectedProjectIsForeign}
                        title={
                          selectedProjectIsForeign
                            ? `This task is in ${selectedProject.name}, not the project the list is showing`
                            : selectedProject.repoPath
                        }
                      >
                        {selectedProject.name}
                      </span>
                      <span className="task-sep">/</span>
                    </>
                  )}
                  <span className="main-ident-title" title={wrapForTooltip(selected.title)}>
                    {selected.title}
                  </span>
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
                  {/* Processes, not conversations. "session" was doing both
                      jobs across the app, which is how "no live session" came
                      to read as "your conversation is gone". */}
                  {openTasks.length} terminal{openTasks.length === 1 ? '' : 's'} alive
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
                      spawnArgs={spawnArgsFor(task)}
                      onFreshStart={() => forgetResume(task.id)}
                      sessionName={sessionNameFor(task)}
                    />
                  ))}
                </div>
                {openTasks.length === 0 && (
                  <div className="placeholder">
                    {loading ? (
                      <p>loading tasks…</p>
                    ) : visibleTasks.length === 0 ? (
                      /* Same decision as the sidebar, from the same module.
                         This site previously keyed off tasks.length with no
                         reference to projects at all, which is how it kept
                         offering "Add a project" to someone who had one. */
                      <EmptyState
                        projectCount={projects.length}
                        activeProject={activeProject}
                        onAddProject={() => setProjectsOpen(true)}
                        onNewTask={() => setNewTaskOpen(true)}
                        variant="pane"
                      />
                    ) : (
                      <p>Pick a task to attach a terminal.</p>
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

            {/* The read area holds the transcript/editor AND the pinned files
                column, so the column sits beside them rather than inside the
                tabbed body — and so the split ratio still divides pty from
                "everything you read", which is what the user is dragging. */}
            <div className="read-area" style={secondaryStyle} hidden={!showTranscript}>
            <section className="pane pane-transcript">
              <div className="pane-head">
                <div className="tabs" role="tablist" aria-label="Reading pane">
                  <button
                    role="tab"
                    aria-selected={activeTab === 'transcript'}
                    onClick={() => setRightTab('transcript')}
                  >
                    transcript
                  </button>
                  {!filesColumnShown && (
                    <button
                      role="tab"
                      aria-selected={activeTab === 'files'}
                      onClick={() => setRightTab('files')}
                    >
                      files
                      {/* Pinned but not fitting: say so rather than letting the
                          preference look like it did nothing. */}
                      {filesPinned && <span className="tab-pin-hint" title="Pinned as a column — not enough room at this width, so it is a tab for now">·</span>}
                    </button>
                  )}
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
                {/* Labelled, not a bare ⇥. This is a preference that changes
                    the whole reading layout and persists across restarts, and
                    as a lone glyph behind a native tooltip nobody found it --
                    it was asked for as a missing feature while already built.
                    `aria-pressed` carries the state; the word carries what it
                    does. */}
                {!filesColumnShown && (
                  <button
                    className="pane-head-pin"
                    data-on={filesPinned}
                    onClick={() => setFilesPinned((v) => !v)}
                    title={
                      filesPinned
                        ? 'Files are pinned as a column; unpin to keep them as a tab'
                        : 'Keep files always visible as a column beside the transcript'
                    }
                    aria-pressed={filesPinned}
                  >
                    ⇥ column
                  </button>
                )}
              </div>

              {/* All three panels stay mounted so scroll position and editor
                  buffer survive a tab flip; only the task identity resets them. */}
              <div className="pane-body">
                <div className="tabpanel" hidden={activeTab !== 'transcript'}>
                  {/* Above the transcript, and only while something is live:
                      when a session fans out the transcript itself goes quiet,
                      which is exactly when you need to know what is running. */}
                  <PaneErrorBoundary key={`sa-${selected?.id ?? 'none'}`} label="Subagents">
                    <Subagents sessionId={selected?.sessionId ?? null} />
                  </PaneErrorBoundary>
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

            {filesColumnShown && (
              <>
                <div
                  className="splitter splitter-v"
                  data-dragging={dragging === 'files'}
                  onPointerDown={startFilesDrag}
                  role="separator"
                  aria-orientation="vertical"
                />
                <section
                  className="pane pane-files"
                  style={{ flex: `0 0 ${Math.round(filesWidth)}px` }}
                >
                  <div className="pane-head">
                    <span>files</span>
                    <span className="pane-head-note">{selected?.branch ?? ''}</span>
                    <button
                      className="pane-head-pin"
                      data-on
                      onClick={() => setFilesPinned(false)}
                      title="Unpin — put files back in the tab strip"
                      aria-pressed
                    >
                      ⇥ column
                    </button>
                  </div>
                  <div className="pane-body">
                    {selected ? (
                      <PaneErrorBoundary key={`fc-${selected.id}`} label="Touched files">
                        <TouchedFiles task={selected} />
                      </PaneErrorBoundary>
                    ) : (
                      <div className="placeholder">
                        <p>No task selected.</p>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
            </div>
          </div>
        </main>
      </div>

      <PaneErrorBoundary label="New task">
        <NewTaskDialog
          open={newTaskOpen}
          onClose={() => setNewTaskOpen(false)}
          onCreated={(task: Task) => {
            upsertTask(task);
            // Switch scope BEFORE selecting: the auto-select effect re-picks
            // from the active tab's list, so selecting into a tab that is not
            // showing gets immediately undone.
            revealTask(task);
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
          onUnhideProject={(id) =>
            // The hidden set lives in React state, read from localStorage once
            // at mount — a write to the key alone would not bring the tab back
            // until a relaunch.
            setHiddenProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              writeHiddenProjects([...next]);
              return next;
            })
          }
          onChanged={(created) => {
            void refresh();
            // Follow the project that was just made. Without this the new tab
            // appears but stays in the background, and a task created into it
            // is filtered out of the active tab and silently deselected.
            if (created) selectTab(`p${created.id}`);
          }}
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

      <PaneErrorBoundary label="Import projects">
        <ImportProjects
          open={importOpen}
          repos={unclaimed}
          onClose={() => setImportOpen(false)}
          onImported={(created) => {
            // Imported repos are claimed now; stop offering them.
            for (const p of created) dismiss(`repo:${p.repoPath}`);
            void refresh();
            const first = created[0];
            if (first) selectTab(`p${first.id}`);
          }}
        />
      </PaneErrorBoundary>

      <PaneErrorBoundary label="Past sessions">
        <SessionBrowser
          open={sessionsOpen}
          onClose={() => setSessionsOpen(false)}
          onOpenTask={(taskId) => {
            const task = tasks.find((t) => t.id === taskId);
            if (task) revealTask(task);
          }}
          onResumed={(task, args) => {
            setPendingResume((prev) => {
              const next = new Map(prev);
              next.set(task.id, args);
              return next;
            });
            upsertTask(task);
            // Continue AND fork both land here, and both carry a projectId
            // resolved from the session's repo root — frequently a different
            // project than the active tab, since reaching sessions from
            // anywhere in your history is the point of the browser.
            revealTask(task);
            void refresh();
          }}
        />
      </PaneErrorBoundary>

      <PaneErrorBoundary label="Archive task">
        <ArchiveTaskDialog
          task={archiveTarget}
          intent={endIntent}
          onClose={() => setArchiveTarget(null)}
          onArchived={(taskId) => {
            void archive(taskId);
            setArchiveTarget(null);
          }}
          onDeleted={(taskId) => {
            // Same ordering discipline as onArchived: the row only leaves the
            // list once the destructive work has actually completed. The task
            // is already gone from the db by here, so this just resyncs.
            forgetResume(taskId);
            setArchiveTarget(null);
            void refresh();
          }}
        />
      </PaneErrorBoundary>
    </div>
    </FileTextContext.Provider>
    </FileOpenContext.Provider>
  );
}
