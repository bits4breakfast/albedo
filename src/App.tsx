import { applyZoom, stepZoom, storedZoom } from './ui/zoom';
import { idCodec, KEYS, numberListCodec, readPersisted, writePersisted } from './ui/persisted';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpenFileRequest, Project, Task } from './types';
import { useTheme } from './ui/theme';
import useTasks from './ui/useTasks';
import useLayout, { type RightTab } from './ui/app/useLayout';
import useDialogs from './ui/app/useDialogs';
import useLaunchNotices from './ui/app/useLaunchNotices';
import useProjectTabs from './ui/app/useProjectTabs';
import ProjectTabs from './ui/app/ProjectTabs';
import PaneErrorBoundary from './ui/app/PaneErrorBoundary';
import { useQuitGuard } from './ui/quitGuard';
import Header from './ui/Header';
import TaskList from './ui/TaskList';
import { createPrPrompt, pushPrompt } from './ui/gitPrompts';
import { sendPrompt } from './ui/sendPrompt';
import Subagents from './ui/Subagents';
import { announcementFor, attentionMarks, clearAttention, onAttention, watchFocus, type AttentionKind } from './ui/attention';
import { useDoubleShift, useShortcuts } from './ui/shortcuts';
import { stepProjectTab } from './ui/projectStep';
import ShortcutsHelp from './ui/ShortcutsHelp';
import QuickOpen from './ui/QuickOpen';
import FindInFiles from './ui/FindInFiles';
import { worktreeRelative, type QuickOpenMode } from './ui/quickOpenModel';
import Terminal, { focusPty } from './ui/Terminal';
import ModelPicker from './ui/ModelPicker';
import { BranchIcon, ChatIcon, FolderIcon, homeRelative } from './ui/icons';
import OverflowMenu from './ui/OverflowMenu';
import NewTaskDialog from './ui/NewTaskDialog';
import ShellTerminal from './ui/ShellTerminal';
import WorktreeReconcile from './ui/WorktreeReconcile';
import TranscriptPane from './ui/transcript/TranscriptPane';
import ArchiveTaskDialog from './ui/ArchiveTaskDialog';
import { PrBadge } from './ui/PrBadge';
import TouchedFiles from './ui/TouchedFiles';
import EditorTabs, { forgetEditorTabs } from './ui/editor/EditorTabs';
import { onComposerInsert, requestAttach } from './ui/transcript/composerBridge';
import { FileOpenContext, FileTextContext } from './ui/editor/openFile';
import { resolveInWorktree } from './lib/paths';
import StatusBar from './ui/StatusBar';
import { ContextClear } from './ui/ClearContextButton';
import ProjectsDialog from './ui/ProjectsDialog';
import SessionBrowser from './ui/SessionBrowser';
import EmptyState from './ui/EmptyState';
import { archiveProject } from './db/projects';
import { deleteTask } from './db';
import { endTaskEvents } from './capture/hookEvents';
import { composeWorktreePath, listBranches, listWorktrees, probePath, unmergedCommits } from './git/worktree';
import ImportProjects from './ui/ImportProjects';
import MoveTaskDialog from './ui/MoveTaskDialog';
import MoreGlyph from './ui/MoreGlyph';
import { normalizePath } from './git/reconcile';
import PanelToggle from './ui/PanelToggle';
import { displayName, wrapForTooltip } from './ui/text';
import { fillPromptTemplate } from './lib/issueKey';
import {
  buildFollowUp,
  followUpTaken,
  followUpTitle,
  freeFollowUpTitle,
} from './ui/followUp';
import { useMergeNotices } from './ui/mergeNotice';
import { getPrStatus } from './gh/prStore';
import { fetchPrStatus } from './gh/gh';
import type { PrStatus } from './gh/prStatus';

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

/**
 * Build the initial prompt for a task's first session.
 *
 * Opt-in by design: an empty or absent template yields null, and null means no
 * argv prompt at all. Silently prompting an agent the user has just launched
 * is a side effect they did not ask for, so the default is to say nothing.
 */
function renderPromptTemplate(task: Task, project: Project | null): string | null {
  // The template is written for work on a branch ("pick up {key} on
  // {branch}"); sent to a chat it would contradict the chat's own
  // instruction not to change anything. A chat starts with no prompt.
  if (task.kind === 'chat') return null;
  // Shared with the ProjectsDialog preview on purpose. A preview that drifts
  // from what the agent is actually told is worse than no preview, and two
  // expanders in two files is precisely how that drift happens.
  return fillPromptTemplate(project?.taskPromptTemplate, {
    title: task.title,
    branch: task.branch,
  });
}

// ---------------------------------------------------------------------------

