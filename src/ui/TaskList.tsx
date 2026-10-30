import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Project, Task } from '../types';
import { ContextMeter, contextLevel, contextReadout, contextTitle } from './StatusDot';
import { parseIssueKey } from '../lib/issueKey';
import EmptyState from './EmptyState';
import MoreGlyph from './MoreGlyph';
import { wrapForTooltip } from './text';
import type { ContextUsage } from '../capture';
import type { TaskSignals } from './useTasks';
import type { AttentionKind } from './attention';
import { useShortcuts } from './shortcuts';
import { canFollowUp } from './followUp';
import { getPrStatus, usePrPolling, usePrStatusVersion } from '../gh/prStore';
import { ciMarkFor, useCiVersion } from './ciNotice';
import { useBranchSync } from '../git/branchSync';
import { getReviewWork, useReviewWorkProbes, useReviewWorkVersion } from '../git/reviewWork';
import {
  canMarkDone,
  canMarkNotDone,
  compareInGroup,
  GROUP_GLYPH,
  GROUP_ORDER,
  GROUP_TITLE,
  groupOf,
  wantsWorkProbe,
  type GroupFacts,
  type GroupKey,
} from './taskGroups';
import { ChatIcon } from './icons';
import RemoteMark from './RemoteMark';
import { BackgroundMark } from './BackgroundWork';
import { useDraftTaskIds } from './transcript/drafts';
import TaskTitleEdit from './TaskTitleEdit';
import { RENAME_HINT } from './taskRename';
import './tasklist.css';

/** The row's word for a chat, in its tooltip where a branch would be. */
const CHAT_ROW_TITLE = 'Chat — no branch, in the main checkout as it is';

/**
 * Left rail. With several sessions running in parallel the only question that
 * matters is "which one is waiting on me", so blocked tasks are lifted into
 * their own group at the top rather than sorted in among the rest.
 */

