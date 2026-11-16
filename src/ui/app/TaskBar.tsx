import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Project, Task } from '../../types';
import type { PrStatus } from '../../gh/prStatus';
import { PrBadge } from '../PrBadge';
import { ReviewBadge } from '../SubmitReview';
import BranchChip from '../BranchChip';
import ModelPicker from '../ModelPicker';
import MoreGlyph from '../MoreGlyph';
import OverflowMenu from '../OverflowMenu';
import ProjectBar from '../ProjectBar';
import SpunFromChip from '../SpunFromChip';
import TaskTitleEdit from '../TaskTitleEdit';
import { RemoteLink, type useRemotePending } from '../RemoteMark';
import { ChatIcon, FolderIcon, PtyLayoutIcon, SplitLayoutIcon, TranscriptLayoutIcon, homeRelative } from '../icons';
import { createPrPrompt, resolveConflictsPrompt } from '../gitPrompts';
import { sendPrompt } from '../sendPrompt';
import { taskMenuItems, type TaskActions } from '../taskMenuItems';
import { RENAME_KEYS } from '../taskRename';
import { wrapForTooltip } from '../text';
import type { useTaskMenuFacts } from '../useTaskMenuFacts';
import type { useMeasuredBase } from '../useMeasuredBase';
import type useTasks from '../useTasks';
import type useEditorRequests from './useEditorRequests';
import type useLayout from './useLayout';

type Layout = ReturnType<typeof useLayout>;
type Renaming = { id: number; by: 'key' | 'pointer' } | null;

/**
 * The bar above the panes: the selected task's project, name, summary,
 * actions, branch, PR and folder (or the project view's bar), then the pane
 * layout switch, the orientation and the shell drawer's toggle.
 */
