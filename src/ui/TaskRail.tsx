import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Task } from '../types';
import { GROUP_GLYPH, GROUP_TITLE, type GroupKey } from './taskGroups';
import './taskrail.css';

/**
 * The task list collapsed to a rail (#266): New Task, the way back to the
 * list, and one circle per group that has tasks, with its count. A circle
 * opens its group's tasks in a popover beside the rail, over the pane, so
 * nothing reflows.
 *
 * Presentation only. The groups, their order and their rows are the list's
 * (TaskList.tsx hands them over as they are drawn there), so the rail can
 * never disagree with the list it stands in for, and the list's shortcuts
 * (⌘N, ⌘1–9, ⌘[ ⌘]) keep working while it is collapsed.
 */

/** How a group's circle is drawn. */
export type CircleFill = 'solid' | 'ringed' | 'dotted';

/**
 * Every circle filled with its group's colour (#276): a 2px outline alone was
 * too little colour to tell the groups apart. Done stays a dotted outline;
 * Ready to Review is filled with a ring inside, so it stays apart from In
 * Review, the same green filled plain.
 */
export const CIRCLE_FILL: Record<GroupKey, CircleFill> = {
  blocked: 'solid',
  active: 'solid',
  review: 'ringed',
  reviewing: 'solid',
  quiet: 'solid',
  done: 'dotted',
  archived: 'solid',
};

/** "In Review, 2 tasks": the circle's tooltip and accessible name. */
export function circleLabel(key: GroupKey, count: number): string {
  return `${GROUP_TITLE[key]}, ${count} task${count === 1 ? '' : 's'}`;
}

/** What a popover row shows, built by the list so its rows and these match. */
export interface RailRow {
  title: ReactNode;
  /** The list row's marks (Checks, Draft, Reminder, …). */
  meta: ReactNode;
  age: string;
  tooltip: string;
}

