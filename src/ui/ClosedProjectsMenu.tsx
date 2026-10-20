import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../types';

/** `.row-menu`'s min-width plus its border; used only to keep it on screen. */
const MENU_MIN_WIDTH = 170;
/** Breathing room between the menu and the window edge. */
const EDGE = 8;

/**
 * Where the menu goes: under the button, right edges aligned (it sits at the
 * end of the strip, so it opens back toward the tabs), clamped to the window.
 * Pure so it can be tested without a layout engine -- jsdom has none.
 */
export function menuPosition(
  anchor: { left: number; right: number; bottom: number },
  viewportWidth: number,
): { left: number; top: number } {
  const left = Math.min(anchor.right - MENU_MIN_WIDTH, viewportWidth - MENU_MIN_WIDTH - EDGE);
  return { left: Math.max(EDGE, left), top: anchor.bottom + 2 };
}

/**
 * The "+N closed" chip and the menu that restores a hidden project.
 *
 * The menu is PORTALLED to `document.body`. It used to be an absolutely
 * positioned child of `.project-tabs`, which scrolls sideways and therefore
 * hides vertical overflow -- so the menu dropped into the clipped axis and
 * opened invisibly, leaving a closed project unrecoverable. Moving the chip
 * out of the strip would also have worked, but only until the next ancestor
 * grew an `overflow` or a `transform`; outside the tree, nothing above it can
 * clip it again.
 *
 * Dismissal follows the task-row menu: any press outside, Esc, blur, resize, or
 * the strip scrolling out from under it. Keyboard per the HIG's menus: focus
 * lands on the first item, arrows move, Esc returns focus to the chip.
 */
export default function ClosedProjectsMenu({
  hidden,
  onRestore,
}: {
  hidden: Project[];
  onRestore: (projectId: number) => void;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = at !== null;

  const toggle = () => {
    if (open) {
      setAt(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAt(menuPosition(rect, window.innerWidth));
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    // Capture-phase so it beats everything else; a press inside the menu must
    // survive for the item's own click, and a press on the chip is the chip's
    // toggle to handle -- closing here too would reopen it on the click.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return close();
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    // The position was taken from the chip once; if the strip scrolls, the
    // chip moves and the menu would be left pointing at nothing.
    const strip = buttonRef.current?.closest('.project-tabs');
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    strip?.addEventListener('scroll', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      strip?.removeEventListener('scroll', close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Nothing left to restore: the last one was just brought back.
  useEffect(() => {
    if (hidden.length === 0) setAt(null);
  }, [hidden.length]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(i + step + items.length) % items.length]?.focus();
  };

  return (
    <div className="project-tabs-restore">
      <button
        ref={buttonRef}
        className="project-tab project-tab-more"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Closed projects"
      >
        +{hidden.length} Closed
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="row-menu"
            role="menu"
            aria-label="Closed projects"
            style={{ left: at.left, top: at.top }}
            onKeyDown={onMenuKey}
          >
            <div className="row-menu-head">Closed — still here, just not shown</div>
            {hidden.map((project) => (
              <button
                key={project.id}
                className="row-menu-item"
                role="menuitem"
                onClick={() => {
                  setAt(null);
                  onRestore(project.id);
                }}
              >
                {project.name}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
