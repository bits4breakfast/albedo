import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Project, Task } from '../../types';
import StatusDot from '../StatusDot';
import ClosedProjectsMenu from '../ClosedProjectsMenu';
import { detectPlatform } from '../../lib/platform';

// ---------------------------------------------------------------------------
// Project tabs
//
// Deliberately absent until they are needed. One project is the expected case,
// and in that case this is a no-op: no bar, no chrome, no vertical space — the
// app exactly as it was. The second project summons the bar, and that is the
// entire interaction, plus drag-to-reorder (view state, like closing a tab).
// No per-tab state beyond that: a rare case earns correctness, not a surface.
//
// The one thing the bar MUST do is keep the app's core promise working. Tabs
// hide every task outside the active project, so a session that blocks in a
// background project would go invisible — the app failing at its only job
// exactly when several things are running. Each tab therefore carries its own
// status in the same visual language as the rows: blocked pings, running
// breathes, and those stay the only two moving things in the app.
// ---------------------------------------------------------------------------

export interface ProjectTab {
  key: string;
  /** null = the "Other" tab: tasks belonging to no known project. */
  project: Project | null;
  label: string;
  tasks: Task[];
  blocked: number;
  running: number;
}

/**
 * Projects in the user's tab order. A project the order has never seen (just
 * added) keeps its place in `projects` relative to the others but lands after
 * every ordered one, so adding a project never reshuffles the bar.
 */
export function orderProjects(projects: Project[], order: number[]): Project[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return projects
    .map((p, i) => ({ p, r: rank.get(p.id) ?? order.length + i }))
    .sort((a, b) => a.r - b.r)
    .map(({ p }) => p);
}

export function buildTabs(projects: Project[], tasks: Task[]): ProjectTab[] {
  const byProject = new Map<number, Task[]>();
  const orphans: Task[] = [];
  for (const task of tasks) {
    const id = task.projectId;
    if (id === null || !projects.some((p) => p.id === id)) orphans.push(task);
    else {
      const bucket = byProject.get(id);
      if (bucket) bucket.push(task);
      else byProject.set(id, [task]);
    }
  }
  const count = (list: Task[], status: Task['status']) =>
    list.filter((t) => t.status === status).length;

  const tabs: ProjectTab[] = projects.map((project) => {
    const list = byProject.get(project.id) ?? [];
    return {
      key: `p${project.id}`,
      project,
      label: project.name,
      tasks: list,
      blocked: count(list, 'blocked'),
      running: count(list, 'running'),
    };
  });
  // Only when it has something in it. A task with no project means the backfill
  // failed, and an invisible task is the one outcome worth a whole extra tab.
  if (orphans.length > 0) {
    tabs.push({
      key: 'orphans',
      project: null,
      label: 'Other',
      tasks: orphans,
      blocked: count(orphans, 'blocked'),
      running: count(orphans, 'running'),
    });
  }
  return tabs;
}

/** ` (⌥⌘2)` for the second tab; nothing past the ninth. See shortcuts.ts. */
function projectKeyHint(index: number): string {
  if (index < 0 || index > 8) return '';
  return detectPlatform() === 'macos' ? ` (⌥⌘${index + 1})` : ` (Alt+${index + 1})`;
}