export interface TaskRailProps {
  /** The list's non-empty groups, in its order. Archived is left out here. */
  sections: { key: GroupKey; tasks: Task[] }[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onExpand: () => void;
  row: (task: Task, group: GroupKey) => RailRow;
}

const POP_GAP = 6;
const EDGE = 8;

export default function TaskRail({ sections, selectedId, onSelect, onNew, onExpand, row }: TaskRailProps) {
  const groups = sections.filter((g) => g.key !== 'archived' && g.tasks.length > 0);
  const [open, setOpen] = useState<GroupKey | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const railRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const circleRefs = useRef(new Map<GroupKey, HTMLButtonElement>());

  const openGroup = open === null ? undefined : groups.find((g) => g.key === open);
  // The group emptied while it was open (its last task moved on): nothing to show.
  useEffect(() => {
    if (open !== null && !openGroup) setOpen(null);
  }, [open, openGroup]);

  const selectedGroup = groups.find((g) => g.tasks.some((t) => t.id === selectedId))?.key ?? null;

  const close = (refocus: boolean) => {
    const key = open;
    setOpen(null);
    if (refocus && key !== null) circleRefs.current.get(key)?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const toggle = (key: GroupKey) => {
    if (open === key) {
      setOpen(null);
      return;
    }
    const circle = circleRefs.current.get(key)?.getBoundingClientRect();
    const rail = railRef.current?.getBoundingClientRect();
    if (circle) {
      // Beside the rail, its head level with the circle.
      setPos({ top: Math.max(EDGE, circle.top - 4), left: (rail?.right ?? circle.right) + POP_GAP });
    }
    setOpen(key);
  };

  // Dismiss on anything that moves the world under it: the set OverflowMenu
  // and the row menu use. A press on a circle is the circle's own: it toggles
  // or switches the group, so it is not "outside".
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest('.rail-circle') && railRef.current?.contains(t)) return;
      closeRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // Handled: nothing else acts on it, and a full-screen window does not
      // take it as "leave full screen" (#267).
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(true);
    };
    const onBlur = () => closeRef.current(false);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open]);

  // Keep it on screen, then give the keyboard to the selected task's row when
  // the group holds it, else the first, as a native menu does.
  useLayoutEffect(() => {
    if (open === null) return;
    const pop = popRef.current;
    if (!pop) return;
    const h = pop.getBoundingClientRect().height;
    const room = window.innerHeight - EDGE;
    if (h > 0 && pos.top + h > room) setPos((p) => ({ ...p, top: Math.max(EDGE, room - h) }));
    const rows = Array.from(pop.querySelectorAll<HTMLButtonElement>('.task-row'));
    (rows.find((r) => r.getAttribute('aria-current') === 'true') ?? rows[0])?.focus();
    // Placement only on open; the clamp above settles in one pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onPopKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Back to the circle, rather than leaving a popover open behind focus.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    const list = Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>('.task-row') ?? []);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? list.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % list.length
            : (i - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  // ↑/↓ walk the circles, as they walk the list's rows.
  const onRailKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const circles = groups.map((g) => circleRefs.current.get(g.key)).filter((c): c is HTMLButtonElement => !!c);
    const i = circles.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    circles[Math.min(circles.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const pick = (id: number) => {
    setOpen(null);
    onSelect(id);
  };

  return (
    <nav className="task-rail" aria-label="Task groups" data-focus-area="tasks" ref={railRef} onKeyDown={onRailKey}>
      <div className="task-rail-head">
        <button type="button" className="icon-btn" onClick={onNew} aria-label="New Task" title="New task (⌘N)">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="task-rail-glyph">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        className="icon-btn"
        data-list-toggle=""
        onClick={onExpand}
        aria-label="Expand Task List"
        title="Expand the task list (⌥⌘T)"
      >
        <ChevronGlyph dir="right" />
      </button>
      <span className="task-rail-sep" aria-hidden="true" />
      {groups.map((g, i) => (
        <button
          key={g.key}
          ref={(el) => {
            if (el) circleRefs.current.set(g.key, el);
            else circleRefs.current.delete(g.key);
          }}
          type="button"
          className="rail-circle"
          data-group={g.key}
          data-fill={CIRCLE_FILL[g.key]}
          data-open={open === g.key || undefined}
          /* Where the Tab cycle lands (focusAreas.ts): the selected task's
             group, else the first. */
          data-focus-default={g.key === selectedGroup || undefined}
          data-focus-fallback={i === 0 || undefined}
          aria-current={g.key === selectedGroup || undefined}
          aria-haspopup="menu"
          aria-expanded={open === g.key}
          aria-label={circleLabel(g.key, g.tasks.length)}
          title={circleLabel(g.key, g.tasks.length)}
          onClick={() => toggle(g.key)}
        >
          {g.tasks.length}
        </button>
      ))}

      {openGroup && (
        <div
          ref={popRef}
          className="row-menu rail-pop"
          role="menu"
          aria-label={GROUP_TITLE[openGroup.key]}
          style={{ top: pos.top, left: pos.left }}
          onKeyDown={onPopKey}
        >
          <div className="rail-pop-head">
            <span className="status-dot" data-status={GROUP_GLYPH[openGroup.key]} aria-hidden="true" />
            <span className="rail-pop-title">{GROUP_TITLE[openGroup.key]}</span>
            <span className="rail-pop-count">· {openGroup.tasks.length}</span>
          </div>
          <div className="rail-pop-list">
            {openGroup.tasks.map((task) => {
              const r = row(task, openGroup.key);
              const selected = task.id === selectedId;
              return (
                <button
                  key={task.id}
                  type="button"
                  role="menuitem"
                  className="task-row"
                  data-rail-task-id={task.id}
                  data-selected={selected}
                  data-status={task.status}
                  aria-current={selected || undefined}
                  title={r.tooltip}
                  onClick={() => pick(task.id)}
                >
                  <span className="task-dot-cell">
                    <span className="status-dot" data-status={GROUP_GLYPH[openGroup.key]} aria-hidden="true" />
                  </span>
                  <span className="task-title">{r.title}</span>
                  <span className="task-age">{r.age}</span>
                  {r.meta}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}

/** ‹ and ›, drawn on the icon grid so both sit on the same centre as ＋. */
export function ChevronGlyph({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="task-rail-glyph">
      <path
        d={dir === 'left' ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
