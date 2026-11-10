import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionRequest } from './requestQueue';
import { placeBeside, type BesidePlacement } from './menuPlacement';
import { promptPreview } from './proposals';
import './proposed.css';

/**
 * The task list's Proposed group (#332): new tasks sessions asked for through
 * Albedo's MCP server, waiting on the user's approval, at the top of the
 * Building tab. A proposal is not a task: its row is not an option of the
 * list, ↑/↓ and ⌘1–9 pass it by, and it cannot be selected.
 *
 * Each row: the title, "from <task> · <age>", and Deny and Approve… -- the
 * only place either is offered. A click on the row (not on a button), or on
 * its title with the keyboard, opens a popover beside it with what the
 * session sent: who asked, why, the start of the brief, the project and
 * branch it suggests. The popover has no buttons; it closes on Esc, a click
 * elsewhere, or the row again, and Esc or the row gives focus back to the
 * row's title.
 *
 * The keyboard: Tab from the task list walks the title, Deny and Approve… of
 * each row (`data-focus-stop`, focusAreas.ts) before it leaves for the next
 * area; Enter or Space on a title opens its popover.
 */

export interface ProposedGroupProps {
  /** Newest first, already scoped to the active project (proposals.ts). */
  proposals: readonly SessionRequest[];
  /** The requesting task's title, for "from …". */
  titleOf: (taskId: number) => string | null;
  /** The list's compact age ("3m"), so both read the same. */
  age: (ts: number) => string;
  /** Opens New Task filled in from the request; nothing is created until Create. */
  onApprove: (req: SessionRequest) => void;
  /** The request leaves the queue. */
  onDeny: (id: string) => void;
}

export const PROPOSED_LABEL = 'Proposed';

export default function ProposedGroup({ proposals, titleOf, age, onApprove, onDeny }: ProposedGroupProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const rows = useRef(new Map<string, HTMLDivElement>());
  const open = openId === null ? undefined : proposals.find((p) => p.id === openId);

  // Approved and created, or denied: its popover goes with it.
  useEffect(() => {
    if (openId !== null && !open) setOpenId(null);
  }, [openId, open]);

  const close = (refocus: boolean) => {
    const id = openId;
    setOpenId(null);
    if (refocus && id !== null) triggers.current.get(id)?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  if (proposals.length === 0) return null;

  const from = (taskId: number) => titleOf(taskId) ?? `Task ${taskId}`;

  /** A click anywhere on the row but its buttons; the title's own click (Enter, Space) lands here too. */
  const onRowClick = (e: ReactMouseEvent<HTMLDivElement>, id: string) => {
    const button = (e.target as Element).closest('button');
    if (button && !button.classList.contains('proposal-title')) return;
    if (openId === id) close(true);
    else setOpenId(id);
  };

  return (
    <div
      className="task-group proposed-group"
      role="group"
      aria-labelledby="task-group-proposed"
    >
      <div className="group-label" data-tone="proposed" id="task-group-proposed">
        <ProposedRing />
        <span>{PROPOSED_LABEL}</span>
        <span className="group-count">{proposals.length}</span>
      </div>
      {proposals.map((p) => {
        const isOpen = p.id === openId;
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) rows.current.set(p.id, el);
              else rows.current.delete(p.id);
            }}
            className="proposal-row"
            data-proposal-id={p.id}
            data-open={isOpen || undefined}
            onClick={(e) => onRowClick(e, p.id)}
          >
            <button
              ref={(el) => {
                if (el) triggers.current.set(p.id, el);
                else triggers.current.delete(p.id);
              }}
              type="button"
              className="proposal-title"
              data-focus-stop=""
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              aria-controls={isOpen ? `proposal-pop-${p.id}` : undefined}
              aria-describedby={`proposal-from-${p.id}`}
            >
              {p.title}
            </button>
            <span className="proposal-from" id={`proposal-from-${p.id}`}>
              from {from(p.taskId)} · {age(p.at)}
            </span>
            <span className="proposal-actions">
              <button type="button" className="btn btn-ghost" data-focus-stop="" onClick={() => {
                setOpenId(null);
                onDeny(p.id);
              }}>
                Deny
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-focus-stop=""
                title="Opens New Task filled in from this request. Nothing is created until you press Create."
                onClick={() => {
                  setOpenId(null);
                  onApprove(p);
                }}
              >
                Approve…
              </button>
            </span>
          </div>
        );
      })}
      {open && (
        <ProposalPopover
          req={open}
          from={from(open.taskId)}
          age={age(open.at)}
          anchor={rows.current.get(open.id) ?? null}
          close={(refocus) => closeRef.current(refocus)}
        />
      )}
    </div>
  );
}

