import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';
import type { Project, Task } from '../../types';
import { deleteTask } from '../../db';
import { endTaskEvents } from '../../capture/hookEvents';
import { newSessionId } from '../../capture/sessionLink';
import { resolveRequest } from '../requestQueue';
import type { remoteControlItem } from '../RemoteMark';
import type { QuickOpenMode } from '../quickOpenModel';
import ArchiveTaskDialog from '../ArchiveTaskDialog';
import FindInFiles from '../FindInFiles';
import ImportProjects from '../ImportProjects';
import MoveTaskDialog from '../MoveTaskDialog';
import NewTaskDialog from '../NewTaskDialog';
import ProjectsDialog from '../ProjectsDialog';
import QuickOpen from '../QuickOpen';
import RemindDialog from '../reminders/RemindDialog';
import RemoteControlDialog from '../RemoteControlDialog';
import SessionBrowser from '../SessionBrowser';
import ShortcutsHelp from '../ShortcutsHelp';
import WhatsNewDialog from '../WhatsNewDialog';
import WorktreeReconcile from '../WorktreeReconcile';
import type useTasks from '../useTasks';
import PaneErrorBoundary from './PaneErrorBoundary';
import type useDialogs from './useDialogs';
import type useEditorRequests from './useEditorRequests';
import type useLaunchNotices from './useLaunchNotices';
import type useProjectTabs from './useProjectTabs';
import type useSpawnPlan from './useSpawnPlan';
import type useWhatsNew from './useWhatsNew';

type Tasks = ReturnType<typeof useTasks>;
type Spawn = ReturnType<typeof useSpawnPlan>;
type Editor = ReturnType<typeof useEditorRequests>;
type ProjectTabs = ReturnType<typeof useProjectTabs>;
type Notices = ReturnType<typeof useLaunchNotices>;

/**
 * The frame's dialogs: New Task, Worktree Reconcile, Shortcuts, Go to, Find
 * in Files, Projects, Import, Past Sessions, What's New, Remote Control,
 * Reminders, Move and Archive. Which are open is useDialogs' state; what
 * each one's close or result does is here, as it was in App.
 */
export default function AppDialogs({
  dialogs,
  activeProject,
  followUpSeq,
  setPendingResume,
  setPromptOverrides,
  forgetResume,
  upsertTask,
  revealTask,
  refresh,
  archive,
  tasks,
  projects,
  searchTask,
  searchScopeLabel,
  quickOpen,
  setQuickOpen,
  closeQuickOpen,
  quickSeed,
  findOpen,
  closeFind,
  editorFile,
  openFile,
  unhideProject,
  switchTab,
  unclaimed,
  dismiss,
  whatsNew,
  remoteConfirm,
  selected,
  remindFor,
  setRemindFor,
  setStopped,
  openRequestRef,
  closeEditor,
}: {
  dialogs: ReturnType<typeof useDialogs>;
  activeProject: Project | null;
  followUpSeq: MutableRefObject<number>;
  setPendingResume: Spawn['setPendingResume'];
  setPromptOverrides: Spawn['setPromptOverrides'];
  forgetResume: Spawn['forgetResume'];
  upsertTask: Tasks['upsertTask'];
  revealTask: (task: Task) => void;
  refresh: Tasks['refresh'];
  archive: Tasks['archive'];
  tasks: Tasks['tasks'];
  projects: Tasks['projects'];
  searchTask: Task | null;
  searchScopeLabel: string | null;
  quickOpen: QuickOpenMode | null;
  setQuickOpen: Dispatch<SetStateAction<QuickOpenMode | null>>;
  closeQuickOpen: () => void;
  quickSeed: { text: string } | null;
  findOpen: boolean;
  closeFind: () => void;
  editorFile: string | null;
  openFile: Editor['openFile'];
  unhideProject: ProjectTabs['unhideProject'];
  switchTab: ProjectTabs['switchTab'];
  unclaimed: Notices['unclaimed'];
  dismiss: Notices['dismiss'];
  whatsNew: ReturnType<typeof useWhatsNew>;
  remoteConfirm: ReturnType<typeof remoteControlItem> | null;
  selected: Task | null;
  remindFor: Task | null;
  setRemindFor: Dispatch<SetStateAction<Task | null>>;
  setStopped: Dispatch<SetStateAction<ReadonlySet<number>>>;
  openRequestRef: Editor['openRequestRef'];
  closeEditor: Editor['closeEditor'];
}): ReactNode {
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
    setRemoteConfirmFor,
  } = dialogs;

  return (
    <>
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
        onCreated={(task: Task, initialPrompt?: string, forkOf?: string) => {
          // An approved session request is done once its task exists, and
          // its transcript says which task it became (#332).
          if (newTaskPrefill?.request) resolveRequest(newTaskPrefill.request.id, task);
          // A fork (#332): the first spawn copies the source's session under
          // a new id, as History's fork does; the first message, if any,
          // goes after the copy (Terminal). The id is chosen here so the
          // spawn plan and `--name … (fork)` both see a fork.
          if (forkOf) {
            setPendingResume((prev) =>
              new Map(prev).set(task.id, ['--resume', forkOf, '--fork-session', '--session-id', newSessionId()]),
            );
          }
          if (initialPrompt !== undefined) {
            setPromptOverrides((prev) => new Map(prev).set(task.id, initialPrompt));
          }
          followUpSeq.current++;
          setNewTaskPrefill(null);
          upsertTask(task);
          // revealTask, not select: a new task can land in a closed tab,
          // which must open before the task can show (see revealTask).
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
        seed={quickSeed}
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
        // The hidden set lives in React state, read from localStorage once
        // at mount — a write to the key alone would not bring the tab back
        // until a relaunch.
        onUnhideProject={unhideProject}
        onChanged={(created) => {
          void refresh();
          // Follow the project that was just made. Without this the new tab
          // appears but stays in the background, and a task created into it
          // is filtered out of the active tab and silently deselected.
          if (created) switchTab(`p${created.id}`);
        }}
        onCreateTaskIn={(project) => {
          // The dialog already remembers the project it just created as the
          // new-task default, so this only has to switch to its tab and open
          // the dialog.
          switchTab(`p${project.id}`);
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
          if (first) switchTab(`p${first.id}`);
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

    {whatsNew.open && (
      <PaneErrorBoundary label="What's New">
        <WhatsNewDialog list={whatsNew.open} onClose={whatsNew.dismiss} />
      </PaneErrorBoundary>
    )}

    {remoteConfirm && selected && (
      <PaneErrorBoundary label="Remote Control">
        <RemoteControlDialog
          task={selected}
          onConfirm={remoteConfirm.onSelect}
          onClose={() => setRemoteConfirmFor(null)}
        />
      </PaneErrorBoundary>
    )}

    {remindFor && (
      <PaneErrorBoundary label="Reminders">
        <RemindDialog task={remindFor} onClose={() => setRemindFor(null)} />
      </PaneErrorBoundary>
    )}

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
    </>
  );
}
