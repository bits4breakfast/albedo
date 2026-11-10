import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Task } from '../types';
import { GROUP_HUE, GROUP_TITLE, type GroupKey } from './taskGroups';
import GroupPie from './GroupPie';
import './taskrail.css';

/**
 * The task list collapsed to a rail (#266): New Task, the way back to the
 * list, and one circle per colour that has tasks, with its count. A circle
 * opens its tasks in a popover beside the rail, over the pane, so nothing
 * reflows. Two circles stand for two groups each (#278): Your Review (Ready
 * to Review and My Review) and Team Review (In Review and Awaiting Review),
 * whose groups share a colour; their popover lists the tasks under the two
 * groups' names.
 *
 * Presentation only. The groups, their order and their rows are the list's
 * (TaskList.tsx hands them over as they are drawn there), so the rail can
 * never disagree with the list it stands in for, and the list's shortcuts
 * (⌘N, ⌘1–9, ⌘[ ⌘]) keep working while it is collapsed.
 */

/** One circle of the rail: the groups it counts, in the list's order. */
export interface RailCircle {
  key: string;
  title: string;
  /** Its colour (`GROUP_HUE`), the same for every group it counts. */
  hue: string;
  groups: readonly GroupKey[];
}

/** One circle per colour (#278), in the list's order. Archived has none. */
export const RAIL_CIRCLES: readonly RailCircle[] = [
  { key: 'blocked', title: GROUP_TITLE.blocked, hue: GROUP_HUE.blocked, groups: ['blocked'] },
  { key: 'errored', title: GROUP_TITLE.errored, hue: GROUP_HUE.errored, groups: ['errored'] },
  { key: 'active', title: GROUP_TITLE.active, hue: GROUP_HUE.active, groups: ['active'] },
  { key: 'yours', title: 'Your Review', hue: GROUP_HUE.review, groups: ['review', 'mine'] },
  { key: 'team', title: 'Team Review', hue: GROUP_HUE.team, groups: ['team', 'awaiting'] },
  { key: 'approved', title: GROUP_TITLE.approved, hue: GROUP_HUE.approved, groups: ['approved'] },
  { key: 'quiet', title: GROUP_TITLE.quiet, hue: GROUP_HUE.quiet, groups: ['quiet'] },
  { key: 'done', title: GROUP_TITLE.done, hue: GROUP_HUE.done, groups: ['done'] },
];

/**
 * What pulses when its count goes up: Needs You, and Your Review when its
 * Ready to Review part rises -- a new finish, not a review you started.
 */
export const PULSING: readonly { group: GroupKey; circle: string }[] = [
  { group: 'blocked', circle: 'blocked' },
  { group: 'review', circle: 'yours' },
];
/** Three 2s pulses (taskrail.css), then the attribute goes. */
export const PULSE_MS = 6000;
type Pulse = 'a' | 'b';

/**
 * Which circles pulse: Needs You's or Ready to Review's count went up since
 * the last render. Never on the first render -- launch, or the list
 * collapsing into the rail -- and never on a fall. A rise during a pulse
 * swaps 'a' for 'b' (or back), which restarts the animation; the timer
 * starts over with it.
 */
function usePulse(counts: Partial<Record<GroupKey, number>>): Partial<Record<string, Pulse>> {
  const [pulse, setPulse] = useState<Partial<Record<string, Pulse>>>({});
  const prev = useRef<Partial<Record<GroupKey, number>> | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const key = PULSING.map((p) => counts[p.group] ?? 0).join(',');

  useEffect(() => {
    const before = prev.current;
    prev.current = Object.fromEntries(PULSING.map((p) => [p.group, counts[p.group] ?? 0]));
    if (before === null) return;
    for (const { group, circle: g } of PULSING) {
      if ((counts[group] ?? 0) <= (before[group] ?? 0)) continue;
      const t = timers.current.get(g);
      if (t !== undefined) clearTimeout(t);
      setPulse((p) => ({ ...p, [g]: p[g] === 'a' ? 'b' : 'a' }));
      timers.current.set(
        g,
        setTimeout(() => {
          timers.current.delete(g);
          setPulse((p) => {
            const next = { ...p };
            delete next[g];
            return next;
          });
        }, PULSE_MS),
      );
    }
    // The counts are what `key` spells; nothing else is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live.values()) clearTimeout(t);
      live.clear();
    };
  }, []);

  return pulse;
}

/**
 * The circle's tooltip and accessible name: "Running, 2 tasks", or for a
 * circle of two groups both counts, "Your Review: Ready to Review 1, My
 * Review 1".
 */
