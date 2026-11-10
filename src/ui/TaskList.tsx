import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react';
import type { Project, Task } from '../types';
import { ContextMeter, contextLevel, contextReadout, contextTitle } from './StatusDot';
import { parseIssueKey } from '../lib/issueKey';
import EmptyState from './EmptyState';
import MoreGlyph from './MoreGlyph';
import { wrapForTooltip } from './text';
import { placeMenu, type MenuPlacement } from './menuPlacement';
import type { ContextUsage } from '../capture';
import type { TaskSignals } from './useTasks';
import type { AttentionKind } from './attention';
import { useShortcuts } from './shortcuts';
import { MenuItemButtons } from './OverflowMenu';
import { taskMenuItems, type TaskActions } from './taskMenuItems';
import { useTaskMenuFacts } from './useTaskMenuFacts';
import { getPrStatus, usePrPolling, usePrStatusVersion } from '../gh/prStore';
import { ciMarkFor, useCiVersion } from './ciNotice';
import { reviewMarkFor, standingApproval, useReviewVersion } from './reviewNotice';
import { hasConflicts } from '../gh/prAction';
import { reviewerNames, type PrStatus } from '../gh/prStatus';
import { useBranchSync } from '../git/branchSync';
import { getReviewWork, useReviewWorkProbes, useReviewWorkVersion } from '../git/reviewWork';
import {
  checksFailing,
  compareInGroup,
  GROUP_ORDER,
  GROUP_TITLE,
  groupOf,
  wantsWorkProbe,
  type GroupFacts,
  type GroupKey,
} from './taskGroups';
import { reviewingTaskIds, useGuideStoreVersion } from '../guide/store';
import { ChatIcon } from './icons';
import RemoteMark from './RemoteMark';
import { BackgroundMark } from './BackgroundWork';
import { useDraftTaskIds } from './transcript/drafts';
import { useReminderTaskIds } from './reminders/useReminders';
import { ReminderGlyph } from './reminders/ReminderGlyph';
import TaskTitleEdit from './TaskTitleEdit';
import TaskRail, { ChevronGlyph, type RailRow } from './TaskRail';
import GroupPie from './GroupPie';
import ReviewList from './ReviewList';
import ProposedGroup from './ProposedGroup';
import type { SessionRequest } from './requestQueue';
import { useReviewStarts } from './reviewStarts';
import { PlusIcon, RefreshIcon } from './icons';
import { KEYS, oneOfCodec, usePersisted } from './persisted';
import { refreshReviews, seenMarks, useReviewList } from '../gh/reviewStore';
import { reviewGroups, waitingCount } from '../gh/reviewActivity';
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
   * What the row menu's actions do (#331): the same {@link TaskActions} the
   * task bar's ⋯ uses, so both menus offer one list (`taskMenuItems`). Each
   * acts on the row's task, selected or not. An action with no handler is
   * not offered; with neither archive nor delete, the row has no ⋯ (the
   * right-click menu still opens).
   */
  actions?: TaskActions;
  /**
   * Saves a new title (already cleaned, and different). Offered in the row
   * menu as "Rename Task…", which edits the title in place on the row.
   */
  onRename?: (task: Task, title: string) => void;
  /**
   * Saves a new summary (#262; already cleaned, and different; null clears).
   * Given, the row's rename field has a summary field under the name.
   */
  onSummary?: (task: Task, summary: string | null) => void;
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
   * The main area is showing the full empty state (no task selected), so the
   * list only needs its headline: a second explanation and a second New Task
   * button right under the ⌘N one said the same thing twice.
   */
  emptyBrief?: boolean;
  /**
   * Drawn as the rail (#266): New Task, the way back, and one count circle
   * per group. The groups, rows and shortcuts are the same; only the drawing
   * changes, and never the selection.
   */
  collapsed?: boolean;
  /** Collapse (true) or expand. Absent, the list offers neither. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * A pull request was just opened for review (#287): its new task, to
   * show. Absent, the Reviewing tab still lists PRs and selects review tasks
   * that exist, but cannot open new ones.
   */
  onReviewOpened?: (task: Task) => void;
  /**
   * New tasks sessions asked for (#332), newest first and already scoped to
   * the active project: the Proposed group at the top of Building, and a
   * dashed circle on the rail. Not tasks: never selected, never in ↑/↓ or
   * ⌘1–9. Absent or empty, no group.
   */
  proposals?: readonly SessionRequest[];
  /** The requesting task's title, for a proposal's "from …". */
  titleOf?: (taskId: number) => string | null;
  /** Approve…: New Task opens filled in from the request. */
  onApproveProposal?: (req: SessionRequest) => void;
  /** Deny: the request leaves the queue. */
  onDenyProposal?: (id: string) => void;
}