/**
 * The Proposed group's icon: a dashed ring in the accent, since what it
 * holds is not a task yet. Same 12px grid and stroke as GroupPie's rings.
 * Decorative: the group's name is beside it.
 */
export function ProposedRing() {
  return (
    <svg
      className="group-pie proposed-ring"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="6"
        cy="6"
        r="5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        pathLength={16}
        strokeDasharray="1.25 0.75"
      />
    </svg>
  );
}

const POP_WIDTH = 360;

function ProposalPopover({
  req,
  from,
  age,
  anchor,
  close,
}: {
  req: SessionRequest;
  from: string;
  age: string;
  /** The row it stands beside. */
  anchor: Element | null;
  close: (refocus: boolean) => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [at, setAt] = useState<{ for: string; place: BesidePlacement } | null>(null);

  // Measured before it paints, then placed beside its row; a new request is
  // laid out unplaced first, so its natural height is what gets measured.
  useLayoutEffect(() => {
    const el = popRef.current;
    const row = anchor;
    if (!el || !row) return;
    const r = row.getBoundingClientRect();
    const size = el.getBoundingClientRect();
    setAt({
      for: req.id,
      place: placeBeside(
        r,
        { width: size.width || POP_WIDTH, height: Math.max(size.height, el.scrollHeight) },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    });
    el.focus();
    // Placed once per request; the row does not move while it is open
    // (scrolling the list closes it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id]);

  // Dismiss as the list's other popovers do. A press on a proposal row is the
  // row's own: its click toggles this one, opens another, or is a button's.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest('.proposal-row')) return;
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
    const onAway = () => closeRef.current(false);
    const scroller = anchor?.closest('.tasklist-scroll');
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onAway);
    window.addEventListener('resize', onAway);
    scroller?.addEventListener('scroll', onAway);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
      scroller?.removeEventListener('scroll', onAway);
    };
  }, [anchor]);

  // Nothing in it takes focus: Tab goes back to the row rather than leaving
  // a popover open behind the focus.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    closeRef.current(true);
  };

  const place = at && at.for === req.id ? at.place : null;
  const headId = `proposal-pop-title-${req.id}`;

  return createPortal(
    <div
      ref={popRef}
      id={`proposal-pop-${req.id}`}
      className="proposal-pop"
      role="dialog"
      aria-labelledby={headId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-placed={place ? true : undefined}
      style={
        place
          ? {
              left: place.left,
              top: place.top,
              ['--arrow-y' as string]: `${place.arrowY}px`,
              ...(place.maxHeight !== undefined ? { maxHeight: place.maxHeight } : {}),
            }
          : { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      <div className="proposal-pop-body">
        <div className="proposal-pop-kind">Proposed task</div>
        <div className="proposal-pop-title" id={headId}>
          {req.title}
        </div>
        <div className="proposal-pop-from">
          from {from} · {age}
        </div>
        {req.reason && (
          <section className="proposal-pop-section">
            <div className="proposal-pop-label">Why</div>
            <div className="proposal-pop-text">{req.reason}</div>
          </section>
        )}
        <section className="proposal-pop-section">
          <div className="proposal-pop-label">Brief</div>
          <pre className="proposal-pop-brief">{promptPreview(req.prompt)}</pre>
        </section>
        {(req.project || req.branch || req.start === 'fork') && (
          <div className="proposal-pop-meta">
            {req.project && <span>Project: {req.project}</span>}
            {req.branch && <span>Branch: {req.branch}</span>}
            {/* Only a fork is a suggestion worth naming: a brief is the default,
                and an absent `start` reads as one. */}
            {req.start === 'fork' && <span title="Claude suggests starting from a copy of this conversation">Suggests: fork</span>}
          </div>
        )}
        <div className="proposal-pop-note">Approve… on the row opens New Task with the whole brief. Nothing starts until you press Create.</div>
      </div>
    </div>,
    document.body,
  );
}
