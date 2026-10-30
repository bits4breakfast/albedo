/**
 * The task's title, editable in place (#152): in the task bar and on a task
 * row, where the title it replaces was.
 *
 * Opens with the whole title selected, as a Finder rename does. Return or
 * leaving the field saves; Escape puts the old title back. What is saved is
 * `renamedTitle`'s: one line, trimmed, capped; empty or unchanged saves
 * nothing, which is the same as cancelling.
 *
 * ## Where focus goes after
 *
 * Closed from the field itself -- Return, Escape, or a blur that did not
 * move focus anywhere (the window was left) -- focus goes back to where the
 * rename started, as RemoteControlDialog does: the element that held it
 * (`returnFocus: 'previous'`, a key such as ⇧F6 pressed in the task
 * terminal), else `fallbackFocus` (the task's terminal while it is live).
 * A rename started from a menu or a double-click has nothing worth going
 * back to (the menu is gone), so it uses the fallback directly. Closed
 * because focus moved -- a click elsewhere, ⌘1–9 to another task -- it stays
 * where it went.
 *
 * Its keys stop here, apart from ⌘/Ctrl chords and Tab. On a task row the
 * list reads bare j / k / arrows as moves, and Escape would reach whatever
 * is behind; none of them should see a key typed into a name.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MAX_TITLE, RENAME_HINT, renamedTitle } from './taskRename';
import './tasktitleedit.css';

export interface TaskTitleEditProps {
  title: string;
  /** Called once, with a cleaned title that differs from `title`. */
  onSave: (title: string) => void;
  /** Called once when nothing is saved: Escape, or nothing to save. */
  onDone: () => void;
  className?: string;
  /** `'previous'`: back to the element focused when the field opened. Default. */
  returnFocus?: 'previous' | 'fallback';
  /** Where focus goes when there is nothing to go back to. Leaves it as is when absent. */
  fallbackFocus?: () => void;
}

export default function TaskTitleEdit({
  title,
  onSave,
  onDone,
  className,
  returnFocus = 'previous',
  fallbackFocus,
}: TaskTitleEditProps) {
  // Read while rendering, before the field takes focus.
  const [from] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  /** A press outside the field since it opened: a blur after it is focus moving, not ours to undo. */
  const pressedElsewhere = useRef(false);
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement | null>(null);
  // Return then unmount would blur and save a second time.
  const finished = useRef(false);
  const latest = useRef({ value, title, onSave, onDone });
  latest.current = { value, title, onSave, onDone };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);

  /*
   * Gone without a blur -- ⌘1 or ⌘] moved to another task, and a removed
   * field does not reliably fire one: leaving is leaving, so it saves.
   */
  useEffect(() => {
    finished.current = false;
    return () => {
      if (finished.current) return;
      finished.current = true;
      const { value: v, title: t, onSave: save, onDone: done } = latest.current;
      const next = renamedTitle(v, t);
      if (next !== null) save(next);
      else done();
    };
  }, []);

  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      if (e.target !== ref.current) pressedElsewhere.current = true;
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => document.removeEventListener('pointerdown', onPress, true);
  }, []);

  const giveFocusBack = () => {
    if (
      returnFocus === 'previous' &&
      from instanceof HTMLElement &&
      from.isConnected &&
      from !== from.ownerDocument.body &&
      from !== ref.current
    ) {
      from.focus({ preventScroll: true });
      if (from.ownerDocument.activeElement === from) return;
    }
    fallbackFocus?.();
  };

  const finish = (save: boolean, refocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = save ? renamedTitle(ref.current?.value ?? value, title) : null;
    if (next !== null) onSave(next);
    else onDone();
    if (refocus) giveFocusBack();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Typing stays here; ⌘-chords (⌘1…9, ⌘N) and Tab (the area cycle) go on.
    if (!(e.metaKey || e.ctrlKey || e.key === 'Tab')) e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, true);
    }
  };

  return (
    <input
      ref={ref}
      className={`task-title-edit${className ? ` ${className}` : ''}`}
      type="text"
      value={value}
      // A title longer than this (made from a long prompt) is kept until edited.
      maxLength={Math.max(MAX_TITLE, title.length)}
      spellCheck={false}
      autoComplete="off"
      aria-label="Task name"
      title={RENAME_HINT}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      // Focus went somewhere (relatedTarget), or a press elsewhere is taking
      // it: leave it there. Otherwise (the window was left) it comes back.
      onBlur={(e) => finish(true, e.relatedTarget === null && !pressedElsewhere.current)}
      // On a row: clicking into the field is not selecting the task again.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  );
}