export interface TaskListProps {
  tasks: Task[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  /**
   * Opens the archive confirmation for a task. Optional so the
   * four-prop signature still type-checks; when absent the affordance is
   * simply not rendered.
   */
  onArchive?: (task: Task) => void;
  /**
   * Ends the task for good. Distinct from {@link TaskListProps.onArchive}: see
   * the menu copy, which has to keep three verbs apart on one surface.
   */
  onDelete?: (task: Task) => void;
  /**
   * Opens the new-task dialog prefilled as a follow-up. Offered in the menu
   * only for a task whose PR is merged, or that is archived (whose PR is not
   * polled, so merged or not is looked up when the dialog opens).
   */
  onFollowUp?: (task: Task) => void;
  /**
   * Mark as Done, or with false, Mark as Not Done. Offered in the menu only
   * where it can hold (`canMarkDone` / `canMarkNotDone`).
   */
  onSetDone?: (task: Task, done: boolean) => void;
  /**
   * Saves a new title (already cleaned, and different). Offered in the row
   * menu as "Rename Task…", which edits the title in place on the row.
   */
  onRename?: (task: Task, title: string) => void;
  /**
   * Where focus goes once the row's name field closes on its own key or
   * leaving the window (the selected task's terminal, in App): the menu it
   * was started from is gone.
   */
  onRenameClosed?: () => void;
  /** Context-window usage keyed by sessionId, fetched once for the whole list. */
  /** Running agents and a pending question, per task (useTasks). */
  signals?: Map<number, TaskSignals>;
  contextBySession?: Map<string, ContextUsage>;
  /**
   * Tasks asking for attention, from `ui/attention`. Optional, so the list
   * renders identically without it -- the mark is an addition to the row, not
   * a state it depends on.
   */
  attention?: ReadonlyMap<number, AttentionKind>;
  /**
   * Opens the project manager. Offered from the empty state because a task is
   * cut from a project: on a fresh install ⌘N has nowhere to go until one
   * exists.
   */
  onManageProjects?: () => void;
  /**
   * Projects, name-ascending. Rendered as groups even when EMPTY: a project
   * with no tasks still has to be visible, or creating one looks like nothing
   * happened — which is exactly how it felt.
   */
  projects?: Project[];
  /**
   * The project this list is scoped to — the active tab, or the sole project
   * when there is no tab bar. Null only when there are no projects at all.
   */
  activeProject?: Project | null;
  /**
   * Whether this header is responsible for naming the project. False when a
   * tab bar is above it already doing the naming — two labels saying the same
   * thing is how a scope label stops being read.
   */
  nameProject?: boolean;
  /**
   * The main area is showing the full empty state (no task selected), so the
   * list only needs its headline: a second explanation and a second New Task
   * button right under the ⌘N one said the same thing twice.
   */
  emptyBrief?: boolean;
}

/** Row context menu. Destructive actions live here, never on the row itself. */
interface RowMenu {
  task: Task;
  x: number;
  y: number;
}

/*
 * Status is the PRIMARY axis inside the list. Project scoping happens a level
 * up, in the tab bar, precisely so this grouping stays flat: "which session is
 * waiting on me" must never be more than one glance deep. The groups and their
 * order are `taskGroups.ts`.
 */

/** Compact, glanceable age. "now", 45s, 12m, 3h, 6d. */
export function relativeTime(ts: number | null, now: number): string {
  if (!ts) return '—';
  const delta = Math.max(0, now - ts);
  const s = Math.floor(delta / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function projectName(task: Task, projects: Project[] | undefined): string | null {
  if (task.projectId === null) return null;
  return projects?.find((p) => p.id === task.projectId)?.name ?? null;
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? (parts[parts.length - 1] as string) : path;
}

export default function TaskList({
  tasks,
  selectedId,
  onSelect,
  attention,
  onNew,
  onArchive,
  onDelete,
  onFollowUp,
  onSetDone,
  onRename,
  onRenameClosed,
  contextBySession,
  signals,
  onManageProjects,
  projects,
  activeProject = null,
  nameProject = false,
  emptyBrief = false,
}: TaskListProps) {
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState<RowMenu | null>(null);
  /** The row whose title is being edited in place (#152). */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const drafts = useDraftTaskIds();

  /*
   * PR status for the rows on screen. The list owns the polling because it
   * owns "visible": these are exactly the tasks the owner can see a mark for.
   * One subscription for the whole list; rows read the cache directly.
   */
  // A chat has no branch: no PR to poll, and no branch to sync -- syncing
  // would record whatever the main checkout is on as the chat's branch.
  const branchTasks = useMemo(() => tasks.filter((t) => t.kind !== 'chat'), [tasks]);
  usePrPolling(branchTasks);
  const prVersion = usePrStatusVersion();
  // Unseen check results (ciNotice.ts); rows read the marks directly.
  useCiVersion();
  const workVersion = useReviewWorkVersion();
  // The stored branch goes stale when a checkout is switched under a task, and
  // the PR lookup above keys on it. A change reloads the tasks, which re-arms it.
  useBranchSync(branchTasks);

  // Ages only need to be roughly right.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Dismiss the row menu on anything that moves the world under it.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // Capture-phase, so it beats anything else — but a press inside the menu
    // must survive long enough for the item's own click to land.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      scroller?.removeEventListener('scroll', close);
    };
  }, [menu]);

  /**
   * Two axes, deliberately not nested.
   *
   * Projects are the mental model the feature introduced, so they are the
   * structure. But "which session is waiting on me" is the question this app
   * exists to answer, and burying a blocked task three project headers down
   * would answer it worse than the flat list did. So blocked tasks are LIFTED
   * OUT into one triage group pinned above every project, carrying their
   * project name on the row; the project groups hold everything else.
   */
  const facts = useMemo(() => {
    const byId = new Map<number, GroupFacts>();
    for (const task of tasks) {
      const finishedAt = signals?.get(task.id)?.finishedAt ?? null;
      byId.set(task.id, {
        finishedAt,
        pr: task.kind === 'chat' ? null : getPrStatus(task.id),
        work: getReviewWork(task.id, finishedAt),
      });
    }
    return byId;
    // The versions stand for the caches read through getPrStatus/getReviewWork.
  }, [tasks, signals, prVersion, workVersion]);

