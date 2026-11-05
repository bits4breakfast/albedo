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
 *
 * ## The summary (#262)
 *
 * Given `summary` (the task's, null for none), a second field follows the
 * name: the one-line summary shown under the title. The two are one edit:
 * Tab goes from the name to the summary and Shift+Tab back, Return in either
 * saves both, Escape puts both back, and moving focus from one to the other
 * is not leaving. Empty clears the summary; what is saved is `cleanSummary`'s.
 * Whatever the user saves stands until the session sets it again.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cleanSummary, MAX_SUMMARY, MAX_TITLE, RENAME_HINT, renamedTitle, SUMMARY_HINT } from './taskRename';
import './tasktitleedit.css';

export interface TaskTitleEditProps {
  title: string;
  /** Called once, with a cleaned title that differs from `title`. */
  onSave: (title: string) => void;
  /**
   * The task's summary, null for none: shows the summary field after the
   * name. Left out, there is no summary field.
   */
  summary?: string | null;
  /** Called once, with a cleaned summary (null clears) that differs from `summary`. */
  onSaveSummary?: (summary: string | null) => void;
  /** Called once when nothing is saved: Escape, or nothing to save. */
  onDone: () => void;
  className?: string;
  /** The summary field's class, for where it sits (the row's second line). */
  summaryClassName?: string;
  /** `'previous'`: back to the element focused when the field opened. Default. */
  returnFocus?: 'previous' | 'fallback';
  /** Where focus goes when there is nothing to go back to. Leaves it as is when absent. */
  fallbackFocus?: () => void;
}

/** What a close saves: the new title or null, and the new summary or undefined (unchanged). */
function changes(
  rawTitle: string,
  title: string,
  rawSummary: string | null,
  summary: string | null | undefined,
): { title: string | null; summary: string | null | undefined } {
  const next = rawSummary === null || summary === undefined ? undefined : cleanSummary(rawSummary);
  return { title: renamedTitle(rawTitle, title), summary: next === (summary ?? null) ? undefined : next };
}

export default function TaskTitleEdit({
  title,
  onSave,
  summary,
  onSaveSummary,
  onDone,
  className,
  summaryClassName,
  returnFocus = 'previous',
  fallbackFocus,
}: TaskTitleEditProps) {
  // Read while rendering, before the field takes focus.
  const [from] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  /** A press outside the field since it opened: a blur after it is focus moving, not ours to undo. */
  const pressedElsewhere = useRef(false);
  const [value, setValue] = useState(title);
  const withSummary = summary !== undefined;
  const [summaryValue, setSummaryValue] = useState(summary ?? '');
  const ref = useRef<HTMLInputElement | null>(null);
  const summaryRef = useRef<HTMLInputElement | null>(null);
  // Return then unmount would blur and save a second time.
  const finished = useRef(false);
  const latest = useRef({ value, summaryValue, title, summary, onSave, onSaveSummary, onDone });
  latest.current = { value, summaryValue, title, summary, onSave, onSaveSummary, onDone };

  /** Save what changed (each callback once), or say nothing was. */
  const commit = (save: boolean, rawTitle: string, rawSummary: string | null) => {
    const { title: t, summary: was, onSave: saveTitle, onSaveSummary: saveSummary, onDone: done } = latest.current;
    const next = save ? changes(rawTitle, t, rawSummary, was) : { title: null, summary: undefined };
    if (next.title !== null) saveTitle(next.title);
    if (next.summary !== undefined && saveSummary) saveSummary(next.summary);
    if (next.title === null && (next.summary === undefined || !saveSummary)) done();
  };

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
      const { value: v, summaryValue: sv, summary: was } = latest.current;
      commit(true, v, was === undefined ? null : sv);
    };
  }, []);

  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      if (e.target !== ref.current && e.target !== summaryRef.current) pressedElsewhere.current = true;
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
      from !== ref.current &&
      from !== summaryRef.current
    ) {
      from.focus({ preventScroll: true });
      if (from.ownerDocument.activeElement === from) return;
    }
    fallbackFocus?.();
  };

  const finish = (save: boolean, refocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    commit(
      save,
      ref.current?.value ?? value,
      withSummary ? (summaryRef.current?.value ?? summaryValue) : null,
    );
    if (refocus) giveFocusBack();
  };

  /** Focus moving between the two fields is not leaving the edit. */
  const isPair = (el: EventTarget | null) => withSummary && (el === ref.current || el === summaryRef.current);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // From the name to the summary and back: within the edit, not the area cycle.
    if (withSummary && e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const to = e.currentTarget === ref.current && !e.shiftKey ? summaryRef.current
        : e.currentTarget === summaryRef.current && e.shiftKey ? ref.current
        : null;
      if (to) {
        e.preventDefault();
        e.stopPropagation();
        to.focus({ preventScroll: true });
        return;
      }
    }
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

  // Focus went somewhere (relatedTarget), or a press elsewhere is taking it:
  // leave it there. Otherwise (the window was left) it comes back.
  const onBlur = (e: { relatedTarget: EventTarget | null }) => {
    if (isPair(e.relatedTarget)) return;
    finish(true, e.relatedTarget === null && !pressedElsewhere.current);
  };
  /** On a row: clicking into a field is not selecting the task again. */
  const stop = {
    onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onContextMenu: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  };

  const name = (
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
      onBlur={onBlur}
      {...stop}
    />
  );
  if (!withSummary) return name;
  return (
    <>
      {name}
      <input
        ref={summaryRef}
        className={`task-title-edit task-summary-edit${summaryClassName ? ` ${summaryClassName}` : ''}`}
        type="text"
        value={summaryValue}
        maxLength={Math.max(MAX_SUMMARY, (summary ?? '').length)}
        placeholder="Summary (optional)"
        spellCheck={false}
        autoComplete="off"
        aria-label="Task summary"
        title={SUMMARY_HINT}
        onChange={(e) => setSummaryValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...stop}
      />
    </>
  );
}