export default function ProjectTabs({
  tabs,
  activeKey,
  onSelect,
  onHide,
  hidden,
  onRestore,
  onReorder,
}: {
  tabs: ProjectTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  onHide: (projectId: number) => void;
  hidden: Project[];
  onRestore: (projectId: number) => void;
  /** The visible project tabs' ids in their new order. */
  onReorder: (projectIds: number[]) => void;
}) {
  // Never offer to hide the last one: that would leave a bar with nothing in
  // it but the restore chip.
  const canHide = tabs.length > 1;

  /*
   * Pointer events, not HTML5 drag-and-drop: the Tauri window owns native
   * drag-drop, and a tab is a click target first. The drag only begins past a
   * small threshold, so a plain click still selects, and the click a drag ends
   * on is swallowed. The bar previews the new order live and commits on
   * release; "Other" never moves and is never a drop target.
   */
  const [preview, setPreview] = useState<string[] | null>(null);
  const drag = useRef<{ key: string; x: number; active: boolean; pointer: number } | null>(null);
  const swallowClick = useRef(false);
  const tabEls = useRef(new Map<string, HTMLElement>());

  const order = preview ?? tabs.map((t) => t.key);
  const byKey = new Map(tabs.map((t) => [t.key, t]));
  const shown = [
    ...order.map((k) => byKey.get(k)).filter((t): t is ProjectTab => t !== undefined),
    // A tab that appeared mid-drag still shows, after the previewed ones.
    ...tabs.filter((t) => !order.includes(t.key)),
  ];

  const onPointerDown = (e: ReactPointerEvent, tab: ProjectTab) => {
    if (e.button !== 0 || tab.project === null) return;
    drag.current = { key: tab.key, x: e.clientX, active: false, pointer: e.pointerId };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.x) < 4) return;
      d.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const movable = (preview ?? tabs.map((t) => t.key)).filter((k) => k !== 'orphans');
    const rest = movable.filter((k) => k !== d.key);
    // Insert before the first tab whose midpoint is right of the pointer.
    let at = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const r = tabEls.current.get(rest[i]!)?.getBoundingClientRect();
      if (r && e.clientX < r.left + r.width / 2) {
        at = i;
        break;
      }
    }
    const next = [...rest.slice(0, at), d.key, ...rest.slice(at)];
    if (tabs.some((t) => t.key === 'orphans')) next.push('orphans');
    if (next.join() !== order.join()) setPreview(next);
  };

  const endDrag = (e: ReactPointerEvent, commit: boolean) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (!d.active) return;
    swallowClick.current = true;
    if (commit && preview) {
      onReorder(
        preview
          .map((k) => byKey.get(k)?.project?.id)
          .filter((id): id is number => id !== undefined),
      );
    }
    setPreview(null);
  };

  return (
    <div className="project-tabs" role="tablist" aria-label="Projects">
      {shown.map((tab) => {
        const status = tab.blocked > 0 ? 'blocked' : tab.running > 0 ? 'running' : null;
        const badge =
          tab.blocked > 0 ? tab.blocked : tab.running > 0 ? tab.running : tab.tasks.length;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={tab.key === activeKey}
            className="project-tab"
            data-status={status ?? 'quiet'}
            data-dragging={preview !== null && drag.current?.key === tab.key ? 'true' : undefined}
            ref={(el) => {
              if (el) tabEls.current.set(tab.key, el);
              else tabEls.current.delete(tab.key);
            }}
            onPointerDown={(e) => onPointerDown(e, tab)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endDrag(e, true)}
            onPointerCancel={(e) => endDrag(e, false)}
            onClick={() => {
              if (swallowClick.current) {
                swallowClick.current = false;
                return;
              }
              onSelect(tab.key);
            }}
            title={
              (tab.blocked > 0
                ? `${tab.label}: ${tab.blocked} waiting on you`
                : (tab.project?.repoPath ?? tab.label)) + projectKeyHint(tabs.findIndex((t) => t.key === tab.key))
            }
          >
            {status && <StatusDot status={status} />}
            <span className="project-tab-name">{tab.label}</span>
            <span className="project-tab-count">{badge}</span>
            {canHide && tab.project && (
              <span
                className="project-tab-close"
                role="button"
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label} — the project and its worktrees are untouched`}
                onPointerDown={(e) => {
                  // Beat the tab's own click so closing never also selects.
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.project) onHide(tab.project.id);
                }}
              >
                ✕
              </span>
            )}
          </button>
        );
      })}

      {/* Always reachable from where it was closed. Without this the bar can
          become a one-way door -- close a tab, and with the bar gone there is
          nowhere left that knows the project is merely hidden. */}
      {hidden.length > 0 && <ClosedProjectsMenu hidden={hidden} onRestore={onRestore} />}
    </div>
  );
}