export default function App() {
  const { tasks, signals, loading, loadError, captureError, projects, contextBySession, refresh, upsertTask, archive } =
    useTasks();

  const [selectedId, setSelectedId] = useState<number | null>(() =>
    readPersisted(KEYS.selectedTask, idCodec, null),
  );
  /** Tasks whose terminal has been brought up. Kept alive until the task goes. */
  const [openIds, setOpenIds] = useState<number[]>([]);

  const {
    sidebarWidth,
    mode,
    setMode,
    orientation,
    setOrientation,
    ratio,
    rightTab,
    setRightTab,
    filesPinned,
    setFilesPinned,
    filesWidth,
    filesColumnShown,
    dragging,
    shellOpen,
    setShellOpen,
    shellHeight,
    mainRef,
    panesRef,
    startSidebarDrag,
    startSplitDrag,
    startFilesDrag,
    startShellDrag,
  } = useLayout();
  const {
    newTaskOpen,
    setNewTaskOpen,
    newTaskPrefill,
    setNewTaskPrefill,
    reconcileOpen,
    setReconcileOpen,
    projectsOpen,
    setProjectsOpen,
    shortcutsOpen,
    setShortcutsOpen,
    sessionsOpen,
    setSessionsOpen,
    importOpen,
    setImportOpen,
    archiveTarget,
    setArchiveTarget,
    moveTarget,
    setMoveTarget,
    endIntent,
    setEndIntent,
  } = useDialogs();

  /** Pending file-open, scoped to the task it was requested from. */
  const [openRequest, setOpenRequest] = useState<{ taskId: number; request: OpenFileRequest } | null>(
    null,
  );
  /**
   * The prompt a follow-up was created with, for its first spawn. In memory
   * on purpose: the session starts the moment the task is created, and a
   * prompt for a session that has already started is never sent again.
   */
  const [promptOverrides, setPromptOverrides] = useState<Map<number, string>>(() => new Map());
  /** Go to File / Class / Symbol / Search Everywhere; null when closed. */
  const [quickOpen, setQuickOpen] = useState<QuickOpenMode | null>(null);
  /**
   * Resume argv for tasks created in THIS run. A fork lands under a new
   * session id that the task does not yet know, so the args cannot be derived
   * from the row until capture has adopted it.
   */
  const [pendingResume, setPendingResume] = useState<Map<number, string[]>>(() => new Map());
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  /** Tasks whose terminal is down while they move: unmounting ends the session. */
  const [stopped, setStopped] = useState<ReadonlySet<number>>(() => new Set());
  const [shellProjectIds, setShellProjectIds] = useState<number[]>([]);

  const {
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
  } = useProjectTabs(projects, tasks);

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
   * With no task selected, Go to File and Find in Files search the active
   * project's main checkout -- the repo folder itself -- and open what they
   * find read-only. This stands in for a task so the search dialogs and the
   * editor need no second code path. Its id is negative, so it can never meet
   * a real task's id, and it is never written anywhere: the editor is
   * read-only for it (the folder is the user's real repo, not a worktree).
   */
  const browseTask = useMemo<Task | null>(() => {
    if (selected !== null || activeProject === null || !activeProject.repoPath) return null;
    return {
      id: -activeProject.id,
      title: activeProject.name,
      projectId: activeProject.id,
      repoPath: activeProject.repoPath,
      baseBranch: '',
      branch: '',
      worktreePath: activeProject.repoPath,
      sessionId: null,
      ownsWorktree: false,
      createdBranch: false,
      // Never spawned and never stored: only searched and read.
      kind: 'work',
      status: 'idle',
      createdAt: 0,
      lastActivityAt: null,
    };
  }, [selected, activeProject]);
  /** Whose main checkout the shell drawer is in: the project the list shows. */
  const shellProject = activeProject?.repoPath ? activeProject : null;
  // Spawned lazily, per project, the first time the drawer shows it.
  useEffect(() => {
    if (!shellOpen || !shellProject) return;
    const id = shellProject.id;
    setShellProjectIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [shellOpen, shellProject]);
  const browseTaskRef = useRef(browseTask);
  browseTaskRef.current = browseTask;
  /** The folder the search dialogs work in: the task's worktree, else the checkout. */
  const searchTask = selected ?? browseTask;
  const searchScopeLabel = selected === null && browseTask ? `${browseTask.title} · main checkout` : null;
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
   *
   * Terminal decides the resume itself, from the task's LIVE session id
   * (ui/sessionSpawn.ts): only History's one-off args are passed down here.
   */
  const spawnArgsFor = useCallback(
    (task: Task): string[] | undefined => pendingResume.get(task.id),
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
      // A follow-up's prompt was written in the dialog; empty is "none".
      const override = promptOverrides.get(task.id);
      if (override !== undefined) return override || null;
      const project = projects.find((p) => p.id === task.projectId) ?? null;
      return renderPromptTemplate(task, project);
    },
    [projects, promptOverrides],
  );

  /**
   * "Follow-up…": open the new-task dialog prefilled. Never creates anything.
   *
   * The title is chosen first, against what is actually there -- branches,
   * worktrees, task paths, the disk -- so the usual case, right after a merge
   * with the shipped worktree still in place, opens on a name that will work.
   * All local and quick; a failure to look only means the default title.
   *
   * A live task's PR is in the store already. An archived task's is not
   * polled, so it is fetched once here; the dialog opens at once with the
   * branch-only prompt and swaps in the PR version if the lookup finds a merged
   * PR before the user has touched the prompt.
   */
  const followUpSeq = useRef(0);
  const followUpCtx = useRef({ tasks, projects });
  followUpCtx.current = { tasks, projects };
  const openFollowUp = useCallback(async (task: Task, known?: PrStatus | null) => {
    const seq = ++followUpSeq.current;
    const { tasks: all, projects: ps } = followUpCtx.current;
    const project = ps.find((p) => p.id === task.projectId) ?? null;
    let title = followUpTitle(task);
    if (project) {
      try {
        const [home, branches, worktrees] = await Promise.all([
          import('@tauri-apps/api/path').then((m) => m.homeDir()).catch(() => ''),
          listBranches(project.repoPath).then((b) => b.all).catch(() => [] as string[]),
          listWorktrees(project.repoPath).catch(() => []),
        ]);
        title = await freeFollowUpTitle(
          task,
          followUpTaken({
            branches: [...branches, ...all.map((t) => t.branch)],
            paths: [...worktrees.map((w) => w.path), ...all.map((t) => t.worktreePath)],
            pathFor: (dir) => composeWorktreePath(project.worktreeRoot, dir, home),
            exists: probePath,
          }),
        );
      } catch {
        /* keep the default; the dialog still shows git's refusal verbatim */
      }
    }
    if (seq !== followUpSeq.current) return;
    const pr = known ?? getPrStatus(task.id) ?? null;
    const lookUp = task.status === 'archived' && pr === null;
    setNewTaskPrefill({ ...buildFollowUp(task, pr, title), pending: lookUp });
    setNewTaskOpen(true);
    if (!lookUp) return;
    const found = await fetchPrStatus(task).catch(() => null);
    if (seq !== followUpSeq.current) return;
    setNewTaskPrefill(buildFollowUp(task, found, title));
  }, []);


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

  // select() is stable, so it reads the tabs through a ref rather than closing
  // over them.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const select = useCallback((id: number) => {
    // The scope moves first. A task in another project's tab would otherwise be
    // selected behind a list that does not show it, which reads as nothing
    // happening. Only a visible tab can take the scope; a hidden one is the
    // user's choice and is left alone.
    const home = tabsRef.current.find((t) => t.tasks.some((task) => task.id === id));
    if (home) selectTabRef.current?.(home.key);
    setSelectedId(id);
    writePersisted(KEYS.selectedTask, idCodec, id);
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

  // One polite live region for the transitions the dock bounce and row pulse
  // only show. Titles come off a ref so a task rename does not re-announce.
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef<ReadonlyMap<number, AttentionKind>>(attention);
  const tasksForAnnounceRef = useRef(tasks);
  tasksForAnnounceRef.current = tasks;
  useEffect(() => {
    const text = announcementFor(
      announcedRef.current,
      attention,
      (id) => tasksForAnnounceRef.current.find((t) => t.id === id)?.title ?? null,
    );
    announcedRef.current = attention;
    setAnnouncement(text);
  }, [attention]);
  useEffect(() => watchFocus(), []);
  useMergeNotices(tasks);

  const { startupError, unclaimed, worktreeProjects, dismiss } = useLaunchNotices();

  // File-open entry point handed to every renderer via context. Reads the
  // selection through a ref so the context value stays referentially stable --
  // transcript rows subscribe to it and should not re-render on every select.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const openFile = useCallback((request: OpenFileRequest) => {
    const taskId = selectedIdRef.current ?? browseTaskRef.current?.id ?? null;
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
          writePersisted(KEYS.hiddenProjects, numberListCodec, [...next]);
          return next;
        });
      }

      selectTab(projectId !== null ? `p${projectId}` : 'orphans');
      select(task.id);
      setRightTab((t) => (t === 'transcript' ? t : 'transcript'));
    },
    [hiddenProjectIds, selectTab, select],
  );

  /** Close the editor and every tab in it (the pane's ✕, or the last tab closing). */
  const openRequestRef = useRef(openRequest);
  openRequestRef.current = openRequest;
  const closeEditor = useCallback(() => {
    const open = openRequestRef.current;
    if (open) forgetEditorTabs(open.taskId);
    setOpenRequest(null);
    setRightTab((t) => (t === 'editor' ? 'transcript' : t));
  }, []);
  // Text handed to the composer from elsewhere (review comments): show the
  // transcript, where the composer is, the way opening a file shows the editor.
  useEffect(
    () =>
      onComposerInsert(() => {
        setRightTab('transcript');
        setMode((m) => (m === 'pty' ? 'split' : m));
      }),
    [],
  );

  /** Bumped by ⌘W: the editor closes its active tab. */
  const [editorCloseSignal, setEditorCloseSignal] = useState(0);
  /** The active tab's file, for the files list and Quick Open. */
  const [editorActivePath, setEditorActivePath] = useState<string | null>(null);

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

  // A selection restored from the last run is shown but was never opened, so it
  // had no terminal and the message box could not send to it. Selecting by
  // click opens the task; a restored selection must too.
  useEffect(() => {
    if (selectedId === null || loading) return;
    if (!tasks.some((t) => t.id === selectedId && t.status !== 'archived')) return;
    setOpenIds((prev) => (prev.includes(selectedId) ? prev : [...prev, selectedId]));
  }, [selectedId, tasks, loading]);

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
    if (!openRequest) return null;
    if (selected) return openRequest.taskId === selected.id ? selected : null;
    return browseTask && openRequest.taskId === browseTask.id ? browseTask : null;
  }, [openRequest, selected, browseTask]);

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

  /**
   * The Editor tab is on screen. Its head row then carries the file tabs, so
   * the PTY / Split / Transcript switch steps aside: on the Editor tab its
   * "Transcript" was the pane tab's word a second time.
   */
  const editorShowing = mode !== 'pty' && selected !== null && activeTab === 'editor';

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

  // ⌘Q and the window's close button ask first while tasks are busy.
  useQuitGuard(tasks);

  // ⌘W. The native menu owns the shortcut (see src-tauri/src/lib.rs) and tells
  // us rather than closing the window, which would quit the app and every live
  // terminal in it. It closes an open file, and otherwise does nothing.
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editorTask !== null;
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void listen('albedo://close-tab', () => {
      if (editorOpenRef.current) setEditorCloseSignal((n) => n + 1);
    })
      .then((un) => {
        if (gone) un();
        else off = un;
      })
      .catch((err) => console.warn('[menu] close shortcut unavailable', err));
    return () => {
      gone = true;
      off?.();
    };
  }, []);

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

  // Text size (HIG: macOS has no Dynamic Type, so the app offers its own).
  const zoomRef = useRef(storedZoom());
  useEffect(() => {
    if (zoomRef.current !== 1) void applyZoom(zoomRef.current);
  }, []);
  const zoomTo = (z: number) => {
    zoomRef.current = z;
    void applyZoom(z);
  };

  /**
   * Open the palette in a mode, or close it if it is already showing that mode.
   * Pressing another mode's keys while it is open switches mode and keeps the
   * query. Without a task it searches the active project's main checkout (see
   * browseTask); with neither there is nothing to search. Never on top of
   * another dialog, which would leave two modals fighting for focus.
   */
  const quickOpenRef = useRef(quickOpen);
  quickOpenRef.current = quickOpen;
  const toggleQuickOpen = useCallback((next: QuickOpenMode) => {
    if (!selectedRef.current && !browseTaskRef.current) return;
    const current = quickOpenRef.current;
    if (current === null && document.querySelector('[aria-modal="true"]') !== null) return;
    setQuickOpen(current === next ? null : next);
  }, []);
  const closeQuickOpen = useCallback(() => setQuickOpen(null), []);
  useDoubleShift(() => toggleQuickOpen('all'));

  /** Find in Files (⇧⌘F): same guards as the palette -- a folder, and no other modal. */
  const [findOpen, setFindOpen] = useState(false);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const toggleFind = useCallback(() => {
    if (!selectedRef.current && !browseTaskRef.current) return;
    if (!findOpenRef.current && document.querySelector('[aria-modal="true"]') !== null) return;
    setFindOpen((o) => !o);
  }, []);
  const closeFind = useCallback(() => setFindOpen(false), []);

  /** The editor's file, worktree-relative, so the palette can rank it first. */
  const editorFile = useMemo(
    () => (editorTask && editorActivePath ? worktreeRelative(editorTask.worktreePath, editorActivePath) : null),
    [editorTask, editorActivePath],
  );

  /**
   * ⇧⌘P: what the Files pane's Push does, for the selected task -- the same
   * prompt, through the same path (submitted on an idle session, otherwise
   * left in the message box). The message box lives in the transcript, so in
   * terminal-only mode a busy task gets the split view and a second try.
   */
  const pushSelected = async () => {
    const task = selected;
    // A chat has no branch to push, and the Files pane offers no Push for it.
    if (!task || task.status === 'archived' || task.kind === 'chat') return;
    // As the Files pane: on no branch there is nothing to push, and pushing a
    // stale detached copy could overwrite the branch with old commits.
    const remote = await unmergedCommits(task.worktreePath, task.baseBranch).catch(() => null);
    if (remote?.detached) {
      console.warn('[push] HEAD is detached in', task.worktreePath, '- nothing to push');
      return;
    }
    const text = pushPrompt(task);
    if ((await sendPrompt(task, text)) !== 'failed') return;
    setMode((m) => (m === 'pty' ? 'split' : m));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    if ((await sendPrompt(task, text)) === 'failed') {
      console.warn('[push] no live session or message box for task', task.id);
    }
  };

  const stepProject = (delta: number) => {
    if (!showTabs) return;
    const key = stepProjectTab(tabs.map((t) => t.key), activeProjectTab?.key ?? null, delta);
    if (key) selectTab(key);
  };

  useShortcuts({
    // PhpStorm's keymap. Live while typing: nothing in a text field, the
    // terminal included, binds ⌘O (Ctrl+O is left alone -- see shortcuts.ts).
    'mod+shift+o': () => toggleQuickOpen('file'),
    'mod+o': () => toggleQuickOpen('class'),
    'mod+alt+o': () => toggleQuickOpen('symbol'),
    'mod+shift+f': toggleFind,
    'mod+shift+p': () => void pushSelected(),
    // The message box is in the transcript: show it, then ask it to attach.
    'mod+u': () => {
      if (!selected) return;
      const id = selected.id;
      setRightTab('transcript');
      setMode((m) => (m === 'pty' ? 'split' : m));
      if (!requestAttach(id)) window.setTimeout(() => requestAttach(id), 150);
    },
    'alt+f12': () => setShellOpen((o) => !o),
    'mod+=': () => zoomTo(stepZoom(zoomRef.current, 1)),
    'mod+-': () => zoomTo(stepZoom(zoomRef.current, -1)),
    'mod+0': () => zoomTo(1),
    'mod+/': () => setShortcutsOpen((o) => !o),
    // The nth project tab, as shown in the bar. Nothing to do without one.
    'mod+alt+digit': (_e, digit) => {
      const tab = showTabs && digit !== null ? tabs[digit - 1] : undefined;
      if (tab) selectTab(tab.key);
    },
    // The previous / next tab, stopping at the ends; lands like the digit above.
    'mod+shift+[': () => stepProject(-1),
    'mod+shift+]': () => stepProject(1),
    // Only where the switch is shown: not over the editor (see the switch).
    'mod+\\': () => {
      if (!editorShowing) setMode((m) => (m === 'pty' ? 'split' : m === 'split' ? 'transcript' : 'pty'));
    },
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

  /**
   * The Files heads' slots for the git ⋯ menu, one per Files list: the tab's
   * list stays mounted while hidden, and a shared slot drew both menus.
   */
  const [tabFilesSlot, setTabFilesSlot] = useState<HTMLSpanElement | null>(null);
  const [columnFilesSlot, setColumnFilesSlot] = useState<HTMLSpanElement | null>(null);
  /** The Editor tab's head: EditorTabs draws the file tabs and their controls into it. */
  const [editorHeadSlot, setEditorHeadSlot] = useState<HTMLDivElement | null>(null);

  const banner = loadError ?? startupError ?? captureError;

  return (
    <FileOpenContext.Provider value={openFile}>
    <FileTextContext.Provider value={readFileText}>
    <div className="app" data-dragging={dragging !== null} data-drag={dragging ?? undefined}>
      <Header
        onReconcile={() => setReconcileOpen(true)}
        onProjects={() => setProjectsOpen(true)}
        onSessions={() => setSessionsOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        blockedCount={tasks.filter((t) => t.status === 'blocked').length}
        theme={themeChoice}
        onThemeChange={setThemeChoice}
        onWaitingClick={() => {
          // Most recently active first; from a waiting task, on to the next.
          const waiting = tasks
            .filter((t) => t.status === 'blocked')
            .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
          if (waiting.length === 0) return;
          const at = waiting.findIndex((t) => t.id === selectedId);
          select(waiting[(at + 1) % waiting.length]!.id);
        }}
        tabs={
          /* Not gated on activeProjectTab: hide EVERY project and there is no
             active tab, and gating here would remove the restore chip along
             with the tabs — the one-way door this feature must not become. */
          showTabs ? (
            <ProjectTabs
              tabs={tabs}
              activeKey={activeProjectTab?.key ?? ''}
              onSelect={selectTab}
              onHide={hideProject}
              hidden={hiddenProjects}
              onRestore={restoreProject}
              onReorder={reorderProjects}
            />
          ) : undefined
        }
      />

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {banner && (
        <div className="banner" role="status">
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
            Archive It
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
            onFollowUp={(task) => void openFollowUp(task)}
            onManageProjects={() => setProjectsOpen(true)}
            contextBySession={contextBySession}
            signals={signals}
            attention={attention}
            projects={projects}
            activeProject={activeProject}
            nameProject={!showTabs}
            emptyBrief={!selected}
          />
        </aside>

        <div
          className="splitter splitter-v"
          data-dragging={dragging === 'sidebar'}
          onPointerDown={startSidebarDrag}
          role="separator"
          aria-orientation="vertical"
        />

        <main className="main" ref={mainRef}>
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
                      <span className="main-ident-sep" aria-hidden="true">›</span>
                    </>
                  )}
                  <span className="main-ident-title" title={`${wrapForTooltip(selected.title)}\n${selected.worktreePath}`}>
                    {selected.title}
                  </span>
                  {/* What acts on the task, right after its name; the ⋯ at
                      the bar's end keeps what acts on the panes. */}
                  <OverflowMenu
                    label={`Actions for ${selected.title}`}
                    title="Task actions"
                    trigger={{ className: 'icon-btn main-ident-more', content: <MoreGlyph /> }}
                    items={[
                        {
                          id: 'copy-path',
                          label: 'Copy Worktree Path',
                          onSelect: () => {
                            void navigator.clipboard?.writeText(selected.worktreePath).catch(() => {});
                          },
                        },
                        {
                          id: 'copy-session',
                          label: 'Copy Session ID',
                          disabled: selected.sessionId === null,
                          title: selected.sessionId ?? 'No session yet',
                          onSelect: () => {
                            if (selected.sessionId) void navigator.clipboard?.writeText(selected.sessionId).catch(() => {});
                          },
                        },
                        // Moving a chat to a worktree would turn it into work
                        // on a branch: out of scope (#49), so not offered.
                        ...(selected.kind === 'chat' ? [] : [{
                          id: 'move',
                          label:
                            normalizePath(selected.worktreePath) === normalizePath(selected.repoPath)
                              ? 'Move to a Worktree…'
                              : 'Move to Main Checkout…',
                          title: 'Same branch, same conversation; uncommitted changes come along',
                          onSelect: () => setMoveTarget(selected),
                        }]),
                        {
                          id: 'archive',
                          label: 'Archive Task…',
                          title: 'Out of the active list (opens the archive dialog)',
                          onSelect: () => {
                            setEndIntent('archive');
                            setArchiveTarget(selected);
                          },
                        },
                        {
                          id: 'delete',
                          label: 'Delete Task…',
                          tone: 'danger' as const,
                          title: 'Worktree optional, conversation kept (opens the delete dialog)',
                          onSelect: () => {
                            setEndIntent('delete');
                            setArchiveTarget(selected);
                          },
                        },
                    ]}
                  />
                  {/* The branch and folder live here and nowhere else on screen:
                      the sidebar row repeats the branch only when it adds to
                      the title, the Files bar not at all. Icons say which is
                      which, so a branch named like its task reads as a fact. */}
                  {/* A chat has no branch: the chat glyph takes its place, in
                      the same tier, and the folder after it says where. */}
                  {selected.kind === 'chat' ? (
                    <span
                      className="main-ident-branch"
                      data-kind="chat"
                      title="A chat about the code: no branch, in the main checkout as it is"
                    >
                      <ChatIcon />
                      <span className="main-ident-text">Chat</span>
                    </span>
                  ) : selected.branch ? (
                    <span className="main-ident-branch" title={`Branch ${selected.branch}, off ${selected.baseBranch}`}>
                      <BranchIcon />
                      <span className="main-ident-text">{selected.branch}</span>
                    </span>
                  ) : null}
                  {/* The PR, beside the branch it belongs to: with the branch,
                      the one place git and GitHub state shows. It never
                      shrinks; the title and the folder give way first. A chat
                      has neither, and nothing takes their place. */}
                  {selected.kind !== 'chat' && (
                  <PrBadge
                    task={selected}
                    onEnd={(intent) => {
                      setEndIntent(intent);
                      setArchiveTarget(selected);
                    }}
                    onFollowUp={(pr) => void openFollowUp(selected, pr)}
                    onCreatePr={() => void sendPrompt(selected, createPrPrompt(selected))}
                  />
                  )}
                  {/* The folder only where it says something: a worktree Albedo
                      cut is always <root>/<branch>, so naming it cost the room
                      the title and branch needed. A task running anywhere else
                      -- above all the main checkout -- shows where. */}
                  {!selected.ownsWorktree && (
                    <span className="main-ident-path" title={selected.worktreePath}>
                      <FolderIcon />
                      <span className="main-ident-text">{homeRelative(selected.worktreePath)}</span>
                    </span>
                  )}
                </>
              ) : null}
            </div>

            {/* The picker lives beside Send in the composer; only with the
                transcript hidden (terminal only) does it fall back to here. */}
            {selected && !showTranscript && <ModelPicker task={selected} />}

            {!editorShowing && (
            <div className="seg" role="group" aria-label="Pane layout">
              <button aria-pressed={mode === 'pty'} onClick={() => setMode('pty')} title="Terminal only (⌘\)">
                PTY
              </button>
              <button aria-pressed={mode === 'split'} onClick={() => setMode('split')} title="Split (⌘\)">
                Split
              </button>
              <button
                aria-pressed={mode === 'transcript'}
                onClick={() => setMode('transcript')}
                title="Transcript only (⌘\)"
              >
                Transcript
              </button>
            </div>
            )}

            {/* Two icons where a ⋯ held two items: the orientation only
                means something in Split, and the shell keeps ⌥F12. */}
            {split && (
              <button
                type="button"
                className="icon-btn"
                aria-label={orientation === 'row' ? 'Stack Panes' : 'Panes Side by Side'}
                title={
                  orientation === 'row'
                    ? 'Terminal and reading pane side by side. Click to stack them'
                    : 'Terminal and reading pane stacked. Click to put them side by side'
                }
                onClick={() => setOrientation((o) => (o === 'row' ? 'column' : 'row'))}
              >
                <svg className="more-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
                  {orientation === 'row' ? <path d="M8 3v10" /> : <path d="M2 8h12" />}
                </svg>
              </button>
            )}
            <button
              type="button"
              className="icon-btn icon-btn-on"
              aria-pressed={shellOpen && shellProject !== null}
              aria-label="Shell"
              disabled={!shellProject}
              title={
                shellProject
                  ? `Shell in ${shellProject.name}'s main checkout (⌥F12)`
                  : 'No project to open a shell in'
              }
              onClick={() => setShellOpen((o) => !o)}
            >
              <svg className="more-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
                <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5" />
              </svg>
            </button>
          </div>

          <div className="panes" data-orientation={orientation} data-mode={mode} ref={panesRef}>
            {/* No task: one message for the whole area, in every mode. Each
                pane used to say it separately -- the terminal, the transcript
                ("select a task" with none to select) and the files column, at
                three different heights -- and Transcript mode hid the only
                one that offered a next step. */}
            {!selected && (
              <div className="placeholder">
                {loading ? (
                  <p>Loading tasks…</p>
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
                  <p>Pick a task from the list.</p>
                )}
              </div>
            )}

            {/* Kept mounted in every mode: unmounting it would kill live ptys. */}
            <section className="pane pane-pty" style={primaryStyle} hidden={!showPty || !selected}>
              {/* A name only when there is another pane to tell it from: in
                  PTY mode the switch above already says "PTY". */}
              {split && (
                <div className="pane-head">
                  <span>Terminal</span>
                </div>
              )}
              <div className="pane-body">
                <div className="term-stack">
                  {openTasks.filter((task) => !stopped.has(task.id)).map((task) => (
                    <Terminal
                      /* The folder is part of the identity: a task that moved
                         starts again there, resuming the same session. */
                      key={`${task.id}@${task.worktreePath}`}
                      task={task}
                      active={task.id === selectedId}
                      initialPrompt={initialPromptFor(task) ?? undefined}
                      spawnArgs={spawnArgsFor(task)}
                      onFreshStart={() => forgetResume(task.id)}
                      sessionName={sessionNameFor(task)}
                    />
                  ))}
                </div>
              </div>
            </section>

            {split && selected && (
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
            <div className="read-area" style={secondaryStyle} hidden={!showTranscript || !selected}>
            <section className="pane pane-transcript">
              {/* Only when it tells panes or tabs apart: in Transcript mode with no
                  other tab, "Transcript" just repeated the switch above. */}
              {(split || readingTabs.length > 1) && (
              <div className="pane-head">
                <div className="tabs" role="tablist" aria-label="Reading pane">
                  <button
                    role="tab"
                    aria-selected={activeTab === 'transcript'}
                    onClick={() => setRightTab('transcript')}
                    title={selected?.sessionId ? `Session ${selected.sessionId}` : 'No session yet'}
                  >
                    Transcript
                  </button>
                  {!filesColumnShown && (
                    <button
                      role="tab"
                      aria-selected={activeTab === 'files'}
                      onClick={() => setRightTab('files')}
                    >
                      Files
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
                      Editor
                    </button>
                  )}
                </div>
                {/* The editor's file tabs, ‹ ›, Save and ⋯, in this same row. The
                    branch is in the task bar, and the session id is the
                    Transcript tab's tooltip, so nothing else needs saying. */}
                {activeTab === 'editor' ? (
                  <div className="pane-head-note" ref={setEditorHeadSlot} />
                ) : (
                  <span className="pane-head-note" />
                )}
                {activeTab === 'editor' && (
                  <button className="pane-head-close" onClick={closeEditor} title="Close editor" aria-label="Close editor">
                    ✕
                  </button>
                )}
                {/* Moves to the column's head once the column shows. */}
                {!filesColumnShown && (
                  <PanelToggle
                    on={filesPinned}
                    waiting={filesPinned}
                    onToggle={() => setFilesPinned((v) => !v)}
                  />
                )}
                {/* Last, so it lines up with the ⋯ of the rows above. */}
                {activeTab === 'files' && <span className="pane-head-slot" ref={setTabFilesSlot} />}
              </div>
              )}

              {/* All three panels stay mounted so scroll position and editor
                  buffer survive a tab flip; only the task identity resets them. */}
              <div className="pane-body">
                <div className="tabpanel tabpanel-col" hidden={activeTab !== 'transcript'}>
                  {/* Above the transcript, and only while something is live:
                      when a session fans out the transcript itself goes quiet,
                      which is exactly when you need to know what is running. */}
                  <PaneErrorBoundary key={`sa-${selected?.id ?? 'none'}`} label="Subagents">
                    <Subagents sessionId={selected?.sessionId ?? null} taskTitle={selected?.title ?? null} />
                  </PaneErrorBoundary>
                  <PaneErrorBoundary key={`tx-${selected?.id ?? 'none'}`} label="Transcript">
                    <TranscriptPane
                      taskId={selected?.id ?? null}
                      sessionId={selected?.sessionId ?? null}
                      /* So the composer can hold a message rather than typing
                         it into a permission prompt. */
                      status={selected?.status ?? null}
                      /* The prompt is answered in the terminal; make sure it
                         is on screen, then give it the keyboard. */
                      composerAccessory={
                        selected ? (
                          <>
                            {/* Compact and Clear, only once the session is past 70% of
                                its window; the row's hairline shows the rest. */}
                            <ContextClear
                              task={selected}
                              usage={selected.sessionId ? contextBySession.get(selected.sessionId) : null}
                            />
                            <ModelPicker task={selected} />
                          </>
                        ) : null
                      }
                      onAnswerInTerminal={(id) => {
                        setMode((m) => (m === 'transcript' ? 'split' : m));
                        window.requestAnimationFrame(() => focusPty(id));
                      }}
                    />
                  </PaneErrorBoundary>
                </div>

                <div className="tabpanel" hidden={activeTab !== 'files'}>
                  {selected ? (
                    <PaneErrorBoundary key={`tf-${selected.id}`} label="Touched files">
                      <TouchedFiles task={selected} activePath={editorTask?.id === selected.id ? editorFile : null} menuSlot={tabFilesSlot} />
                    </PaneErrorBoundary>
                  ) : (
                    <div className="placeholder">No task selected.</div>
                  )}
                </div>

                <div className="tabpanel" hidden={activeTab !== 'editor'}>
                  {editorTask && (
                    <PaneErrorBoundary key={`ed-${editorTask.id}`} label="Editor">
                      <EditorTabs
                        task={editorTask}
                        request={openRequest?.request ?? null}
                        readOnly={editorTask === browseTask}
                        onCloseAll={closeEditor}
                        closeSignal={editorCloseSignal}
                        onActivePath={setEditorActivePath}
                        headSlot={editorHeadSlot}
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
                    <span>Files</span>
                    <span className="pane-head-note" />
                    <PanelToggle on onToggle={() => setFilesPinned(false)} />
                    {/* The git ⋯ menu lands here (GitBar portals into it).
                        Last, so it lines up with the ⋯ of the rows above. */}
                    <span className="pane-head-slot" ref={setColumnFilesSlot} />
                  </div>
                  <div className="pane-body">
                    {selected ? (
                      <PaneErrorBoundary key={`fc-${selected.id}`} label="Touched files">
                        <TouchedFiles task={selected} activePath={editorTask?.id === selected.id ? editorFile : null} menuSlot={columnFilesSlot} />
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

          {shellOpen && shellProject && (
            <div
              className="splitter splitter-h"
              data-dragging={dragging === 'shell'}
              onPointerDown={startShellDrag}
              role="separator"
              aria-orientation="horizontal"
            />
          )}
          {/* Kept mounted once a shell exists: unmounting would kill it. */}
          {shellProjectIds.length > 0 && (
            <section
              className="pane shell-drawer"
              style={{ flex: `0 0 ${shellHeight}px` }}
              hidden={!shellOpen || !shellProject}
            >
              <div className="pane-head">
                <span>Shell</span>
                {shellProject && (
                  <span className="pane-head-note" title={shellProject.repoPath}>
                    {shellProject.name} · Main Checkout
                  </span>
                )}
                <button
                  className="icon-btn shell-drawer-close"
                  onClick={() => setShellOpen(false)}
                  title="Hide the shell (⌥F12) — it keeps running"
                  aria-label="Hide the shell"
                >
                  ✕
                </button>
              </div>
              <div className="pane-body">
                <div className="term-stack">
                  {shellProjectIds.map((id) => {
                    const project = projects.find((p) => p.id === id);
                    if (!project?.repoPath) return null;
                    return (
                      <PaneErrorBoundary key={`shell-${id}`} label="Shell">
                        <ShellTerminal
                          cwd={project.repoPath}
                          active={shellOpen && shellProject?.id === id}
                        />
                      </PaneErrorBoundary>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Usage is global, so it runs under everything, on the chrome ground. */}
      <PaneErrorBoundary label="Usage">
        <StatusBar />
      </PaneErrorBoundary>

      <PaneErrorBoundary label="New task">
        <NewTaskDialog
          open={newTaskOpen}
          prefill={newTaskPrefill}
          defaultProjectId={activeProject?.id ?? null}
          onClose={() => {
            followUpSeq.current++;
            setNewTaskOpen(false);
            setNewTaskPrefill(null);
          }}
          onCreated={(task: Task, initialPrompt?: string) => {
            if (initialPrompt !== undefined) {
              setPromptOverrides((prev) => new Map(prev).set(task.id, initialPrompt));
            }
            followUpSeq.current++;
            setNewTaskPrefill(null);
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
      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <PaneErrorBoundary label="Go to">
        <QuickOpen
          mode={searchTask ? quickOpen : null}
          worktreePath={searchTask?.worktreePath ?? null}
          scopeLabel={searchScopeLabel}
          currentFile={editorFile}
          onMode={setQuickOpen}
          onClose={closeQuickOpen}
          onOpen={openFile}
        />
      </PaneErrorBoundary>
      <PaneErrorBoundary label="Find in Files">
        <FindInFiles
          open={searchTask !== null && findOpen}
          worktreePath={searchTask?.worktreePath ?? null}
          scopeLabel={searchScopeLabel}
          onClose={closeFind}
          onOpen={openFile}
        />
      </PaneErrorBoundary>
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
              writePersisted(KEYS.hiddenProjects, numberListCodec, [...next]);
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

      <PaneErrorBoundary label="Move task">
        <MoveTaskDialog
          task={moveTarget}
          project={projects.find((p) => p.id === moveTarget?.projectId) ?? null}
          onClose={() => setMoveTarget(null)}
          onStop={async (task) => {
            setStopped((prev) => new Set(prev).add(task.id));
            // Unmounting kills the pty; give claude a moment to exit before
            // git touches the folder it was running in.
            await new Promise((resolve) => window.setTimeout(resolve, 600));
          }}
          onDone={(moved) => {
            upsertTask(moved);
            // Its tabs are paths in the old folder.
            if (openRequestRef.current?.taskId === moved.id) closeEditor();
            setStopped((prev) => {
              const next = new Set(prev);
              next.delete(moved.id);
              return next;
            });
          }}
        />
      </PaneErrorBoundary>

      <PaneErrorBoundary label="Archive task">
        <ArchiveTaskDialog
          task={archiveTarget}
          intent={endIntent}
          otherTasks={tasks}
          onClose={() => setArchiveTarget(null)}
          onArchived={(taskId) => {
            void archive(taskId);
            setArchiveTarget(null);
          }}
          onDeleted={(taskId) => {
            // Same ordering discipline as onArchived: the row only leaves the
            // list once the destructive work has actually completed. The dialog
            // only does the git side, so the task and its captured messages are
            // removed here (see deleteTask).
            void deleteTask(taskId)
              .then(() => {
                forgetResume(taskId);
                void endTaskEvents(taskId).catch(() => {});
                setArchiveTarget(null);
                return refresh();
              })
              .catch((e) => console.error('deleteTask failed', e));
          }}
        />
      </PaneErrorBoundary>
    </div>
    </FileTextContext.Provider>
    </FileOpenContext.Provider>
  );
}