  // Whether a finish left work on the branch is asked once per unseen finish.
  const probes = useMemo(
    () =>
      tasks.flatMap((task) => {
        const f = facts.get(task.id);
        return f && f.finishedAt !== null && wantsWorkProbe(task, f) ? [{ task, finishedAt: f.finishedAt }] : [];
      }),
    [tasks, facts],
  );
  useReviewWorkProbes(probes);

  const sections = useMemo(() => {
    const none: GroupFacts = { finishedAt: null, pr: undefined, work: undefined };
    const factsOf = (t: Task) => facts.get(t.id) ?? none;
    const buckets = new Map<GroupKey, Task[]>();
    for (const key of GROUP_ORDER) buckets.set(key, []);
    for (const task of tasks) buckets.get(groupOf(task, factsOf(task)))?.push(task);
    for (const [key, list] of buckets) {
      list.sort((a, b) => compareInGroup(key, a, factsOf(a), b, factsOf(b)));
    }
    return GROUP_ORDER.map((key) => ({ key, tasks: buckets.get(key) ?? [] })).filter(
      (g) => g.tasks.length > 0,
    );
  }, [tasks, facts]);

  /** Render order — the order arrow keys and ⌘1..9 walk. */
  const ordered = useMemo(() => sections.flatMap((g) => g.tasks), [sections]);

  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  /*
   * The list owns the shortcuts that depend on ITS ordering. `ordered` is the
   * grouped, blocked-first sequence the user actually sees, so ⌘3 and ⌘] have
   * to be resolved here -- App's `visibleTasks` is in a different order, and
   * jumping to a different task than the one numbered 3 on screen is worse
   * than having no shortcut.
   *
   * Bare arrow keys stay on the list element itself (see `onKeyDown`) so they
   * do not fight the terminal for the keyboard.
   */
  useShortcuts({
    'mod+n': () => onNewRef.current(),
    'mod+digit': (_e, digit) => {
      const task = orderedRef.current[(digit ?? 1) - 1];
      if (task) onSelectRef.current(task.id);
    },
    'mod+[': () => step(-1),
    'mod+]': () => step(1),
  });

  // Keep the selected row in view when selection moves from elsewhere.
  useEffect(() => {
    if (selectedId === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-task-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  /*
   * Shared by ⌘[ / ⌘] and by the bare arrow keys. Reads through refs because
   * the shortcut handler is registered once and must not close over a stale
   * list -- the same reason `move` below takes its list from `orderedRef`.
   */
  const step = (delta: number) => {
    const list = orderedRef.current;
    if (list.length === 0) return;
    const current = list.findIndex((t) => t.id === selectedRef.current);
    const next = current === -1 ? (delta > 0 ? 0 : list.length - 1) : current + delta;
    const task = list[Math.min(list.length - 1, Math.max(0, next))];
    if (task) onSelectRef.current(task.id);
  };

  const move = (delta: number) => {
    const list = orderedRef.current;
    if (list.length === 0) return;
    const current = list.findIndex((t) => t.id === selectedRef.current);
    const next = current === -1 ? (delta > 0 ? 0 : list.length - 1) : current + delta;
    const clamped = Math.min(list.length - 1, Math.max(0, next));
    const task = list[clamped];
    if (task) onSelect(task.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      move(-1);
    }
  };

  /**
   * Destructive actions are deliberately two-step: they are never a click
   * adjacent to the selection target. Reachable from the hover control or a
   * right-click anywhere on the row.
   */
  const openMenu = (e: ReactMouseEvent<HTMLElement>, task: Task) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ task, x: e.clientX, y: e.clientY });
  };

  const blockedCount = tasks.filter((t) => t.status === 'blocked').length;
  const liveCount = tasks.filter((t) => t.status !== 'archived').length;