const NO_PROPOSALS: readonly SessionRequest[] = [];

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

type ListTab = 'building' | 'reviewing';
const TAB_CODEC = oneOfCodec<ListTab>(['building', 'reviewing']);

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

export default function TaskList({
  tasks: allTasks,
  selectedId,
  onSelect,
  attention,
  onNew,
  actions,
  onRename,
  onSummary,
  onRenameClosed,
  contextBySession,
  signals,
  onManageProjects,
  projects,
  activeProject = null,
  emptyBrief = false,
  collapsed = false,
  onCollapsedChange,
  onReviewOpened,
  proposals = NO_PROPOSALS,
  titleOf,
  onApproveProposal,
  onDenyProposal,
}: TaskListProps) {
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState<RowMenu | null>(null);
  /** The row whose title is being edited in place (#152). */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  /** The list root itself has focus (not a row, a field or a button in it): see `data-focus-stop`. */
  const [rootFocused, setRootFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /*
   * Review tasks (#287) live in the Reviewing tab, beside the PR they are
   * for; everything else in this component is about your own tasks.
   */
  const tasks = useMemo(() => allTasks.filter((t) => !t.reviewUrl), [allTasks]);
  const reviewTasks = useMemo(() => allTasks.filter((t) => !!t.reviewUrl), [allTasks]);
  /** Building (your tasks) or Reviewing (PRs asked of you, #287). */
  const [tab, setTab] = usePersisted(KEYS.taskListTab, TAB_CODEC, 'building');
  /*
   * Polled whichever tab is showing: the Reviewing tab's count is in the
   * header either way. One request a minute for the project (reviewStore.ts).
   */
  /*
   * A task chosen from elsewhere -- ⌘1–9, N Waiting, a notification -- is
   * shown where it lives: a review task in Reviewing, any other in Building.
   * Not on mount, so a remembered tab survives a restart.
   */
  const lastSelected = useRef(selectedId);
  useEffect(() => {
    if (lastSelected.current === selectedId) return;
    lastSelected.current = selectedId;
    const t = selectedId === null ? null : allTasks.find((x) => x.id === selectedId);
    if (t) setTab(!!t.reviewUrl ? 'reviewing' : 'building');
  }, [selectedId, allTasks, setTab]);
  const liveCount = tasks.filter((t) => t.status !== 'archived').length;
  const reviewState = useReviewList(activeProject?.repoPath ?? null);
  const reviewList = reviewState.kind === 'ready' ? reviewState.list : null;
  // What you have begun reviewing in Albedo (#315), told the moment a tick or a comment changes.
  const reviewStarts = useReviewStarts(reviewTasks);
  const reviewGroupsNow = reviewList ? reviewGroups(reviewList.prs, seenMarks(), reviewList.viewer, reviewStarts) : [];
  const reviewCount = reviewList ? waitingCount(reviewGroupsNow) : null;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const drafts = useDraftTaskIds();
  const reminderIds = useReminderTaskIds();
  /**
   * The ‹ or › that was pressed is gone once the list redraws, so focus
   * would fall to the body: hand it to the other one. Only for a press of
   * the button itself; the menu item and ⌥⌘T leave focus where it was.
   */
  const toggledHere = useRef(false);
  useEffect(() => {
    if (!toggledHere.current) return;
    toggledHere.current = false;
    document.querySelector<HTMLElement>('[data-list-toggle]')?.focus();
  }, [collapsed]);
  const toggleHere = (next: boolean) => {
    toggledHere.current = true;
    onCollapsedChange?.(next);
  };

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
  // Unseen reviews (reviewNotice.ts), likewise.
  useReviewVersion();
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
  const guideVersion = useGuideStoreVersion();
  const facts = useMemo(() => {
    const reviewing = reviewingTaskIds();
    const byId = new Map<number, GroupFacts>();
    for (const task of tasks) {
      const finishedAt = signals?.get(task.id)?.finishedAt ?? null;
      byId.set(task.id, {
        finishedAt,
        pr: task.kind === 'chat' ? null : getPrStatus(task.id),
        work: getReviewWork(task.id, finishedAt),
        reviewing: reviewing.has(task.id),
      });
    }
    return byId;
    // The versions stand for the caches read through getPrStatus/getReviewWork
    // and the guide store's Reviewed marks.
  }, [tasks, signals, prVersion, workVersion, guideVersion]);

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


  const contextOf = (task: Task) => (task.sessionId ? contextBySession?.get(task.sessionId) : undefined);

  /** The row's name: an issue key leads, as its own chip, then the rest. */
  const rowTitle = (task: Task): ReactNode => {
    const issue = parseIssueKey(task.title);
    return issue ? (
      <>
        <span className="task-key">{issue.key}</span>
        {issue.rest && <span className="task-rest">{issue.rest}</span>}
      </>
    ) : (
      task.title
    );
  };

  /* Wrapped, not raw: a native title cannot break lines itself, so a
     paragraph-length task title renders as one window-wide strip that covers
     whatever it was describing -- including the row's own context menu.
     The row's details on hover: the context reading the hairline draws, in
     words, now that no panel shows it. What the task is about (#262), on
     hover only: the line after the title. Rows keep their one-line layout. */
  const rowTooltip = (task: Task): string => {
    const ctx = contextOf(task);
    return `${wrapForTooltip(task.title)}${task.summary ? `\n${wrapForTooltip(task.summary)}` : ''}\n${task.kind === 'chat' ? CHAT_ROW_TITLE : task.branch}${ctx ? `\n${contextTitle(ctx)}` : ''}`;
  };

  /** The row's caption and marks: the list's rows and the rail's popover (#266) both draw this. */
  const rowMeta = (task: Task, group: GroupKey): ReactNode => {
    const pr = task.kind === 'chat' ? null : getPrStatus(task.id);
    // In Needs You for its checks, not for a prompt (taskGroups.ts): the row
    // says why, and the checks' news mark would say it twice.
    const failingHere = group === 'blocked' && task.status !== 'blocked' && checksFailing(pr);
    const ctx = contextOf(task);
    const ctxLevel = ctx ? contextLevel(ctx.fraction) : null;
    // Quiet sessions say nothing. The number appears only once it is
    // worth reading, which is what keeps it unobtrusive.
    const ctxText = ctx && ctxLevel !== 'quiet' ? contextReadout(ctx) : null;
    const sig = signals?.get(task.id);
    return (
      <span className="task-meta">
        {/* No project name: the project is the tab selected above (#278). */}
        {/* No branch and no PR state here: the task bar is the one
            place git and GitHub state is shown, for the selected
            task. Rows identify the task; the title does that. The
            exceptions are news, not state -- checks that finished,
            or a change request that landed, since the task was
            last open (CiRowMark, ReviewRowMark) -- and, by the
            owner's decisions, two states: an approval that stands,
            until the PR is merged (#234), and conflicts GitHub
            reports, which outrank it (#236). Marks only: the
            actions are the task bar's. */}
        <span className="task-meta-tail">
          {/* PR checks that finished since the task was last
              open: ✓ or ✗ and the word, until it is opened
              (ciNotice.ts). First in the tail: it is news, the
              rest is state. Never on the selected row -- it is
              being looked at, and its PR badge carries a cue. */}
          {failingHere && pr && <FailingChecksMark pr={pr} />}
          {task.id !== selectedId && !failingHere && <CiRowMark taskId={task.id} />}
          {/* ⚠ Conflicts while GitHub reports them, else
              Approved while the approval stands, on every row,
              the selected one too (#236, #234); Changes once, as
              news, until the task is opened (#180). */}
          <ReviewRowMark taskId={task.id} selected={task.id === selectedId} group={group} />
          {/* Where the team's review stands (#278): the unresolved threads,
              and a change request, on In Review rows -- and the threads
              still open on an Approved one. */}
          {(group === 'team' || group === 'approved') && pr && <ThreadsChip pr={pr} />}
          {/* An unsent message waiting in this task's composer, so a
              forgotten one can be found. Not on the selected row:
              its draft is in the box right below. */}
          {drafts.has(task.id) && task.id !== selectedId && (
            <span className="task-draft" title="An unsent message is waiting in this task's message box">
              Draft
            </span>
          )}
          {/* A reminder came back and its card is waiting on this
              task (#156). Not on the selected row: the card is
              right there above the message box. */}
          {reminderIds.has(task.id) && task.id !== selectedId && (
            <span className="task-reminder" title="A reminder is back: its card is on this task">
              <ReminderGlyph size={12} />
              Reminder
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
    );
  };

  const railRow = (task: Task, group: GroupKey): RailRow => ({
    title: rowTitle(task),
    meta: rowMeta(task, group),
    age: relativeTime(task.lastActivityAt, now),
    tooltip: rowTooltip(task),
  });

  if (collapsed) {
    return (
      <TaskRail
        sections={sections}
        selectedId={selectedId}
        onSelect={onSelect}
        onNew={onNew}
        onExpand={() => toggleHere(false)}
        row={railRow}
        proposed={proposals.length}
        onProposed={() => {
          // Where the Proposed group is.
          setTab('building');
          toggleHere(false);
        }}
      />
    );
  }

  return (
    /* A stop of the Tab cycle (focusAreas.ts): the list itself takes focus,
       since it is where ↑/↓ are handled, and the selected row shows which. */
    <div
      className="tasklist"
      tabIndex={0}
      onKeyDown={tab === 'building' ? onKeyDown : undefined}
      role={tab === 'building' ? 'listbox' : undefined}
      aria-label={tab === 'building' ? 'Tasks' : undefined}
      data-focus-area="tasks"
      /* With proposals showing (#332), Tab from the list itself walks into
         their buttons before it leaves for the next area (focusAreas.ts).
         Only while the list root has focus: a stop's descendants count as
         the stop, so a stop held any longer would send Tab from the rename
         field, the head's buttons or a row to the proposals instead of on
         to the next area. Without proposals, nothing changes. */
      data-focus-stop={tab === 'building' && proposals.length > 0 && rootFocused ? '' : undefined}
      onFocus={(e) => setRootFocused(e.target === e.currentTarget)}
      onBlur={(e) => {
        if (e.target === e.currentTarget) setRootFocused(false);
      }}
    >
      <div className="tasklist-head">
        {/* Two tabs (#287): your tasks, and PRs asked of you for review. The
            project is named by its tab in the title bar, or, with one
            project, by the title bar's Projects; this row has no room for a
            third label. Each tab counts its list: Building its live tasks,
            Reviewing what waits on you. Both fit whole at the sidebar's 300px
            minimum (#306); past that -- a three-digit count, a larger text
            size -- they shrink together and their labels end in "…", never
            cut at the track's edge. The full name is in the tooltip. */}
        <div className="seg tasklist-tabs" role="tablist" aria-label="Task list">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'building'}
            onClick={() => setTab('building')}
            title="Building"
          >
            <span className="tasklist-tab-label">Building</span>
            <span className="tasklist-tab-count">{liveCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'reviewing'}
            onClick={() => setTab('reviewing')}
            title="Reviewing"
          >
            <span className="tasklist-tab-label">Reviewing</span>
            {reviewCount !== null && <span className="tasklist-tab-count">{reviewCount}</span>}
          </button>
        </div>
        {/* One 28px action at the end, whichever tab is showing, so nothing
            else in the row moves when switching: New Task in Building
            (a review is not started from a blank form; ⌘N works from both),
            Refresh in Reviewing. */}
        {tab === 'building' ? (
          <button type="button" className="icon-btn tasklist-action" onClick={onNew} aria-label="New Task" title="New task (⌘N)">
            <PlusIcon size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn tasklist-action"
            onClick={() => activeProject && void refreshReviews(activeProject.repoPath, { force: true })}
            disabled={!activeProject}
            aria-label="Refresh Review Requests"
            title="Ask GitHub again now (it asks every minute)"
          >
            <RefreshIcon size={16} />
          </button>
        )}
        {/* Collapses the list to the rail of group counts (#266). */}
        {onCollapsedChange && (
          <button
            type="button"
            className="icon-btn tasklist-collapse"
            data-list-toggle=""
            onClick={() => toggleHere(true)}
            aria-label="Collapse Task List"
            title="Collapse the task list (⌥⌘T)"
          >
            <ChevronGlyph dir="left" />
          </button>
        )}
      </div>

      {tab === 'reviewing' ? (
        <div className="tasklist-scroll">
          <ReviewList
            project={activeProject}
            state={reviewState}
            groups={reviewGroupsNow}
            reviewTasks={reviewTasks}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpened={onReviewOpened}
            age={(ts) => relativeTime(ts, now)}
          />
        </div>
      ) : (
      <div className="tasklist-scroll" ref={scrollRef}>
        {/* Above Needs You (#332): what sessions propose waits on you
            before anything else can. Not tasks, so not options. */}
        <ProposedGroup
          proposals={proposals}
          titleOf={titleOf ?? (() => null)}
          age={(ts) => relativeTime(ts, now)}
          onApprove={(req) => onApproveProposal?.(req)}
          onDeny={(id) => onDenyProposal?.(id)}
        />
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
          /* The group names its rows for assistive tech: a row carries no
             status icon (#278), so the group is what says "Needs You". */
          <div key={group.key} className="task-group" role="group" aria-labelledby={`task-group-${group.key}`}>
            <div className="group-label" data-tone={group.key} id={`task-group-${group.key}`}>
              <GroupPie group={group.key} />
              <span>{GROUP_TITLE[group.key]}</span>
              <span className="group-count">{group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const index = ordered.indexOf(task);
              const ctx = contextOf(task);
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
                  /* Wrapped, and with the summary and context: rowTooltip. */
                  title={rowTooltip(task)}
                  /* The same without a pointer: a hover-only text is also
                     the row's accessible description. */
                  aria-describedby={task.summary ? `task-summary-${task.id}` : undefined}
                >
                  {/* No status icon (#278): the group's header carries it,
                      and the title starts under the header's name. */}
                  {/* The key IS the task's identity to the user, so it reads
                      as its own chip down the left edge instead of being the
                      first few characters of a sentence. Identifier, not a
                      sort axis -- grouping stays status-first. */}
                  {renamingId === task.id && onRename ? (
                    <TaskTitleEdit
                      className="task-row-title-edit"
                      summaryClassName="task-row-summary-edit"
                      title={task.title}
                      summary={onSummary ? task.summary : undefined}
                      returnFocus="fallback"
                      fallbackFocus={onRenameClosed}
                      onSave={(title) => {
                        setRenamingId(null);
                        onRename(task, title);
                      }}
                      onSaveSummary={(summary) => {
                        setRenamingId(null);
                        onSummary?.(task, summary);
                      }}
                      onDone={() => setRenamingId(null)}
                    />
                  ) : (
                  <span className="task-title">{rowTitle(task)}</span>
                  )}
                  <span className="task-age">{relativeTime(task.lastActivityAt, now)}</span>
                  {/* Shares the age's spot and swaps in on hover: reserving
                      its own width hid on every row cut titles short. */}
                  {index < 9 && <span className="task-index kbd">⌘{index + 1}</span>}
                  {rowMeta(task, group.key)}
                  <ContextMeter usage={ctx} variant="hairline" />
                  {(actions?.archive || actions?.delete) && (
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
            {/* Outside the options, so it describes a row without being part of
                its name; hidden, since a description is read from it anyway. */}
            {group.tasks.map((task) =>
              task.summary ? (
                <span key={`summary-${task.id}`} id={`task-summary-${task.id}`} hidden>
                  {task.summary}
                </span>
              ) : null,
            )}
          </div>
        ))}
      </div>
      )}

      {menu && (
        <TaskRowMenu
          menu={menu}
          // The task as it is now, not as it was when right-clicked: its
          // status decides what Compact Now and Mark as Done say.
          task={allTasks.find((t) => t.id === menu.task.id) ?? menu.task}
          shown={menu.task.id === selectedId}
          actions={actions ?? NO_ACTIONS}
          menuRef={menuRef}
          close={() => setMenu(null)}
          // Edits the title here on the row, where it was right-clicked,
          // without selecting the task: selecting would move focus to its
          // terminal, and that blur would save the field the moment it opened.
          rename={onRename ? (task) => setRenamingId(task.id) : undefined}
        />
      )}
    </div>
  );
}

const NO_ACTIONS: TaskActions = {};

/**
 * The row's menu (right-click, or the row's ⋯): the task's actions from
 * `taskMenuItems`, the same list as the task bar's ⋯, under a heading that
 * says which task was right-clicked -- it may not be the selected one.
 */
function TaskRowMenu({
  menu,
  task,
  shown,
  actions,
  menuRef,
  close,
  rename,
}: {
  menu: RowMenu;
  task: Task;
  shown: boolean;
  actions: TaskActions;
  menuRef: MutableRefObject<HTMLDivElement | null>;
  close: () => void;
  rename?: (task: Task) => void;
}) {
  // This row's facts, never the selected task's: Compact Now's blocker is
  // about the session it would go to.
  const facts = useTaskMenuFacts(task, shown);
  const items = taskMenuItems(task, facts, actions, rename ? () => rename(task) : undefined);
  // What changes the menu's size once it is open: a fact arriving late (the
  // Remote Control lookup, the reminder count) adds, drops or widens an item.
  const shape = items.map((i) => `${i.id}:${typeof i.aside === 'string' ? i.aside : ''}`).join('|');

  /**
   * Where the menu goes so all of it is in the window (#285), measured before
   * it paints. Kept with the menu and shape it was measured for: a new menu is
   * first laid out at the pointer, uncapped, so its natural size is what gets
   * measured. A capped menu's own height is the cap; its scroll height is
   * still all of it.
   */
  const [placed, setPlaced] = useState<{ for: RowMenu; at: MenuPlacement } | null>(null);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlaced({
      for: menu,
      at: placeMenu(
        { x: menu.x, y: menu.y },
        { width: r.width, height: Math.max(r.height, el.scrollHeight) },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    });
  }, [menu, shape, menuRef]);
  const at: MenuPlacement = placed && placed.for === menu ? placed.at : { left: menu.x, top: menu.y };

  return (
    <div
      className="row-menu"
      ref={menuRef}
      style={{
        left: at.left,
        top: at.top,
        ...(at.maxHeight !== undefined ? { maxHeight: at.maxHeight, overflowY: 'auto' as const } : {}),
      }}
      role="menu"
    >
      <div className="row-menu-head" title={wrapForTooltip(task.title)}>
        {task.title}
      </div>
      <MenuItemButtons items={items} onChosen={close} />
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

/**
 * The review on the task's PR, on its row. ⚠ Conflicts is state (#236): shown
 * while GitHub reports them on an open PR, selected or not, and it outranks
 * Approved. Approved is state (#234): shown
 * while GitHub says the open PR is approved, selected or not, until it is
 * merged -- except in the Approved group, which says it already (#278).
 * Changes is news (#180): an unseen change request, never on the selected
 * row, gone once the task is opened -- and not in In Review, whose chip says
 * "Changes" as state (#278). Awaiting Review never marks a row. Glyph and
 * word, as the checks' mark; the reviewers are in the tooltip.
 */
function ReviewRowMark({ taskId, selected, group }: { taskId: number; selected: boolean; group: GroupKey }) {
  const pr = getPrStatus(taskId);
  // Conflicts outrank an approval: the PR cannot be merged either way (#236).
  // A change request that landed unseen is news, and still shows beside it.
  const conflicts = hasConflicts(pr);
  const standing = conflicts || group === 'approved' ? null : standingApproval(pr);
  const news = reviewMarkFor(taskId);
  const mark =
    standing ?? (!selected && group !== 'team' && news?.outcome === 'changes-requested' ? news : null);
  const conflictMark =
    conflicts && pr ? (
      <span
        className="task-review"
        data-outcome="conflicts"
        role="img"
        aria-label={`PR #${pr.number} has conflicts with ${pr.baseRefName || 'its base'}`}
        title={`GitHub reports conflicts between PR #${pr.number} and ${pr.baseRefName || 'its base'}. Open the task: its ⚠ Conflicts button asks Claude to resolve them.`}
      >
        <span aria-hidden="true">⚠</span> Conflicts
      </span>
    ) : null;
  if (!mark) return conflictMark;
  const approved = mark.outcome === 'approved';
  const who = reviewerNames(mark.reviewers);
  const what = approved
    ? mark.reviewers.length > 0
      ? `PR #${mark.prNumber} approved by ${who}`
      : `PR #${mark.prNumber} approved`
    : `Changes requested on PR #${mark.prNumber} by ${who}`;
  return (
    <>
    {conflictMark}
    <span
      className="task-review"
      data-outcome={mark.outcome}
      role="img"
      aria-label={approved ? `${what}, ready to merge` : `${what}, not seen yet`}
      title={approved ? `${what}. Ready to merge.` : `${what}. Not seen yet: opening the task clears this.`}
    >
      <span aria-hidden="true">{approved ? '✓' : '✎'}</span> {approved ? 'Approved' : 'Changes'}
    </span>
    </>
  );
}

/**
 * What the team's review left open (#278), on an In Review or Approved row,
 * as a compact chip: a speech bubble and the unresolved count ("3"), in the
 * Needs You tone when changes were requested ("!" when none is open). The
 * words are its tooltip and accessible name: "3 unresolved threads",
 * "Changes requested · 1 unresolved thread". Null when nothing is open and
 * no change was requested.
 */
export function threadsChip(pr: PrStatus): { mark: string; label: string; changes: boolean } | null {
  const open = pr.reviewThreads?.unresolved ?? 0;
  const threads = `${open} unresolved thread${open === 1 ? '' : 's'}`;
  if (pr.review === 'changes-requested') {
    return { mark: open > 0 ? String(open) : '!', label: open > 0 ? `Changes requested · ${threads}` : 'Changes requested', changes: true };
  }
  return open > 0 ? { mark: String(open), label: threads, changes: false } : null;
}

function ThreadsChip({ pr }: { pr: PrStatus }) {
  const chip = threadsChip(pr);
  if (!chip) return null;
  return (
    <span
      className="task-threads"
      data-changes={chip.changes || undefined}
      role="img"
      aria-label={chip.label}
      title={`${chip.label} on PR #${pr.number}`}
    >
      <ChatIcon size={12} />
      <span aria-hidden="true">{chip.mark}</span>
    </span>
  );
}

/**
 * Why a task with no prompt waiting is in Needs You (#278): its PR's checks
 * failed. State, not news: it stays until they pass or run again, selected or
 * not, in the Needs You text tone.
 */
function FailingChecksMark({ pr }: { pr: PrStatus }) {
  const c = pr.checks;
  const what =
    c.kind === 'failing'
      ? `${c.failing} of ${c.total} ${c.total === 1 ? 'check' : 'checks'} failing on PR #${pr.number}`
      : `Checks failing on PR #${pr.number}`;
  return (
    <span className="task-checks-failing" role="img" aria-label={what} title={`${what}. The PR badge lists them.`}>
      <span aria-hidden="true">✗</span> Checks
    </span>
  );
}
