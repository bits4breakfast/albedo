import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QueuedRequest, SessionRequest } from './requestQueue';
import './requests.css';

/** The panel's width plus its border; used only to keep it on screen. */
const PANEL_WIDTH = 400;
const EDGE = 8;

/** Under the button, right edges aligned, clamped to the window. Pure for tests. */
export function panelPosition(
  anchor: { right: number; bottom: number },
  viewportWidth: number,
): { left: number; top: number } {
  const left = Math.min(anchor.right - PANEL_WIDTH, viewportWidth - PANEL_WIDTH - EDGE);
  return { left: Math.max(EDGE, left), top: anchor.bottom + 2 };
}

/** The header button's label: what kind of thing is waiting, and how many. */
export function requestsLabel(items: readonly QueuedRequest[]): string {
  const n = items.length;
  return n === 1 ? '1 Request' : `${n} Requests`;
}

/** The first lines of a prompt, for the preview. The whole text is one click away (Approve). */
export function promptPreview(prompt: string, maxLines = 4, maxChars = 320): string {
  const lines = prompt.split('\n').slice(0, maxLines).join('\n');
  const cut = lines.length > maxChars ? `${lines.slice(0, maxChars - 1)}…` : lines;
  return cut.length < prompt.length && !cut.endsWith('…') ? `${cut}\n…` : cut;
}

function when(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export interface RequestsProps {
  items: readonly QueuedRequest[];
  /** The requesting task's title, for "from …". */
  titleOf: (taskId: number) => string | null;
  /** Approve a session request: New Task opens filled in from it. */
  onApprove: (req: SessionRequest) => void;
  /** Deny a session request, or dismiss anything else. */
  onDismiss: (id: string) => void;
  /** Go to the requesting task. */
  onOpenTask: (taskId: number) => void;
}

/**
 * "N Requests" in the header, and the panel it opens: what sessions asked
 * Albedo for through its MCP server (#157), waiting on the user. Absent when
 * nothing is waiting, so it costs the header nothing the rest of the time.
 *
 * Dismissal as the other header menus: a press outside, Esc (focus back on
 * the button), blur, resize. A panel, not a menu: each item has its own
 * buttons, so Tab moves through them rather than arrows.
 */
export default function Requests({ items, titleOf, onApprove, onDismiss, onOpenTask }: RequestsProps) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const open = at !== null;

  const close = () => setAt(null);
  const toggle = () => {
    if (open) return close();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAt(panelPosition(rect, window.innerWidth));
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && (panelRef.current?.contains(t) || buttonRef.current?.contains(t))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);

  // The last one handled: nothing left to show.
  useEffect(() => {
    if (items.length === 0) close();
  }, [items.length]);

  if (items.length === 0) return null;

  const from = (taskId: number) => titleOf(taskId) ?? `Task ${taskId}`;
  // Newest first: the one that just arrived is the one being looked for.
  const shown = [...items].reverse();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="usage usage-waiting requests-button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="What sessions asked Albedo for: new sessions to approve, reminders, and messages"
      >
        <span className="requests-dot" aria-hidden="true" />
        <span className="usage-figure">{requestsLabel(items)}</span>
      </button>
      <span className="header-sep" aria-hidden="true" />
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="requests-panel"
            role="dialog"
            aria-label="Requests from sessions"
            style={{ left: at.left, top: at.top }}
          >
            <div className="requests-head">Asked by sessions. Nothing here starts until you approve it.</div>
            <ul className="requests-list">
              {shown.map((r) => (
                <li key={r.id} className="requests-item" data-tool={r.tool}>
                  <div className="requests-kind">
                    <span>
                      {kindLabel(r)}
                    </span>
                    <span className="requests-from">
                      from{' '}
                      <button
                        type="button"
                        className="requests-link"
                        onClick={() => {
                          close();
                          onOpenTask(r.taskId);
                        }}
                      >
                        {from(r.taskId)}
                      </button>
                    </span>
                  </div>

                  <RequestBody r={r} close={close} onApprove={onApprove} onDismiss={onDismiss} onOpenTask={onOpenTask} />
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

/** What kind of request, as the item's first word. */
export function kindLabel(r: QueuedRequest): string {
  switch (r.tool) {
    case 'request_session':
      return 'New session';
    case 'create_reminder':
      return 'Reminder';
    case 'notify_blocked':
      return 'Needs you';
    default: {
      const unhandled: never = r;
      return String(unhandled);
    }
  }
}

function RequestBody({
  r,
  close,
  onApprove,
  onDismiss,
  onOpenTask,
}: { r: QueuedRequest; close: () => void } & Pick<RequestsProps, 'onApprove' | 'onDismiss' | 'onOpenTask'>) {
  switch (r.tool) {
    case 'request_session':
      return (
        <>
          <div className="requests-title">{r.title}</div>
          <div className="requests-text">{r.reason}</div>
          <pre className="requests-prompt">{promptPreview(r.prompt)}</pre>
          {(r.project || r.branch) && (
            <div className="requests-meta">
              {r.project && <span>Project: {r.project}</span>}
              {r.branch && <span>Branch: {r.branch}</span>}
            </div>
          )}
          <div className="requests-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onDismiss(r.id)}>
              Deny
            </button>
            <button
              type="button"
              className="btn btn-primary"
              title="Opens New Task filled in from this request. Nothing is created until you press Create."
              onClick={() => {
                close();
                onApprove(r);
              }}
            >
              Approve…
            </button>
          </div>
        </>
      );
    case 'create_reminder':
      return (
        <>
          <div className="requests-title">{r.text}</div>
          <div className="requests-text">Due {when(r.dueMs)}</div>
          <div className="requests-note">
            Not set: reminders are not in Albedo yet (#156). Kept here so you can see what was asked.
          </div>
          <div className="requests-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onDismiss(r.id)}>
              Dismiss
            </button>
          </div>
        </>
      );
    case 'notify_blocked':
      return (
        <>
          <div className="requests-title requests-message">{r.message}</div>
          <div className="requests-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onDismiss(r.id)}>
              Dismiss
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                close();
                onOpenTask(r.taskId);
              }}
            >
              Open Task
            </button>
          </div>
        </>
      );
    default: {
      const unhandled: never = r;
      return unhandled;
    }
  }
}
