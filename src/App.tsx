import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from './types';
import { useTheme } from './ui/theme';
import useTasks from './ui/useTasks';
import useLayout, { filesFlex, ratioFlex, shellFlex, sidebarStyle, type RightTab } from './ui/app/useLayout';
import useDialogs from './ui/app/useDialogs';
import useLaunchNotices from './ui/app/useLaunchNotices';
import LaunchNotices from './ui/app/LaunchNotices';
import TaskBar from './ui/app/TaskBar';
import AppDialogs from './ui/app/AppDialogs';
import useSessionRequests from './ui/app/useSessionRequests';
import { proposalsInScope } from './ui/proposals';
import { useSessionOutcomes } from './ui/requestQueue';
import { SpinOutContext, spinOutStatus, type SpinOutLookup } from './ui/spinOut';
import useProjectTabs from './ui/app/useProjectTabs';
import useSelection from './ui/app/useSelection';
import useBrowseTask from './ui/app/useBrowseTask';
import useSpawnPlan from './ui/app/useSpawnPlan';
import useReadingTab from './ui/app/useReadingTab';
import useEditorRequests from './ui/app/useEditorRequests';
import useAppShortcuts from './ui/app/useAppShortcuts';
import ProjectTabs from './ui/app/ProjectTabs';
import PaneErrorBoundary from './ui/app/PaneErrorBoundary';
import { useQuitGuard } from './ui/quitGuard';
import Header from './ui/Header';
import TaskList from './ui/TaskList';
import { seenUpdate } from './ui/taskGroups';
import { useMeasuredBase } from './ui/useMeasuredBase';
import Subagents from './ui/Subagents';
import {
  announcementFor,
  attentionMarks,
  clearAttention,
  noteReminder,
  lastBannerFor,
  onAttention,
  onNotificationClick,
  watchFocus,
  type AttentionKind,
} from './ui/attention';
import { worktreeRelative, type QuickOpenMode } from './ui/quickOpenModel';
import { focusPty, hasLivePty } from './ui/Terminal';
import TerminalStack from './ui/TerminalStack';
import { modalOpen } from './ui/focusAreas';
import { remoteControlItem, useRemotePending } from './ui/RemoteMark';
import type { TaskActions } from './ui/taskMenuItems';
import { useTaskMenuFacts } from './ui/useTaskMenuFacts';
import ModelPicker from './ui/ModelPicker';
import { renameTaskAndSession } from './ui/taskRename';
import ShellTerminal from './ui/ShellTerminal';
import TranscriptPane from './ui/transcript/TranscriptPane';
import { sessionResumable, startReminders } from './reminders';
import { openReplacementTask } from './reminders/replacement';

import useWhatsNew from './ui/app/useWhatsNew';
import TouchedFiles from './ui/TouchedFiles';
import ProjectFiles from './ui/ProjectFiles';
import EditorTabs from './ui/editor/EditorTabs';
import { onComposerInsert, onShowTranscriptRequest } from './ui/transcript/composerBridge';
import GuidePane from './guide/GuidePane';
import ReviewUpdateBand from './ui/ReviewUpdateBand';
import { runReviewUpdate } from './guide/copyUpdate';
import { onGuideRequest, requestGuide } from './guide/openGuide';
import { FileOpenContext, FilePathContext, FileTextContext } from './ui/editor/openFile';
import { TaskOpenContext, type TaskOpener } from './ui/openTask';
import { MentionSourceContext, type MentionSource } from './ui/mentionSource';
import { resolveInWorktree } from './lib/paths';
import StatusBar from './ui/StatusBar';
import { ContextClear } from './ui/ClearContextButton';
import EmptyState from './ui/EmptyState';
import { getTask } from './db';
import { composeWorktreePath, listBranches, listWorktrees, probePath } from './git/worktree';
import PanelToggle from './ui/PanelToggle';
import {
  buildFollowUp,
  followUpTaken,
  followUpTitle,
  freeFollowUpTitle,
} from './ui/followUp';
import { useMergeNotices } from './ui/mergeNotice';
import { getPrStatus, usePendingPrWatch } from './gh/prStore';
import { requestChecks, useCiNotices, useCiNotifyEnabled } from './ui/ciNotice';
import { useKeepAwake, useKeepAwakeEnabled } from './ui/keepAwake';
import { useGroupToolCalls } from './ui/transcript/groupToolCalls';
import { useReviewNotices } from './ui/reviewNotice';
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

// ---------------------------------------------------------------------------

