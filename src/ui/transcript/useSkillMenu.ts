/**
 * The message box's `/` list (#349) and the strip a picked skill leaves above
 * the box: when the list is open, what it lists, the keys it takes, what a
 * pick does to the draft, and how long the strip stays. The rules are
 * skillMenu.ts; the drawing is SkillPopover.tsx.
 *
 * ## Keys, while the list is open and has rows
 *
 *   ↑ / ↓        move (wrapping, as the `@` list does)
 *   Return, Tab  insert `/name ` -- Return never sends while the list is open
 *   Esc          close; this `/` stays as typed and does not reopen the list
 *
 * Each is `preventDefault`ed, which keeps Tab from the window's area cycle
 * and Return from sending. Shift+Tab, ⌘, ⌥, ⌃ combinations and anything an
 * IME is composing are left alone. With the list closed -- nothing matches,
 * or the session has listed no skills yet -- every key does what it did
 * before: Return sends, Tab moves on. Only Esc closes the "No skills yet"
 * note.
 *
 * ## The strip
 *
 * Once a skill is picked, and while the message starts with `/<that or
 * another known skill>`, the strip shows the skill's whole description. It
 * goes when the message stops starting with a known skill (sent, deleted,
 * edited into an unknown name), and on ✕ until then: for that message only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { loadSkills, onSkillsChange, skillsFor, type Skill } from '../../capture';
import { leadingSkill, rankSkills, skillTrigger, type SkillItem } from './skillMenu';

export interface SkillMenu {
  /** The list is shown: a `/` under the caret, rows to offer, not dismissed. */
  open: boolean;
  /** A `/` is under the caret, but the session has listed no skills yet. */
  empty: boolean;
  items: SkillItem[];
  /** How many skills the session has. */
  total: number;
  active: number;
  query: string;
  setActive: (i: number) => void;
  pick: (item: SkillItem) => void;
  /** The textarea's keydown: true when the list took the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Read the caret again (after typing, a click, a selection change). */
  sync: () => void;
  close: () => void;
  /** The skill whose description the strip shows, or null. */
  strip: Skill | null;
  hideStrip: () => void;
}

/** The session's skills, as capture holds them; null until a listing is seen. */
export function useSessionSkills(sessionId: string | null): readonly Skill[] | null {
  const [skills, setSkills] = useState<readonly Skill[] | null>(() => (sessionId ? skillsFor(sessionId) : null));
  useEffect(() => {
    if (sessionId === null) {
      setSkills(null);
      return;
    }
    setSkills(skillsFor(sessionId));
    const off = onSkillsChange((sid) => {
      if (sid === sessionId) setSkills(skillsFor(sessionId));
    });
    void loadSkills(sessionId);
    return off;
  }, [sessionId]);
  return skills;
}

export function useSkillMenu({
  taskId,
  sessionId,
  text,
  inputRef,
  frozen,
  replace,
}: {
  taskId: number;
  sessionId: string | null;
  /** The draft, for the strip. */
  text: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** A send is pending: the draft is read-only, so nothing opens. */
  frozen: boolean;
  /** Put `insert` in place of `[start, end)` of the draft, as an edit (undo works). */
  replace: (start: number, end: number, insert: string) => void;
}): SkillMenu {
  const skills = useSessionSkills(sessionId);
  const [trigger, setTrigger] = useState<{ start: number; end: number; query: string } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState(false);
  const [stripHidden, setStripHidden] = useState(false);

  const sync = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const t = el.selectionEnd === caret ? skillTrigger(el.value, caret) : null;
    setTrigger((prev) =>
      prev === null && t === null
        ? prev
        : prev !== null && t !== null && prev.start === t.start && prev.end === t.end && prev.query === t.query
          ? prev
          : t,
    );
  }, [inputRef]);

  const close = useCallback(() => setTrigger(null), []);

  // A new `/` may open again; only the one dismissed stays closed.
  useEffect(() => {
    if (trigger === null || (dismissed !== null && trigger.start !== dismissed)) setDismissed(null);
  }, [trigger, dismissed]);

  // Another task's box: nothing open, no strip.
  useEffect(() => {
    setTrigger(null);
    setDismissed(null);
    setPicked(false);
    setStripHidden(false);
  }, [taskId]);

  const wanted = trigger !== null && trigger.start !== dismissed && !frozen;
  const query = trigger?.query ?? '';
  const items = useMemo(() => (wanted && skills ? rankSkills(skills, query) : []), [wanted, skills, query]);
  const open = items.length > 0;
  const empty = wanted && skills === null;

  // A new query starts at the top.
  useEffect(() => setActive(0), [query, trigger?.start]);
  const shownActive = items.length === 0 ? 0 : Math.min(active, items.length - 1);

  // The strip lives as long as the message starts with a known skill.
  const lead = leadingSkill(text, skills);
  useEffect(() => {
    if (lead === null) {
      setPicked(false);
      setStripHidden(false);
    }
  }, [lead]);

  const pick = useCallback(
    (item: SkillItem) => {
      if (trigger === null) return;
      const el = inputRef.current;
      const value = el?.value ?? '';
      // Replace the whole `/token`, and leave the caret past a space after
      // the name -- the one already there, or a new one -- so arguments can
      // follow and the list does not open again on the name just inserted.
      const after = value.slice(trigger.end, trigger.end + 1);
      const spaced = /\s/.test(after);
      setTrigger(null);
      // The strip is for a message that starts with the skill.
      if (value.slice(0, trigger.start).trim() === '') {
        setPicked(true);
        setStripHidden(false);
      }
      replace(trigger.start, spaced ? trigger.end + 1 : trigger.end, `/${item.skill.name}${spaced ? after : ' '}`);
    },
    [inputRef, trigger, replace],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (e.nativeEvent.isComposing || e.metaKey || e.altKey || e.ctrlKey) return false;
      if (!open) {
        // The note says why nothing is listed; Esc puts it away, nothing else is taken.
        if (empty && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setDismissed(trigger?.start ?? null);
          return true;
        }
        return false;
      }
      const last = items.length - 1;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActive(shownActive >= last ? 0 : shownActive + 1);
          return true;
        case 'ArrowUp':
          e.preventDefault();
          setActive(shownActive <= 0 ? last : shownActive - 1);
          return true;
        case 'Enter':
        case 'Tab': {
          if (e.shiftKey) return false;
          e.preventDefault();
          const item = items[shownActive];
          if (item) pick(item);
          return true;
        }
        case 'Escape':
          // One press dismisses one thing: not the editor, not the terminal.
          e.preventDefault();
          e.stopPropagation();
          setDismissed(trigger?.start ?? null);
          return true;
        default:
          return false;
      }
    },
    [open, empty, items, shownActive, pick, trigger],
  );

  const hideStrip = useCallback(() => setStripHidden(true), []);

  return {
    open,
    empty,
    items: open ? items : [],
    total: skills?.length ?? 0,
    active: shownActive,
    query,
    setActive,
    pick,
    onKeyDown,
    sync,
    close,
    strip: picked && !stripHidden ? lead : null,
    hideStrip,
  };
}
