/**
 * The message box's `@` list (#154): when it is open, what it lists, the
 * keys it takes, and what a pick does to the draft. The list itself is
 * MentionPopover.tsx; the rules are mentions.ts.
 *
 * ## Keys, while the list is open and has rows
 *
 *   ↑ / ↓        move (wrapping, as Quick Open does)
 *   Return, Tab  insert the highlighted row
 *   Esc          close; this `@` stays as typed and does not reopen the list
 *
 * Each of these is `preventDefault`ed, which is what keeps Tab from reaching
 * the window's area cycle (focusAreas.ts skips a key already handled) and
 * Return from sending. Shift+Tab, ⌘ and ⌥ combinations are left alone. With
 * the list closed, or open with no rows, every key does what it did before:
 * Return sends, Tab moves on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { loadCodeIndex, peekCodeIndex } from '../../git/codeIndex';
import { useMentionSource } from '../mentionSource';
import {
  atPath,
  fileMention,
  mentionTrigger,
  rankPaths,
  rankTasks,
  taskMention,
  taskToken,
  type Mention,
  type MentionItem,
  type PathItem,
  type TaskItem,
} from './mentions';

export interface MentionList {
  /** Shown: an `@` under the caret, rows to offer, and not dismissed. */
  open: boolean;
  tasks: TaskItem[];
  paths: PathItem[];
  /** Index into `[...tasks, ...paths]`. */
  active: number;
  /** What was typed after the `@`. */
  query: string;
  /** The worktree's file list is still being read. */
  indexing: boolean;
  setActive: (i: number) => void;
  pick: (item: MentionItem) => void;
  /** The textarea's keydown, first: true when the list took the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Read the caret again (after typing, a click, a selection change). */
  sync: () => void;
  close: () => void;
}

export function useMentions({
  taskId,
  inputRef,
  storeRef,
  frozen,
  replace,
}: {
  taskId: number;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The composer's token store; a pick adds to it. */
  storeRef: { current: Map<string, Mention> };
  /** A send is pending: the draft is read-only, so nothing opens. */
  frozen: boolean;
  /** Put `insert` in place of `[start, end)` of the draft, as an edit (undo works). */
  replace: (start: number, end: number, insert: string) => void;
}): MentionList {
  const { tasks, projects } = useMentionSource();
  const [trigger, setTrigger] = useState<{ start: number; query: string; caret: number } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [indexing, setIndexing] = useState(false);

  const current = tasks.find((t) => t.id === taskId) ?? null;
  const worktree = current?.worktreePath || null;
  const projectId = current?.projectId ?? null;

  const sync = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const t = el.selectionEnd === caret ? mentionTrigger(el.value, caret) : null;
    setTrigger((prev) =>
      prev === null && t === null
        ? prev
        : prev !== null && t !== null && prev.start === t.start && prev.query === t.query && prev.caret === caret
          ? prev
          : t && { ...t, caret },
    );
  }, [inputRef]);

  const close = useCallback(() => setTrigger(null), []);

  // A new `@` may open again; only the one dismissed stays closed.
  useEffect(() => {
    if (trigger === null || (dismissed !== null && trigger.start !== dismissed)) setDismissed(null);
  }, [trigger, dismissed]);

  // Another task's box: nothing open.
  useEffect(() => {
    setTrigger(null);
    setDismissed(null);
  }, [taskId]);

  const wanted = trigger !== null && trigger.start !== dismissed && !frozen;
  const query = trigger?.query ?? '';

  // The worktree's files, as Go to File has them (codeIndex.ts): what is
  // cached at once, a fresh read behind it. Only once the list is wanted.
  useEffect(() => {
    if (!wanted || worktree === null) return;
    let live = true;
    const cached = peekCodeIndex(worktree);
    if (cached) setFiles(cached.files);
    setIndexing(cached === null);
    loadCodeIndex(worktree)
      .then((index) => {
        if (live) setFiles(index.files);
      })
      .catch((err: unknown) => {
        console.warn('mentions: could not list the worktree files', err);
      })
      .finally(() => {
        if (live) setIndexing(false);
      });
    return () => {
      live = false;
    };
  }, [wanted, worktree]);

  const taskItems = useMemo(
    () => (wanted ? rankTasks(tasks, projects, { id: taskId, projectId }, query) : []),
    [wanted, tasks, projects, taskId, projectId, query],
  );
  const pathItems = useMemo(() => (wanted && files ? rankPaths(files, query) : []), [wanted, files, query]);
  const count = taskItems.length + pathItems.length;
  const open = wanted && count > 0;

  // A new query starts at the top.
  useEffect(() => setActive(0), [query, trigger?.start]);
  const shownActive = count === 0 ? 0 : Math.min(active, count - 1);

  const pick = useCallback(
    (item: MentionItem) => {
      const el = inputRef.current;
      if (!el || trigger === null) return;
      const store = storeRef.current;
      let token: string;
      let mention: Mention;
      if (item.kind === 'task') {
        mention = taskMention(item.task);
        // The same task again reuses its token; another task with the same
        // title gets one of its own.
        const same = [...store].find(([, m]) => m.kind === 'task' && m.taskId === item.task.id);
        token = same ? same[0] : taskToken(item.task.title, item.projectName, (t) => store.has(t));
      } else {
        mention = fileMention(item.path);
        token = atPath(item.path);
      }
      store.set(token, mention);
      // Replace `@query` up to the caret, and leave the caret past a space
      // after the token -- the one already there, or a new one -- so the
      // list does not open again on the token just inserted.
      const after = el.value.slice(trigger.caret, trigger.caret + 1);
      const spaced = /\s/.test(after);
      setTrigger(null);
      replace(trigger.start, spaced ? trigger.caret + 1 : trigger.caret, `${token}${spaced ? after : ' '}`);
    },
    [inputRef, storeRef, trigger, replace],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || e.nativeEvent.isComposing || e.metaKey || e.altKey || e.ctrlKey) return false;
      const last = count - 1;
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
          const item = shownActive < taskItems.length ? taskItems[shownActive] : pathItems[shownActive - taskItems.length];
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
    [open, count, shownActive, taskItems, pathItems, pick, trigger],
  );

  return {
    open,
    tasks: open ? taskItems : [],
    paths: open ? pathItems : [],
    active: shownActive,
    query,
    indexing: indexing && files === null,
    setActive,
    pick,
    onKeyDown,
    sync,
    close,
  };
}