export default function TaskBar({
  selected,
  selectedProject,
  selectedProjectIsForeign,
  openProjectView,
  renaming,
  setRenaming,
  focusLiveTerminal,
  saveTitle,
  saveSummary,
  tasks,
  openTaskById,
  selectedFacts,
  taskActions,
  remoteUrl,
  remotePending,
  setEndIntent,
  setArchiveTarget,
  openFollowUp,
  selectedBase,
  openFile,
  projectView,
  activeProject,
  setNewTaskOpen,
  showTranscript,
  editorShowing,
  mode,
  setMode,
  split,
  orientation,
  setOrientation,
  shellOpen,
  shellProject,
  setShellOpen,
}: {
  selected: Task | null;
  selectedProject: Project | null;
  selectedProjectIsForeign: boolean;
  openProjectView: (projectId: number) => void;
  renaming: Renaming;
  setRenaming: Dispatch<SetStateAction<Renaming>>;
  focusLiveTerminal: (taskId: number) => void;
  saveTitle: (task: Task, title: string) => void;
  saveSummary: (task: Task, summary: string | null) => void;
  tasks: ReturnType<typeof useTasks>['tasks'];
  openTaskById: (taskId: number) => void;
  selectedFacts: ReturnType<typeof useTaskMenuFacts>;
  taskActions: TaskActions;
  remoteUrl: ReturnType<typeof useTaskMenuFacts>['remoteUrl'];
  remotePending: ReturnType<typeof useRemotePending>;
  setEndIntent: Dispatch<SetStateAction<'archive' | 'delete'>>;
  setArchiveTarget: Dispatch<SetStateAction<Task | null>>;
  openFollowUp: (task: Task, known?: PrStatus | null) => Promise<void>;
  selectedBase: ReturnType<typeof useMeasuredBase>;
  openFile: ReturnType<typeof useEditorRequests>['openFile'];
  projectView: boolean;
  activeProject: Project | null;
  setNewTaskOpen: Dispatch<SetStateAction<boolean>>;
  showTranscript: boolean;
  editorShowing: boolean;
  mode: Layout['mode'];
  setMode: Layout['setMode'];
  split: boolean;
  orientation: Layout['orientation'];
  setOrientation: Layout['setOrientation'];
  shellOpen: boolean;
  shellProject: Project | null;
  setShellOpen: Layout['setShellOpen'];
}): ReactNode {
  return (
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
                {/* The way back to the project itself (#181): its view,
                    where the tab clicked again also goes. */}
                <button
                  type="button"
                  className="main-ident-project"
                  data-foreign={selectedProjectIsForeign}
                  title={
                    (selectedProjectIsForeign
                      ? `This task is in ${selectedProject.name}, not the project the list is showing`
                      : selectedProject.repoPath) + `\nShow ${selectedProject.name}`
                  }
                  onClick={() => openProjectView(selectedProject.id)}
                >
                  {selectedProject.name}
                </button>
                <span className="main-ident-sep" aria-hidden="true">›</span>
              </>
            )}
            {renaming?.id === selected.id ? (
              <TaskTitleEdit
                className="main-ident-title-edit"
                summaryClassName="main-ident-summary-edit"
                title={selected.title}
                summary={selected.summary}
                returnFocus={renaming.by === 'key' ? 'previous' : 'fallback'}
                fallbackFocus={() => focusLiveTerminal(selected.id)}
                onSave={(title) => {
                  setRenaming(null);
                  saveTitle(selected, title);
                }}
                onSaveSummary={(summary) => {
                  setRenaming(null);
                  saveSummary(selected, summary);
                }}
                onDone={() => setRenaming(null)}
              />
            ) : (
              <>
                <span
                  className="main-ident-title"
                  title={`${wrapForTooltip(selected.title)}\n${selected.worktreePath}\nDouble-click to rename (${RENAME_KEYS})`}
                  onDoubleClick={() => setRenaming({ id: selected.id, by: 'pointer' })}
                >
                  {selected.title}
                </span>
                {/* Where it came from (#332): against the name, which
                    it qualifies, and before the summary, which goes
                    first when the bar is short. */}
                <SpunFromChip task={selected} tasks={tasks} onOpen={openTaskById} />
                {/* What the task is about (#262), after its name: it
                    takes only room nothing else wants, so it goes
                    first when the bar is short and never cuts the
                    title. The tooltip has it whole. */}
                {selected.summary && (
                  <span
                    className="main-ident-summary"
                    title={`${wrapForTooltip(selected.summary)}\nDouble-click to edit (${RENAME_KEYS})`}
                    onDoubleClick={() => setRenaming({ id: selected.id, by: 'pointer' })}
                  >
                    {selected.summary}
                  </span>
                )}
              </>
            )}
            {/* What acts on the task, right after its name; the ⋯ at
                the bar's end keeps what acts on the panes. */}
            <OverflowMenu
              label={`Actions for ${selected.title}`}
              title="Task actions"
              trigger={{ className: 'icon-btn main-ident-more', content: <MoreGlyph /> }}
              // The same list as the row's menu (#331), with no heading:
              // the task's name is right beside it.
              items={taskMenuItems(selected, selectedFacts, taskActions, () =>
                setRenaming({ id: selected.id, by: 'pointer' }),
              )}
            />
            {/* Reachable through Remote Control, against the name: it
                is about the session, not the branch after it. */}
            <RemoteLink url={remoteUrl} variant="bar" pending={remotePending} />
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
              <BranchChip task={selected} />
            ) : null}
            {/* The PR, beside the branch it belongs to: with the branch,
                the one place git and GitHub state shows. It never
                shrinks; the title and the folder give way first. A chat
                has neither, and nothing takes their place. */}
            {/* A review task (#287): the pull request it is for, one
                click to GitHub. Its branch is Albedo's copy, which has
                no PR of its own, so the badge below would offer to
                create one. */}
            {/* Submit Review (#287, step 3) beside it: the review
                task's one main action, as Merge is beside your own
                PR's badge. */}
            {!!selected.reviewUrl && <ReviewBadge task={selected} />}
            {selected.kind !== 'chat' && !selected.reviewUrl && (
            <PrBadge
              task={selected}
              onEnd={(intent) => {
                setEndIntent(intent);
                setArchiveTarget(selected);
              }}
              onFollowUp={(pr) => void openFollowUp(selected, pr)}
              onCreatePr={() => void sendPrompt(selected, createPrPrompt(selectedBase.base !== '' ? { ...selected, baseBranch: selectedBase.base } : selected))}
              onResolveConflicts={(pr) => void sendPrompt(selected, resolveConflictsPrompt(selected, pr))}
              onOpenFile={openFile}
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
        ) : projectView && activeProject ? (
          <ProjectBar project={activeProject} onNewTask={() => setNewTaskOpen(true)} />
        ) : null}
      </div>

      {/* The picker lives beside Send in the composer; only with the
          transcript hidden (terminal only) does it fall back to here. */}
      {selected && !showTranscript && <ModelPicker task={selected} />}

      {/* The project view has one pane: nothing to lay out. */}
      {!editorShowing && !projectView && (
        /* Icons (#317): the words took 192px of a bar the title and
           branch need; the names are each button's label and tooltip. */
        <div className="seg seg-icons" role="group" aria-label="Pane layout">
          <button aria-pressed={mode === 'pty'} onClick={() => setMode('pty')} aria-label="PTY" title="Terminal only (⌘\)">
            <PtyLayoutIcon />
          </button>
          <button aria-pressed={mode === 'split'} onClick={() => setMode('split')} aria-label="Split" title="Split (⌘\)">
            <SplitLayoutIcon />
          </button>
          <button
            aria-pressed={mode === 'transcript'}
            onClick={() => setMode('transcript')}
            aria-label="Transcript"
            title="Transcript only (⌘\)"
          >
            <TranscriptLayoutIcon />
          </button>
        </div>
      )}

      {/* Two icons where a ⋯ held two items: the orientation only
          means something in Split, and the shell keeps ⌥F12. */}
      {split && !projectView && (
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
            ? `Shell in ${shellProject.name}'s main checkout (⌘T or ⌥F12)`
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
  );
}
