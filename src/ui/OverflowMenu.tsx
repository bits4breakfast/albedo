/**
 * OverflowMenu -- the ⋯ button and the menu it opens.
 *
 * Presentational only: each item carries the callback its old inline button
 * had, so moving a control in here changes where it is drawn, never what it
 * does. Keyboard shortcuts stay bound where they always were (App,
 * shortcuts.ts); an item only SHOWS its binding.
 *
 * Styled with the shell's `.row-menu` so every menu in the app is one shape.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import MoreGlyph from './MoreGlyph';

export interface OverflowItem {
  /** Stable key. */
  id: string;
  label: ReactNode;
  onSelect: () => void;
  /** Right-aligned hint: a shortcut (⌥F12) or a current value. */
  aside?: ReactNode;
  disabled?: boolean;
  /** Native tooltip, carried over from the button the item replaces. */
  title?: string;
  /** Present => a toggle (`menuitemcheckbox`) showing this state. */
  checked?: boolean;
  /** With `checked`: one of a set (`menuitemradio`), e.g. the theme. */
  radio?: boolean;
  /** Starts a new group: a hairline above it. */
  group?: boolean;
  tone?: 'danger';
}

export interface OverflowMenuProps {
  /** Accessible name of the ⋯ button, e.g. "Task actions". */
  label: string;
  items: OverflowItem[];
  /** Native tooltip on the ⋯ button; defaults to the label. */
  title?: string;
  /** Optional heading line inside the menu. */
  heading?: string;
  /**
   * Draw the trigger as something other than ⋯ -- the task's name in the task
   * bar. `className` replaces the icon button's; the menu then opens under
   * the trigger's left edge instead of its right.
   */
  trigger?: { content: ReactNode; className: string };
}

const MENU_W = 260;

export default function OverflowMenu({ label, items, title, heading, trigger }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // One tick column for the whole menu when any item is a toggle, so labels align.
  const anyCheck = items.some((i) => i.checked !== undefined);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const place = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const anchor = trigger ? r.left : r.right - MENU_W;
    const left = Math.max(8, Math.min(anchor, window.innerWidth - MENU_W - 8));
    setPos({ top: r.bottom + 4, left });
  };

  // Dismiss on anything that moves the world under it -- the same set the
  // task-row menu uses.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && (menuRef.current?.contains(t) || buttonRef.current?.contains(t))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Give the keyboard to the first enabled item, as a native menu does.
  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={trigger?.className ?? 'icon-btn'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title ?? label}
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
      >
        {trigger ? trigger.content : <MoreGlyph />}
      </button>
      {open && (
        <div
          ref={menuRef}
          className="row-menu"
          role="menu"
          aria-label={label}
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
          onKeyDown={onMenuKey}
        >
          {heading && <div className="row-menu-head">{heading}</div>}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="row-menu-item"
              role={item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              data-group={item.group || undefined}
              data-check-col={anyCheck || undefined}
              data-tone={item.tone}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {anyCheck && (
                <span className="row-menu-check" aria-hidden="true">
                  {item.checked ? '✓' : ''}
                </span>
              )}
              <span className="row-menu-label">{item.label}</span>
              {item.aside !== undefined && <span className="row-menu-aside">{item.aside}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
