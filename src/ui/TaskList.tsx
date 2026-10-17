import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Project, Task, TaskStatus } from '../types';
import StatusDot, { ContextMeter, contextLevel, contextReadout, contextTitle } from './StatusDot';
import { parseIssueKey } from '../lib/issueKey';
import EmptyState from './EmptyState';
import { wrapForTooltip } from './text';
import type { ContextUsage } from '../capture';
import type { AttentionKind } from './attention';
import { useShortcuts } from './shortcuts';
import { PrRowMark } from './PrBadge';
import { getPrStatus, usePrPolling, usePrStatusVersion } from '../gh/prStore';

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
   * Opens the archive confirmation for a task. Optional so the frozen
   * four-prop signature still type-checks; when absent the affordance is
   * simply not rendered.
   */
  onArchive?: (task: Task) => void;
  /**
   * Ends the task for good. Distinct from {@link TaskListProps.onArchive}: see
   * the menu copy, which has to keep three verbs apart on one surface.
   */
  onDelete?: (task: Task) => void;
  /** Context-window usage keyed by sessionId, fetched once for the whole list. */
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
}

/** Row context menu. Destructive actions live here, never on the row itself. */
interface RowMenu {
  task: Task;
  x: number;
  y: number;
}

/**
 * Status is the PRIMARY axis inside the list. Project scoping happens a level
 * up, in the tab bar, precisely so this grouping stays flat: "which session is
 * waiting on me" must never be more than one glance deep.
 */
type GroupKey = 'blocked' | 'active' | 'quiet' | 'archived';

const GROUP_ORDER: GroupKey[] = ['blocked', 'active', 'quiet', 'archived'];

const GROUP_TITLE: Record<GroupKey, string> = {
  blocked: 'Needs you',
  active: 'Running',
  quiet: 'Idle',
  archived: 'Archived',
};

function groupOf(status: TaskStatus): GroupKey {
  if (status === 'blocked') return 'blocked';
  if (status === 'running') return 'active';
  if (status === 'archived') return 'archived';
  return 'quiet';
}

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
  contextBySession,
  onManageProjects,
  projects,
  activeProject = null,
  nameProject = false,
}: TaskListProps) {
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /*
   * PR status for the rows on screen. The list owns the polling because it
   * owns "visible": these are exactly the tasks the owner can see a mark for.
   * One subscription for the whole list; rows read the cache directly.
   */
  usePrPolling(tasks);
  usePrStatusVersion();

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
  const sections = useMemo(() => {
    const buckets = new Map<GroupKey, Task[]>();
    for (const key of GROUP_ORDER) buckets.set(key, []);
    for (const task of tasks) buckets.get(groupOf(task.status))?.push(task);
    for (const list of buckets.values()) {
      list.sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
    }
    return GROUP_ORDER.map((key) => ({ key, tasks: buckets.get(key) ?? [] })).filter(
      (g) => g.tasks.length > 0,
    );
  }, [tasks]);

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
    <div className="tasklist" tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-label="Tasks">
      <div className="tasklist-head">
        {/* Identity lives here because this strip is always visible, never
            scrolls, and is already the scope label for the list beneath it.
            It is a control, not a caption: someone asking "which project am I
            in" is usually one keystroke from "and how do I change it". */}
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
        <span className="tasklist-count" title={`${blockedCount} blocked of ${liveCount}`}>
          {blockedCount > 0 ? `${blockedCount}/${liveCount}` : liveCount}
        </span>
        <button className="btn btn-primary" onClick={onNew} title="New task (⌘N)">
          New
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
          />
        )}

        {sections.map((group) => (
          <div key={group.key}>
            <div className="group-label" data-tone={group.key}>
              <span>{GROUP_TITLE[group.key]}</span>
              <span className="group-rule" />
              <span>{group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const index = ordered.indexOf(task);
              const issue = parseIssueKey(task.title);
              const ctx = task.sessionId ? contextBySession?.get(task.sessionId) : undefined;
              const ctxLevel = ctx ? contextLevel(ctx.fraction) : null;
              // Quiet sessions say nothing. The number appears only once it is
              // worth reading, which is what keeps it unobtrusive.
              const ctxText = ctx && ctxLevel !== 'quiet' ? contextReadout(ctx) : null;
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
                  title={`${wrapForTooltip(task.title)}\n${task.repoPath}\n${task.branch}`}
                >
                  <span className="task-dot-cell">
                    <StatusDot status={task.status} />
                  </span>
                  {/* The key IS the task's identity to the user, so it reads
                      as its own chip down the left edge instead of being the
                      first few characters of a sentence. Identifier, not a
                      sort axis -- grouping stays status-first. */}
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
                  <span className="task-age">{relativeTime(task.lastActivityAt, now)}</span>
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
                    <span className="task-branch">{task.branch}</span>
                    <span className="task-meta-tail">
                      {task.status !== 'archived' && <PrRowMark pr={getPrStatus(task.id)} />}
                      {ctx && ctxText && (
                        <span className="task-ctx-text" data-level={ctxLevel} title={contextTitle(ctx)}>
                          {ctxText}
                        </span>
                      )}
                      {index < 9 && <span className="task-index">⌘{index + 1}</span>}
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
                      ⋯
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
          <div className="row-menu-head">{menu.task.title}</div>
          <button
            className="row-menu-item"
            role="menuitem"
            onClick={() => {
              const path = menu.task.worktreePath;
              setMenu(null);
              void navigator.clipboard?.writeText(path).catch(() => {});
            }}
          >
            Copy worktree path
          </button>
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
              Archive task…
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
              Delete task…
              <span className="row-menu-hint">worktree optional · conversation kept</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