  return (
    /* A stop of the Tab cycle (focusAreas.ts): the list itself takes focus,
       since it is where ↑/↓ are handled, and the selected row shows which. */
    <div className="tasklist" tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-label="Tasks" data-focus-area="tasks">
      <div className="tasklist-head" data-bare={!nameProject || undefined}>
        {/* Identity lives here because this strip is always visible, never
            scrolls, and is already the scope label for the list beneath it.
            It is a control, not a caption: someone asking "which project am I
            in" is usually one keystroke from "and how do I change it".
            With project tabs in the title bar, the tab is the scope label and
            already carries the count, so this strip keeps only New Task. */}
        {nameProject && (
        <button
          className="tasklist-scope"
          data-named={nameProject && !!activeProject}
          onClick={onManageProjects}
          disabled={!onManageProjects}
          title={
            nameProject && activeProject
              ? `${activeProject.name} — ${activeProject.repoPath}\nManage projects`
              : 'Manage projects'
          }
        >
          {nameProject && activeProject ? activeProject.name : 'Tasks'}
        </button>
        )}
        {nameProject && (
          <span className="tasklist-count" title={`${blockedCount} blocked of ${liveCount}`}>
            {blockedCount > 0 ? `${blockedCount}/${liveCount}` : liveCount}
          </span>
        )}
        <button className="btn" onClick={onNew} title="New task (⌘N)">
          New Task
          <span className="kbd" aria-hidden="true">
            ⌘N
          </span>
        </button>
      </div>

      <div className="tasklist-scroll" ref={scrollRef}>
        {ordered.length === 0 && (
          <EmptyState
            projectCount={projects?.length ?? 0}
            activeProject={activeProject}
            onAddProject={onManageProjects}
            onNewTask={onNew}
            variant="list"
            brief={emptyBrief}
          />
        )}

        {sections.map((group) => (
          <div key={group.key}>
            <div className="group-label" data-tone={group.key}>
              <span className="status-dot" data-status={GROUP_GLYPH[group.key]} aria-hidden="true" />
              <span>{GROUP_TITLE[group.key]}</span>
              <span className="group-count">{group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const index = ordered.indexOf(task);
              const issue = parseIssueKey(task.title);
              const ctx = task.sessionId ? contextBySession?.get(task.sessionId) : undefined;
              const ctxLevel = ctx ? contextLevel(ctx.fraction) : null;
              // Quiet sessions say nothing. The number appears only once it is
              // worth reading, which is what keeps it unobtrusive.
              const ctxText = ctx && ctxLevel !== 'quiet' ? contextReadout(ctx) : null;
              const sig = signals?.get(task.id);
              return (
                <div
                  key={task.id}
                  className="task-row"
                  data-task-id={task.id}
                  data-selected={task.id === selectedId}
                  data-status={task.status}
                  /* Drives the pulse. Present only until the row is selected,
                     so it never becomes permanent decoration. */
                  data-attention={attention?.get(task.id) ?? undefined}
                  data-menu-open={menu?.task.id === task.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={task.id === selectedId}
                  onClick={() => onSelect(task.id)}
                  onContextMenu={(e) => openMenu(e, task)}
                  /* Wrapped, not raw: a native title cannot break lines
                     itself, so a paragraph-length task title renders as one
                     window-wide strip that covers whatever it was describing
                     — including the row's own context menu. */
                  /* The row's details on hover: the context reading the
                     hairline draws, in words, now that no panel shows it. */
                  title={`${wrapForTooltip(task.title)}\n${task.kind === 'chat' ? CHAT_ROW_TITLE : task.branch}${ctx ? `\n${contextTitle(ctx)}` : ''}`}
                >
                  {/* The group's glyph, not the bare status: a row lifted into
                      Ready to Review or Done by something other than its
                      status wears the shape of the group it sits in. */}
                  <span className="task-dot-cell">
                    <span
                      className="status-dot"
                      data-status={GROUP_GLYPH[group.key]}
                      role="img"
                      aria-label={GROUP_TITLE[group.key]}
                      title={GROUP_TITLE[group.key]}
                    />
                  </span>
                  {/* The key IS the task's identity to the user, so it reads
                      as its own chip down the left edge instead of being the
                      first few characters of a sentence. Identifier, not a
                      sort axis -- grouping stays status-first. */}
                  {renamingId === task.id && onRename ? (
                    <TaskTitleEdit
                      className="task-row-title-edit"
                      title={task.title}
                      returnFocus="fallback"
                      fallbackFocus={onRenameClosed}
                      onSave={(title) => {
                        setRenamingId(null);
                        onRename(task, title);
                      }}
                      onDone={() => setRenamingId(null)}
                    />
                  ) : (
                  <span className="task-title">
                    {issue ? (
                      <>
                        <span className="task-key">{issue.key}</span>
                        {issue.rest && <span className="task-rest">{issue.rest}</span>}
                      </>
                    ) : (
                      task.title
                    )}
                  </span>
                  )}
                  <span className="task-age">{relativeTime(task.lastActivityAt, now)}</span>
                  {/* Shares the age's spot and swaps in on hover: reserving
                      its own width hid on every row cut titles short. */}
                  {index < 9 && <span className="task-index kbd">⌘{index + 1}</span>}
                  <span className="task-meta">
                    {/* When a project tab is active the repo is already the
                        tab; repeating it on every row is noise. On "All" it is
                        the one thing you need, because rows come from
                        everywhere. */}
                    {(!activeProject || task.projectId !== activeProject.id) && (
                      <>
                        <span className="task-repo">
                          {projectName(task, projects) ?? basename(task.repoPath)}
                        </span>
                        <span className="task-sep">/</span>
                      </>
                    )}
                    {/* No branch and no PR state here: the task bar is the one
                        place git and GitHub state is shown, for the selected
                        task. Rows identify the task; the title does that. The
                        one exception is news, not state: checks that finished
                        since the task was last open (CiRowMark). */}
                    <span className="task-meta-tail">
                      {/* PR checks that finished since the task was last
                          open: ✓ or ✗ and the word, until it is opened
                          (ciNotice.ts). First in the tail: it is news, the
                          rest is state. Never on the selected row -- it is
                          being looked at, and its PR badge carries a cue. */}
                      {task.id !== selectedId && <CiRowMark taskId={task.id} />}
                      {/* An unsent message waiting in this task's composer, so a
                          forgotten one can be found. Not on the selected row:
                          its draft is in the box right below. */}
                      {drafts.has(task.id) && task.id !== selectedId && (
                        <span className="task-draft" title="An unsent message is waiting in this task's message box">
                          Draft
                        </span>
                      )}
                      {/* Reachable through Remote Control: a click opens it on
                          claude.ai. Only while on (RemoteMark.tsx), and not on
                          the selected row: the task bar shows it there. */}
                      {task.id !== selectedId && <RemoteMark task={task} variant="row" />}
                      {/* Idle, with work still running that will report back
                          or wake it: "2 in background". The group says Idle.
                          Not on the selected row: its Background band lists
                          the same work above the composer. */}
                      {task.status === 'idle' && task.id !== selectedId && <BackgroundMark task={task} />}
                      {/* A chat is told apart by a glyph, not a word: same
                          size, stroke and tier as the branch glyph. */}
                      {task.kind === 'chat' && (
                        <span className="task-chat" role="img" aria-label="Chat, no branch" title={CHAT_ROW_TITLE}>
                          <ChatIcon />
                        </span>
                      )}
                      {sig && sig.agents > 0 && (
                        <span
                          className="task-agents"
                          title={`${sig.agents} agent${sig.agents === 1 ? '' : 's'} running`}
                        >
                          ·{sig.agents}
                        </span>
                      )}
                      {sig?.question && (
                        <span
                          className="task-question"
                          role="img"
                          aria-label="Asks you a question"
                          title="Its last turn ends on a question for you"
                        >
                          ?
                        </span>
                      )}
                      {ctx && ctxText && (
                        <span className="task-ctx-text" data-level={ctxLevel} title={contextTitle(ctx)}>
                          {ctxText}
                        </span>
                      )}
                    </span>
                  </span>
                  <ContextMeter usage={ctx} variant="hairline" />
                  {(onArchive || onDelete) && (
                    <button
                      className="task-more"
                      aria-label={`Actions for ${task.title}`}
                      title="Actions"
                      onClick={(e) => openMenu(e, task)}
                      onContextMenu={(e) => openMenu(e, task)}
                    >
                      <MoreGlyph />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {menu && (
        <div
          className="row-menu"
          ref={menuRef}
          style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}
          role="menu"
        >
          <div className="row-menu-head" title={wrapForTooltip(menu.task.title)}>
            {menu.task.title}
          </div>
          {/* Edits the title here on the row, where it was right-clicked,
              without selecting the task: selecting would move focus to its
              terminal, and that blur would save the field the moment it opened. */}
          {onRename && (
            <button
              className="row-menu-item"
              role="menuitem"
              title={RENAME_HINT}
              onClick={() => {
                const task = menu.task;
                setMenu(null);
                setRenamingId(task.id);
              }}
            >
              Rename Task…
              <span className="row-menu-hint">branch and folder kept</span>
            </button>
          )}
          <button
            className="row-menu-item"
            role="menuitem"
            onClick={() => {
              const path = menu.task.worktreePath;
              setMenu(null);
              void navigator.clipboard?.writeText(path).catch(() => {});
            }}
          >
            Copy Worktree Path
          </button>
          {onSetDone && canMarkDone(menu.task, getPrStatus(menu.task.id)) && (
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => {
                const task = menu.task;
                setMenu(null);
                onSetDone(task, true);
              }}
            >
              Mark as Done
              <span className="row-menu-hint">worktree and session kept</span>
            </button>
          )}
          {onSetDone && canMarkNotDone(menu.task, getPrStatus(menu.task.id)) && (
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => {
                const task = menu.task;
                setMenu(null);
                onSetDone(task, false);
              }}
            >
              Mark as Not Done
            </button>
          )}
          {onFollowUp && canFollowUp(menu.task, getPrStatus(menu.task.id)) && (
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => {
                const task = menu.task;
                setMenu(null);
                onFollowUp(task);
              }}
            >
              Follow-Up…
              <span className="row-menu-hint">new task from the base</span>
            </button>
          )}
          {/*
            Three verbs now meet on one surface and the wording is what keeps
            them apart, so each says what it costs rather than just naming
            itself:

              Close    hide the tab — view state, on the tab bar, not here
              Archive  out of the active list
              Delete   gone, worktree optional, CONVERSATION KEPT

            That last clause is the reason Delete can sit next to Archive at
            all, and the dialog states it too. Saying it here as well is what
            makes the menu safe to trust before it is opened.
          */}
          {onArchive && (
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => {
                const task = menu.task;
                setMenu(null);
                onArchive(task);
              }}
            >
              Archive Task…
              <span className="row-menu-hint">out of the active list</span>
            </button>
          )}
          {onDelete && (
            <button
              className="row-menu-item"
              data-tone="danger"
              role="menuitem"
              onClick={() => {
                const task = menu.task;
                setMenu(null);
                onDelete(task);
              }}
            >
              Delete Task…
              <span className="row-menu-hint">worktree optional · conversation kept</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** An unseen pass or failure of the task's PR checks; nothing when there is none. */
function CiRowMark({ taskId }: { taskId: number }) {
  const mark = ciMarkFor(taskId);
  if (!mark) return null;
  const passed = mark.outcome === 'pass';
  const what = passed
    ? `Checks passed on PR #${mark.prNumber}`
    : `Checks failed on PR #${mark.prNumber}${mark.job ? `: ${mark.job}` : ''}`;
  return (
    <span
      className="task-ci"
      data-outcome={mark.outcome}
      role="img"
      aria-label={`${what}, not seen yet`}
      title={`${what}. Not seen yet: opening the task clears this.`}
    >
      <span aria-hidden="true">{passed ? '✓' : '✗'}</span> Checks
    </span>
  );
}
