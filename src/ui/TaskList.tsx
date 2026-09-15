import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Task, TaskStatus } from '../types';
import StatusDot from './StatusDot';

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
}

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

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? (parts[parts.length - 1] as string) : path;
}

export default function TaskList({ tasks, selectedId, onSelect, onNew }: TaskListProps) {
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Ages only need to be roughly right.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const groups = useMemo(() => {
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
  const ordered = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);

  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  // Global shortcuts: ⌘1..9 jumps, ⌘N creates. Arrow keys are handled on the
  // list itself so they don't fight the terminal for the keyboard.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        onNewRef.current();
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        const index = Number(e.key) - 1;
        const task = orderedRef.current[index];
        if (!task) return;
        e.preventDefault();
        onSelectRef.current(task.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Keep the selected row in view when selection moves from elsewhere.
  useEffect(() => {
    if (selectedId === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-task-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

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

  const blockedCount = tasks.filter((t) => t.status === 'blocked').length;
  const liveCount = tasks.filter((t) => t.status !== 'archived').length;

  return (
    <div className="tasklist" tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-label="Tasks">
      <div className="tasklist-head">
        <span className="tasklist-title">Tasks</span>
        <span className="tasklist-count" title={`${blockedCount} blocked of ${liveCount}`}>
          {blockedCount > 0 ? `${blockedCount}/${liveCount}` : liveCount}
        </span>
        <button className="btn btn-primary" onClick={onNew} title="New task (⌘N)">
          New
        </button>
      </div>

      <div className="tasklist-scroll" ref={scrollRef}>
        {ordered.length === 0 && (
          <div className="tasklist-empty">
            No tasks yet.
            <br />
            <span className="placeholder-key">⌘N</span> cuts a worktree and starts a session.
          </div>
        )}

        {groups.map((group) => (
          <div key={group.key}>
            <div className="group-label" data-tone={group.key}>
              <span>{GROUP_TITLE[group.key]}</span>
              <span className="group-rule" />
              <span>{group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const index = ordered.indexOf(task);
              return (
                <button
                  key={task.id}
                  className="task-row"
                  data-task-id={task.id}
                  data-selected={task.id === selectedId}
                  data-status={task.status}
                  role="option"
                  aria-selected={task.id === selectedId}
                  onClick={() => onSelect(task.id)}
                  title={`${task.title}\n${task.repoPath}\n${task.branch}`}
                >
                  <span className="task-dot-cell">
                    <StatusDot status={task.status} />
                  </span>
                  <span className="task-title">{task.title}</span>
                  <span className="task-age">{relativeTime(task.lastActivityAt, now)}</span>
                  <span className="task-meta">
                    <span className="task-repo">{basename(task.repoPath)}</span>
                    <span className="task-sep">/</span>
                    <span className="task-branch">{task.branch}</span>
                    {index < 9 && <span className="task-index">⌘{index + 1}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