export function circleLabel(circle: RailCircle, counts: Partial<Record<GroupKey, number>>): string {
  if (circle.groups.length > 1) {
    return `${circle.title}: ${circle.groups.map((g) => `${GROUP_TITLE[g]} ${counts[g] ?? 0}`).join(', ')}`;
  }
  const count = counts[circle.groups[0]!] ?? 0;
  return `${circle.title}, ${count} task${count === 1 ? '' : 's'}`;
}

/** What a popover row shows, built by the list so its rows and these match. */
export interface RailRow {
  title: ReactNode;
  /**
   * Which API error the task stopped on (#338), under the title, or null.
   * Try Again is not here: the popover's row is itself a button.
   */
  why?: ReactNode;
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

/** A circle with tasks, and its groups' tasks (only the non-empty ones). */
interface Circle {
  circle: RailCircle;
  parts: { key: GroupKey; tasks: Task[] }[];
  count: number;
}

export default function TaskRail({ sections, selectedId, onSelect, onNew, onExpand, row }: TaskRailProps) {
  const counts: Partial<Record<GroupKey, number>> = Object.fromEntries(sections.map((g) => [g.key, g.tasks.length]));
  const circles: Circle[] = RAIL_CIRCLES.flatMap((circle) => {
    const parts = circle.groups.flatMap((key) => {
      const tasks = sections.find((g) => g.key === key)?.tasks ?? [];
      return tasks.length > 0 ? [{ key, tasks }] : [];
    });
    const count = parts.reduce((n, p) => n + p.tasks.length, 0);
    return count > 0 ? [{ circle, parts, count }] : [];
  });
  const pulse = usePulse(counts);
  const [open, setOpen] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const railRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const circleRefs = useRef(new Map<string, HTMLButtonElement>());

  const openCircle = open === null ? undefined : circles.find((c) => c.circle.key === open);
  // The circle emptied while it was open (its last task moved on): nothing to show.
  useEffect(() => {
    if (open !== null && !openCircle) setOpen(null);
  }, [open, openCircle]);

  const selectedCircle =
    circles.find((c) => c.parts.some((p) => p.tasks.some((t) => t.id === selectedId)))?.circle.key ?? null;

  const close = (refocus: boolean) => {
    const key = open;
    setOpen(null);
    if (refocus && key !== null) circleRefs.current.get(key)?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const toggle = (key: string) => {
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
    const buttons = circles
      .map((c) => circleRefs.current.get(c.circle.key))
      .filter((c): c is HTMLButtonElement => !!c);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
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
      {circles.map(({ circle, count }, i) => (
        <button
          key={circle.key}
          ref={(el) => {
            if (el) circleRefs.current.set(circle.key, el);
            else circleRefs.current.delete(circle.key);
          }}
          type="button"
          className="rail-circle"
          data-group={circle.key}
          data-hue={circle.hue}
          data-pulse={pulse[circle.key]}
          data-open={open === circle.key || undefined}
          /* Where the Tab cycle lands (focusAreas.ts): the selected task's
             circle, else the first. */
          data-focus-default={circle.key === selectedCircle || undefined}
          data-focus-fallback={i === 0 || undefined}
          aria-current={circle.key === selectedCircle || undefined}
          aria-haspopup="menu"
          aria-expanded={open === circle.key}
          aria-label={circleLabel(circle, counts)}
          title={circleLabel(circle, counts)}
          onClick={() => toggle(circle.key)}
        >
          {count}
        </button>
      ))}

      {openCircle && (
        <div
          ref={popRef}
          className="row-menu rail-pop"
          role="menu"
          aria-label={openCircle.circle.title}
          style={{ top: pos.top, left: pos.left }}
          onKeyDown={onPopKey}
        >
          <div className="rail-pop-head">
            {/* One group: its icon, as on the list's header. Two: each
                sub-header below carries its own. */}
            {openCircle.circle.groups.length === 1 && <GroupPie group={openCircle.circle.groups[0]!} />}
            <span className="rail-pop-title">{openCircle.circle.title}</span>
            <span className="rail-pop-count">· {openCircle.count}</span>
          </div>
          <div className="rail-pop-list">
            {openCircle.parts.map((part) => {
              const rows = part.tasks.map((task) => {
                const r = row(task, part.key);
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
                    <span className="task-title">{r.title}</span>
                    <span className="task-age">{r.age}</span>
                    {r.meta}
                    {r.why}
                  </button>
                );
              });
              if (openCircle.circle.groups.length === 1) return rows;
              const id = `rail-pop-${part.key}`;
              return (
                <div key={part.key} role="group" aria-labelledby={id} className="rail-pop-group">
                  <div className="rail-pop-sub" id={id}>
                    <GroupPie group={part.key} />
                    <span>{GROUP_TITLE[part.key]}</span>
                    <span className="group-count">{part.tasks.length}</span>
                  </div>
                  {rows}
                </div>
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