export default function App() {
  const {
    tasks,
    signals,
    loading,
    loadError,
    captureError,
    projects,
    contextBySession,
    refresh,
    upsertTask,
    archive,
    setDone,
    rename,
    setSummary,
    markSeen,
  } = useTasks();

  /** Tasks whose terminal has been brought up. Kept alive until the task goes. */
  const [openIds, setOpenIds] = useState<number[]>([]);

  const {
    sidebarWidth,
    taskListCollapsed,
    setTaskListCollapsed,
    mode,
    setMode,
    orientation,
    setOrientation,
    ratio,
    rightTab: projectRightTab,
    setRightTab: setProjectRightTab,
    filesPinned,
    setFilesPinned,
    filesWidth,
    filesColumnShown: taskFilesColumnShown,
    filesColumnShownAlone,
    dragging,
    shellOpen,
    setShellOpen,
    shellHeight,
    mainRef,
    panesRef,
    sidebarRef,
    ptyPaneRef,
    filesPaneRef,
    shellPaneRef,
    startSidebarDrag,
    startSplitDrag,
    startFilesDrag,
    startShellDrag,
  } = useLayout();
  const dialogs = useDialogs();
  const {
    setNewTaskOpen,
    setNewTaskPrefill,
    setReconcileOpen,
    setProjectsOpen,
    setShortcutsOpen,
    setSessionsOpen,
    setImportOpen,
    setArchiveTarget,
    setMoveTarget,
    setEndIntent,
    remoteConfirmFor,
    setRemoteConfirmFor,
  } = dialogs;

  /** Go to File / Class / Symbol / Search Everywhere; null when closed. */
  const [quickOpen, setQuickOpen] = useState<QuickOpenMode | null>(null);
  /** What Go to File starts from when a transcript name opened it. */
  const [quickSeed, setQuickSeed] = useState<{ text: string } | null>(null);
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  /** Tasks whose terminal is down while they move: unmounting ends the session. */
  const [stopped, setStopped] = useState<ReadonlySet<number>>(() => new Set());
  const [shellProjectIds, setShellProjectIds] = useState<number[]>([]);

  const {
    tabs,
    hiddenProjectIds,
    unhideProject,
    hiddenProjects,
    hideProject,
    restoreProject,
    reorderProjects,
    showTabs,
    activeProjectTab,
    activeProjectTabKey,
    selectTab,
    switchTab,
  } = useProjectTabs(projects, tasks, (key) => landRef.current(key));

  /*
   * The selection: a task, or null for the active project's own view (#181).
   * It and the tab move together (see useSelection): a tab switch lands on
   * the place last left there, and selecting a task takes its tab along.
   */
  const { selectedId, select, land, showProjectView, clickTab } = useSelection({
    tasks,
    projects,
    loading,
    tabs,
    activeTab: activeProjectTab,
    activeKey: activeProjectTabKey,
    selectTab,
    switchTab,
    onShow: (id) => {
      setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      // Looking at it is what "seen" means; nothing else clears the mark.
      clearAttention(id);
    },
  });
  const landRef = useRef(land);
  landRef.current = land;

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

  const { rightTab, setRightTab, tabTaskRef, beforeEditorRef } = useReadingTab(
    selectedId,
    projectRightTab,
    setProjectRightTab,
  );
  /** What the selected task merges into, for its Create PR (#237): the header's base. */
  const selectedBase = useMeasuredBase(selected);
  /**
   * What's New after an update (#147). It waits while another dialog or the
   * "waiting on you" card is on screen (checked in the DOM), and while the
   * selected task is waiting on you even where no card is drawn (the
   * terminal-only view shows that question in the terminal).
   */
  const whatsNew = useWhatsNew({ hold: selected?.status === 'blocked' });
  /** What the task bar's ⋯ items read about the selected task (#331). */
  const selectedFacts = useTaskMenuFacts(selected, true);
  /** Remote Control on the selected task: the task bar's mark, ⇧⌘R and its confirmation. */
  const remoteUrl = selectedFacts.remoteUrl;
  const remoteItem = selected ? remoteControlItem(selected, selectedFacts.live, remoteUrl) : null;
  const remotePending = useRemotePending(selected?.id ?? null);
  /**
   * The task whose name is being edited in the task bar (#152): from the ⋯
   * item, a double-click on the name, or ⇧F6 / F2. Only ever the selected
   * task; the row menu edits on the row instead (TaskList).
   */
  const [renaming, setRenaming] = useState<{ id: number; by: 'key' | 'pointer' } | null>(null);
  /** After a rename started from a menu or a double-click: the task's terminal, if it runs. */
  const focusLiveTerminal = useCallback((taskId: number) => {
    if (hasLivePty(taskId)) focusPty(taskId);
  }, []);
  const saveTitle = useCallback(
    (task: Task, title: string) => void renameTaskAndSession(task, title, rename),
    [rename],
  );
  /** The summary from the rename field (#262): Albedo's only; nothing goes to the session. */
  const saveSummary = useCallback(
    (task: Task, summary: string | null) => void setSummary(task.id, summary),
    [setSummary],
  );
  /**
   * ⇧⌘R's confirmation shows only while it still has something to confirm:
   * on the task it was asked on, still selected, live and with Remote Control
   * off. Switch task, end the session or turn it on in the terminal, and it
   * is dropped rather than left to act on something else.
   */
  const remoteConfirm = remoteItem !== null && selected !== null && remoteConfirmFor === selected.id ? remoteItem : null;
  useEffect(() => {
    if (remoteConfirmFor !== null && remoteConfirm === null) setRemoteConfirmFor(null);
  }, [remoteConfirmFor, remoteConfirm, setRemoteConfirmFor]);

  // The task on screen is seen: when it is opened, and when a turn ends while
  // it is open. Only a finish it has not covered yet is written.
  const selectedFinishedAt = selected ? (signals.get(selected.id)?.finishedAt ?? null) : null;
  useEffect(() => {
    if (!selected) return;
    const at = seenUpdate(selected.seenAt, selectedFinishedAt, Date.now());
    if (at !== null) markSeen(selected.id, at);
  }, [selected?.id, selected?.seenAt, selectedFinishedAt, markSeen]);

  const browseTask = useBrowseTask(selected, activeProject);
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
  /**
   * The project view (#181): no task selected, and a project with a folder to
   * show. The pane shows the main checkout's files through `browseTask` --
   * read-only, no composer, no session, no terminal: nothing is spawned for
   * it and nothing about it is written.
   */
  const projectView = !loading && selectedId === null && browseTask !== null;
  /** Whether the pinned Files column fits: the project view has the whole row to fit it in. */
  const filesColumnShown = projectView ? filesColumnShownAlone : taskFilesColumnShown;
  /** The folder the search dialogs work in: the task's worktree, else the checkout. */
  const searchTask = selected ?? browseTask;
  const searchScopeLabel = selected === null && browseTask ? `${browseTask.title} · main checkout` : null;
  /* Read by `readFileText`, which is registered once and must not close over
     the task that was selected when it was created. */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const { setPendingResume, setPromptOverrides, spawnArgsFor, sessionNameFor, forgetResume, initialPromptFor } =
    useSpawnPlan(projects);

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

  /** A transcript's path as the selected task's worktree-relative one (#222). */
  const relativeInWorktree = useCallback(async (path: string): Promise<string | null> => {
    const task = selectedRef.current;
    if (!task) return null;
    try {
      return (await resolveInWorktree(task.worktreePath, path))?.relative ?? null;
    } catch {
      return null;
    }
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
  // A banner names one task; clicking it opens that task -- and, for the
  // newest banner being "checks failed", its Checks dialog on the failing job.
  useEffect(
    () =>
      onNotificationClick((id) => {
        select(id);
        if (lastBannerFor(id) === 'checks-fail') requestChecks(id);
      }),
    [select],
  );

  // A transcript row that names a task (a message from another session) opens
  // it through this. Stable, reading the list through a ref, like `select`.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const taskOpener = useMemo<TaskOpener>(
    () => ({ has: (id) => tasksRef.current.some((t) => t.id === id), open: select }),
    [select],
  );
  useMergeNotices(tasks);
  // What the message box's `@` list offers (#154).
  const mentionSource = useMemo<MentionSource>(() => ({ tasks, projects }), [tasks, projects]);
  // Checks finishing is news wherever the task is: every task's running checks
  // stay polled (the list polls only what it shows), and every answer is
  // watched for the moment they finish (#159).
  const prTasks = useMemo(() => tasks.filter((t) => t.kind !== 'chat'), [tasks]);
  usePendingPrWatch(prTasks);
  useCiNotices(tasks, selectedId);
  useReviewNotices(tasks, selectedId);
  const [ciNotify, setCiNotify] = useCiNotifyEnabled();
  // No idle sleep and no App Nap while tasks run (#283); the count for the status strip.
  const [keepAwake, setKeepAwake] = useKeepAwakeEnabled();
  const [groupToolCalls, setGroupToolCalls] = useGroupToolCalls();
  const awakeCount = useKeepAwake(tasks, keepAwake);

  /*
   * Reminders (#156): checked at launch -- so one due while Albedo was closed
   * fires now, showing its original time -- and every minute after. A card
   * goes to its task, or a new one when that task is gone (src/reminders).
   */
  useEffect(
    () =>
      startReminders(
        {
          getTask,
          resumable: (task) => sessionResumable(task, hasLivePty),
          openReplacement: openReplacementTask,
        },
        (r, task) => noteReminder(task.id, task.title, r.text),
      ),
    [],
  );
  /** The task "Remind Me…" was opened on; null when the dialog is closed. */
  const [remindFor, setRemindFor] = useState<Task | null>(null);

  const { startupError, unclaimed, worktreeProjects, dismiss } = useLaunchNotices();

  // What sessions asked for through Albedo's MCP server (#157). Approving a
  // new session opens New Task filled in from it; nothing starts on its own.
  const requests = useSessionRequests({
    tasks,
    loading,
    projects,
    select,
    openNewTask: (prefill) => {
      followUpSeq.current++;
      setNewTaskPrefill(prefill);
      setNewTaskOpen(true);
    },
  });
  // Requests for a new session, as the list's Proposed group (#332): scoped
  // to the active project tab the way its tasks are, newest first.
  const proposals = useMemo(
    () => proposalsInScope(requests.items, activeProjectTab, tasks, projects),
    [requests.items, activeProjectTab, tasks, projects],
  );

  const {
    openRequest,
    openRequestRef,
    openFile,
    closeEditor,
    editorCloseSignal,
    setEditorCloseSignal,
    editorActivePath,
    setEditorActivePath,
    editorTask,
  } = useEditorRequests({
    selected,
    selectedId,
    selectedRef,
    browseTask,
    browseTaskRef,
    filesColumnShown,
    setRightTab,
    setMode,
    setQuickSeed,
    setQuickOpen,
    tabTaskRef,
    beforeEditorRef,
  });

  /**
   * Put a task on screen. The ONLY supported way to do so.
   *
   * ## THE RULE
   *
   * SELECTING A TASK THAT IS NOT IN THE ACTIVE SCOPE IS A NO-OP UNLESS THE
   * SCOPE MOVES FIRST. A task selected behind a list that does not show it
   * reads as the task vanishing, a long way from the cause. `select()` moves
   * the scope itself now, but only to a VISIBLE tab: a closed one must be
   * reopened first, which only this function does.
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
   *   2. scope   — the scope alone (`selectTab`), never `switchTab`: the task
   *                asked for is the place, not the one remembered there.
   *   3. select  — now it sticks.
   *   4. reveal  — "focus" means the thing is actually on screen, not merely
   *                selected behind a FILES or EDITOR tab.
   */
  const revealTask = useCallback(
    (task: Task) => {
      const projectId = task.projectId;

      if (projectId !== null && hiddenProjectIds.has(projectId)) unhideProject(projectId);

      selectTab(projectId !== null ? `p${projectId}` : 'orphans');
      select(task.id);
      setRightTab('transcript', task.id);
    },
    [hiddenProjectIds, unhideProject, selectTab, select, setRightTab],
  );

  /**
   * A project's own view, from the breadcrumb (#181). A task can be on screen
   * from a project whose tab is closed (a banner, a reminder); its name then
   * reopens that tab, as revealTask would, so the view is the project named.
   */
  const openProjectView = useCallback(
    (projectId: number) => {
      if (hiddenProjectIds.has(projectId)) unhideProject(projectId);
      showProjectView(`p${projectId}`);
    },
    [hiddenProjectIds, unhideProject, showProjectView],
  );

  // Text handed to the composer from elsewhere (review comments): show the
  // transcript, where the composer is, the way opening a file shows the editor.
  useEffect(
    () =>
      onComposerInsert((insert) => {
        setRightTab('transcript', insert.taskId);
        setMode((m) => (m === 'pty' ? 'split' : m));
      }),
    [],
  );
  // Comments just sent (#254, #258): the transcript, where they land.
  useEffect(
    () =>
      onShowTranscriptRequest((taskId) => {
        setRightTab('transcript', taskId);
        setMode((m) => (m === 'pty' ? 'split' : m));
      }),
    [],
  );

  /** A guide asked for from Files, ⋯ or ⇧⌘G (#186): its tab, shown. */
  useEffect(
    () =>
      onGuideRequest((taskId) => {
        setRightTab('guide', taskId);
        setMode((m) => (m === 'pty' ? 'split' : m));
      }),
    [],
  );


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


  // Derived rather than corrected in an effect: switching task while the editor
  // tab is showing falls straight back to the transcript, with no flash.
  // A pinned column also takes FILES out of the tab strip -- a tab that shows
  // you what you are already looking at is noise.
  // The project view has no transcript: Files, or the editor once a file is
  // open. With Files pinned as a column and nothing open, its 'transcript'
  // slot says how to open one.
  /**
   * Every task on a branch has its Guide tab, always (owner, #287): it used
   * to appear only once asked for, from Files or ⋯, and closed with ✕. A
   * chat has no branch to guide.
   */
  const guideTask = selected && selected.kind !== 'chat' ? selected : null;
  const activeTab: RightTab = projectView
    ? rightTab === 'editor' && editorTask
      ? 'editor'
      : !filesColumnShown
        ? 'files'
        : editorTask
          ? 'editor'
          : 'transcript'
    : (rightTab === 'editor' && !editorTask) || (rightTab === 'guide' && !guideTask)
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
      ...(projectView ? [] : (['transcript'] as const)),
      ...(filesColumnShown ? [] : (['files'] as const)),
      ...(guideTask && !projectView ? (['guide'] as const) : []),
      ...(editorTask ? (['editor'] as const) : []),
    ],
    [projectView, filesColumnShown, editorTask, guideTask],
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
    if (current === null && modalOpen()) return;
    setQuickOpen(current === next ? null : next);
  }, []);
  const closeQuickOpen = useCallback(() => setQuickOpen(null), []);

  /** Find in Files (⇧⌘F): same guards as the palette -- a folder, and no other modal. */
  const [findOpen, setFindOpen] = useState(false);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const toggleFind = useCallback(() => {
    if (!selectedRef.current && !browseTaskRef.current) return;
    if (!findOpenRef.current && modalOpen()) return;
    setFindOpen((o) => !o);
  }, []);
  const closeFind = useCallback(() => setFindOpen(false), []);

  /** The editor's file, worktree-relative, so the palette can rank it first. */
  const editorFile = useMemo(
    () => (editorTask && editorActivePath ? worktreeRelative(editorTask.worktreePath, editorActivePath) : null),
    [editorTask, editorActivePath],
  );

  useAppShortcuts({
    readingTabs,
    activeTab,
    setRightTab,
    toggleQuickOpen,
    toggleFind,
    selected,
    setMode,
    remoteItem,
    setRemoteConfirmFor,
    projectView,
    filesColumnShown,
    setShellOpen,
    setShortcutsOpen,
    showTabs,
    tabs,
    switchTab,
    activeProjectTab,
    setTaskListCollapsed,
    editorShowing,
    setRenaming,
  });

  // --- render --------------------------------------------------------------

  const showPty = mode !== 'transcript';
  const showTranscript = mode !== 'pty';
  const split = mode === 'split';

  const primaryStyle = split
    ? { flex: ratioFlex(ratio) }
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

  /**
   * What the task's ⋯ actions do (#331), for both menus: the row's and the
   * task bar's. Each acts on the task it is given -- from a row, maybe not
   * the selected one, which it leaves selected. Only Review Guide moves the
   * selection, the way a click on the row does, to show that task's Guide.
   */
  /** A task by id, shown (the "from" chip, a spun-out task in the transcript). */
  const openTaskById = useCallback(
    (taskId: number) => {
      const task = tasks.find((t) => t.id === taskId);
      if (task) revealTask(task);
    },
    [tasks, revealTask],
  );

  /*
   * What a request in the selected task's transcript became (#332): its
   * Proposed row, the decision recorded on Deny or Create, or a task spun out
   * of it under the same title (spinOut.ts).
   */
  const sessionOutcomes = useSessionOutcomes();
  const transcriptTaskId = selected?.id ?? null;
  const spinOutLookup = useMemo<SpinOutLookup | null>(
    () =>
      transcriptTaskId === null
        ? null
        : {
            statusOf: (call) => spinOutStatus(call, transcriptTaskId, requests.items, sessionOutcomes, tasks),
            openTask: openTaskById,
          },
    [transcriptTaskId, requests.items, sessionOutcomes, tasks, openTaskById],
  );

  /**
   * Fork Conversation… (#332): New Task, in fork mode from `task`, with the
   * message box empty and nothing sent unless the user asks. Nothing is
   * created until Create.
   */
  const openFork = useCallback((task: Task) => {
    followUpSeq.current++;
    setNewTaskPrefill({
      projectId: task.projectId,
      title: `${task.title} (fork)`,
      prompt: '',
      from: { taskId: task.id, title: task.title, sessionId: task.sessionId, kind: task.kind, start: 'fork' },
    });
    setNewTaskOpen(true);
  }, []);

  const taskActions = useMemo<TaskActions>(
    () => ({
      remind: (task) => setRemindFor(task),
      guide: (task) => {
        select(task.id);
        requestGuide(task.id);
      },
      // Never on its own (#352): only this click, or the band's.
      updateReview: (task) => void runReviewUpdate(task),
      fork: openFork,
      move: (task) => setMoveTarget(task),
      setDone: (task, done) => void setDone(task.id, done),
      followUp: (task) => void openFollowUp(task),
      archive: (task) => {
        setEndIntent('archive');
        setArchiveTarget(task);
      },
      delete: (task) => {
        setEndIntent('delete');
        setArchiveTarget(task);
      },
    }),
    [select, setMoveTarget, setDone, openFollowUp, openFork, setEndIntent, setArchiveTarget],
  );

  return (
    <FileOpenContext.Provider value={openFile}>
    <FileTextContext.Provider value={readFileText}>
    <FilePathContext.Provider value={relativeInWorktree}>
    <TaskOpenContext.Provider value={taskOpener}>
    <MentionSourceContext.Provider value={mentionSource}>
    <div className="app" data-dragging={dragging !== null} data-drag={dragging ?? undefined}>
      <Header
        onReconcile={() => setReconcileOpen(true)}
        onProjects={() => setProjectsOpen(true)}
        onSessions={() => setSessionsOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onWhatsNew={whatsNew.available ? whatsNew.reopen : undefined}
        blockedCount={tasks.filter((t) => t.status === 'blocked').length}
        requests={requests.button}
        theme={themeChoice}
        onThemeChange={setThemeChoice}
        ciNotify={ciNotify}
        onCiNotifyChange={setCiNotify}
        keepAwake={keepAwake}
        groupToolCalls={groupToolCalls}
        onGroupToolCallsChange={setGroupToolCalls}
        onKeepAwakeChange={setKeepAwake}
        taskListCollapsed={taskListCollapsed}
        onTaskListCollapsedChange={setTaskListCollapsed}
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
              onSelect={clickTab}
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

      <LaunchNotices
        banner={banner}
        refresh={refresh}
        worktreeProjects={worktreeProjects}
        unclaimed={unclaimed}
        dismiss={dismiss}
        setImportOpen={setImportOpen}
      />

      <div className="app-body">
        {/* Collapsed (#266), the rail's own width (taskrail.css) replaces the
            list's, which is kept for when it expands. */}
        <aside
          className="sidebar"
          ref={sidebarRef}
          data-collapsed={taskListCollapsed || undefined}
          style={taskListCollapsed ? undefined : sidebarStyle(sidebarWidth)}
        >
          <TaskList
            tasks={visibleTasks}
            selectedId={selectedId}
            onSelect={select}
            onNew={() => setNewTaskOpen(true)}
            actions={taskActions}
            onRename={saveTitle}
            onSummary={saveSummary}
            onRenameClosed={() => {
              if (selected) focusLiveTerminal(selected.id);
            }}
            onManageProjects={() => setProjectsOpen(true)}
            contextBySession={contextBySession}
            signals={signals}
            attention={attention}
            projects={projects}
            activeProject={activeProject}
            proposals={proposals}
            titleOf={(id) => tasks.find((t) => t.id === id)?.title ?? null}
            onApproveProposal={requests.approve}
            onDenyProposal={requests.deny}
            emptyBrief={!selected}
            collapsed={taskListCollapsed}
            onCollapsedChange={setTaskListCollapsed}
            onReviewOpened={(task) => {
              upsertTask(task);
              revealTask(task);
              // A PR just checked out for review opens on its Guide (#329):
              // reading the change is the first thing to do, not the empty
              // session. The Write Guide screen shows until one is written.
              setRightTab('guide', task.id);
              setMode((m) => (m === 'pty' ? 'split' : m));
            }}
          />
        </aside>

        {/* Nothing to drag while it is the rail: it has one width. */}
        {!taskListCollapsed && (
          <div
            className="splitter splitter-v"
            data-dragging={dragging === 'sidebar'}
            onPointerDown={startSidebarDrag}
            role="separator"
            aria-orientation="vertical"
          />
        )}

        <main className="main" ref={mainRef}>
          <TaskBar
            selected={selected}
            selectedProject={selectedProject}
            selectedProjectIsForeign={selectedProjectIsForeign}
            openProjectView={openProjectView}
            renaming={renaming}
            setRenaming={setRenaming}
            focusLiveTerminal={focusLiveTerminal}
            saveTitle={saveTitle}
            saveSummary={saveSummary}
            tasks={tasks}
            openTaskById={openTaskById}
            selectedFacts={selectedFacts}
            taskActions={taskActions}
            remoteUrl={remoteUrl}
            remotePending={remotePending}
            setEndIntent={setEndIntent}
            setArchiveTarget={setArchiveTarget}
            openFollowUp={openFollowUp}
            selectedBase={selectedBase}
            openFile={openFile}
            projectView={projectView}
            activeProject={activeProject}
            setNewTaskOpen={setNewTaskOpen}
            showTranscript={showTranscript}
            editorShowing={editorShowing}
            mode={mode}
            setMode={setMode}
            split={split}
            orientation={orientation}
            setOrientation={setOrientation}
            shellOpen={shellOpen}
            shellProject={shellProject}
            setShellOpen={setShellOpen}
          />

          {/* The project view has no terminal: its one pane is laid out as
              Transcript mode's is, with no edge against a hidden terminal. */}
          <div className="panes" data-orientation={orientation} data-mode={projectView ? 'transcript' : mode} ref={panesRef}>
            {/* No task: one message for the whole area, in every mode. Each
                pane used to say it separately -- the terminal, the transcript
                ("select a task" with none to select) and the files column, at
                three different heights -- and Transcript mode hid the only
                one that offered a next step. */}
            {!selected && !projectView && (
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
            <section className="pane pane-pty" ref={ptyPaneRef} style={primaryStyle} hidden={!showPty || !selected} data-focus-area="terminal">
              {/* A name only when there is another pane to tell it from: in
                  PTY mode the switch above already says "PTY". */}
              {split && (
                <div className="pane-head">
                  <span>Terminal</span>
                </div>
              )}
              <div className="pane-body">
                {/* Memoised per terminal (#364): a capture burst redraws none of them. */}
                <TerminalStack
                  tasks={openTasks.filter((task) => !stopped.has(task.id))}
                  selectedId={selectedId}
                  initialPromptFor={initialPromptFor}
                  spawnArgsFor={spawnArgsFor}
                  sessionNameFor={sessionNameFor}
                  forgetResume={forgetResume}
                />
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
            <div className="read-area" style={secondaryStyle} hidden={!projectView && (!showTranscript || !selected)}>
            <section className="pane pane-transcript">
              {/* Only when it tells panes or tabs apart: in Transcript mode with no
                  other tab, "Transcript" just repeated the switch above. */}
              {(split || projectView || readingTabs.length > 1) && (
              <div className="pane-head">
                <div className="tabs" role="tablist" aria-label="Reading pane">
                  {/* The project view has no session, so no transcript. */}
                  {!projectView && (
                    <button
                      role="tab"
                      aria-selected={activeTab === 'transcript'}
                      onClick={() => setRightTab('transcript')}
                      title={selected?.sessionId ? `Session ${selected.sessionId}` : 'No session yet'}
                    >
                      Transcript
                    </button>
                  )}
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
                  {guideTask && !projectView && (
                    <button
                      role="tab"
                      aria-selected={activeTab === 'guide'}
                      onClick={() => setRightTab('guide')}
                      title="This branch’s changes, grouped by what they do (⇧⌘G)"
                    >
                      Guide
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

              {/* A review copy behind its PR (#352): over every tab, since the
                  copy is what all three read. */}
              {selected?.reviewUrl && !projectView ? (
                <ReviewUpdateBand key={`ru-${selected.id}`} task={selected} onShowFiles={() => setRightTab('files')} />
              ) : null}
              {/* All three panels stay mounted so scroll position and editor
                  buffer survive a tab flip; only the task identity resets them. */}
              <div className="pane-body">
                <div className="tabpanel tabpanel-col" hidden={activeTab !== 'transcript'}>
                  {projectView ? (
                    /* Files pinned as a column and nothing open yet. */
                    <div className="placeholder">
                      <p>Open a file from the list, or with Go to File (⇧⌘O).</p>
                    </div>
                  ) : (
                  <>
                  {/* Above the transcript, and only while something is live:
                      when a session fans out the transcript itself goes quiet,
                      which is exactly when you need to know what is running. */}
                  <PaneErrorBoundary key={`sa-${selected?.id ?? 'none'}`} label="Subagents">
                    <Subagents sessionId={selected?.sessionId ?? null} taskTitle={selected?.title ?? null} />
                  </PaneErrorBoundary>
                  <PaneErrorBoundary key={`tx-${selected?.id ?? 'none'}`} label="Transcript">
                    <SpinOutContext.Provider value={spinOutLookup}>
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
                            {/* The context warning with Compact Now and Clear, only once
                                the session is past 70% of its window; the row's
                                hairline shows the rest. */}
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
                    </SpinOutContext.Provider>
                  </PaneErrorBoundary>
                  </>
                  )}
                </div>

                <div className="tabpanel" hidden={activeTab !== 'files'}>
                  {/* One Files pane per task (#363): while the column shows it,
                      this tab is off the strip, and a second copy here only
                      asked git everything again. It reloads only while it is
                      read: on screen, or stepped through by this task's editor. */}
                  {selected ? (
                    filesColumnShown ? null : (
                      <PaneErrorBoundary key={`tf-${selected.id}`} label="Touched files">
                        <TouchedFiles
                          task={selected}
                          activePath={editorTask?.id === selected.id ? editorFile : null}
                          menuSlot={tabFilesSlot}
                          active={showTranscript && (activeTab === 'files' || editorTask?.id === selected.id)}
                        />
                      </PaneErrorBoundary>
                    )
                  ) : projectView && browseTask ? (
                    /* Likewise the project view's (#364): the column has it. */
                    filesColumnShown ? null : (
                      <PaneErrorBoundary key={`pf-${browseTask.id}`} label="Project files">
                        <ProjectFiles task={browseTask} activePath={editorTask === browseTask ? editorFile : null} />
                      </PaneErrorBoundary>
                    )
                  ) : (
                    <div className="placeholder">No task selected.</div>
                  )}
                </div>

                <div className="tabpanel tabpanel-col" hidden={activeTab !== 'guide'}>
                  {guideTask && !projectView && (
                    <PaneErrorBoundary key={`gd-${guideTask.id}`} label="Review Guide">
                      <GuidePane task={guideTask} active={activeTab === 'guide' && showTranscript} />
                    </PaneErrorBoundary>
                  )}
                </div>

                <div className="tabpanel" hidden={activeTab !== 'editor'} data-focus-area="editor">
                  {editorTask && (
                    <PaneErrorBoundary key={`ed-${editorTask.id}`} label="Editor">
                      <EditorTabs
                        task={editorTask}
                        request={openRequest?.request ?? null}
                        step={openRequest?.step ?? false}
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
                  ref={filesPaneRef}
                  style={{ flex: filesFlex(filesWidth) }}
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
                    ) : projectView && browseTask ? (
                      <PaneErrorBoundary key={`pc-${browseTask.id}`} label="Project files">
                        <ProjectFiles task={browseTask} activePath={editorTask === browseTask ? editorFile : null} />
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
              ref={shellPaneRef}
              style={{ flex: shellFlex(shellHeight) }}
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
        <StatusBar awake={awakeCount} />
      </PaneErrorBoundary>

      <AppDialogs
        dialogs={dialogs}
        activeProject={activeProject}
        followUpSeq={followUpSeq}
        setPendingResume={setPendingResume}
        setPromptOverrides={setPromptOverrides}
        forgetResume={forgetResume}
        upsertTask={upsertTask}
        revealTask={revealTask}
        refresh={refresh}
        archive={archive}
        tasks={tasks}
        projects={projects}
        searchTask={searchTask}
        searchScopeLabel={searchScopeLabel}
        quickOpen={quickOpen}
        setQuickOpen={setQuickOpen}
        closeQuickOpen={closeQuickOpen}
        quickSeed={quickSeed}
        findOpen={findOpen}
        closeFind={closeFind}
        editorFile={editorFile}
        openFile={openFile}
        unhideProject={unhideProject}
        switchTab={switchTab}
        unclaimed={unclaimed}
        dismiss={dismiss}
        whatsNew={whatsNew}
        remoteConfirm={remoteConfirm}
        selected={selected}
        remindFor={remindFor}
        setRemindFor={setRemindFor}
        setStopped={setStopped}
        openRequestRef={openRequestRef}
        closeEditor={closeEditor}
      />
    </div>
    </MentionSourceContext.Provider>
    </TaskOpenContext.Provider>
    </FilePathContext.Provider>
    </FileTextContext.Provider>
    </FileOpenContext.Provider>
  );
}
