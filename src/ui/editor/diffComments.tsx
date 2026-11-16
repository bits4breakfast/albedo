/**
 * Review comments in the editor's Diff mode: the same comments as the File
 * mode, placed on the new side of the diff by their code (`relocate`),
 * written by pressing or dragging the + on the rows. A comment on removed
 * lines (#402) is placed on the old side instead, under its deleted rows, by
 * its text in the base (`placeRemoved`).
 *
 * The rules are the File mode's: a comment points at the file as it is on
 * disk, so a new one is refused while the editor holds unsaved edits; a box
 * closes only once its comment is stored; a failed write says so.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { DiffAnnotations, RemovedAnnotations } from '../transcript/Diff';
import {
  addComment,
  addCommentsTogether,
  deleteComment,
  editComment,
  setCommentGithub,
  listComments,
  onCommentsChanged,
  placeRemoved,
  relocate,
  removedLines,
  reopenComment,
  resolveComment,
  resolveComments,
  shouldAutoResolve,
  sideOf,
  type CommentSide,
  type NewComment,
  type ReviewComment,
} from '../../db/comments';
import { CommentCardView, CommentDraftView, CommentsBar, ThreadCardView, ThreadsAside } from './CommentViews';
import { inDiff } from '../../gh/reviewSubmit';
import { placeThread, useReviewThreads, type ReviewThread } from '../../gh/reviewThreads';
import { reviewPr, useGithubDrafts, usePrRanges, type ReviewTask } from '../reviewDrafts';

interface Draft {
  from: number;
  to: number;
  editing: ReviewComment | null;
  /** #402: 'old' for removed lines, by the base's numbers. Absent: the file now. */
  side?: CommentSide;
  /** The row it is drawn under, when not `to` (a removed comment whose last line is back). */
  row?: number;
  /** #402: a selection over both sides: the removed lines it also covers, one comment each. */
  removed?: { from: number; to: number };
}

/** "On removed line 4", "On removed lines 4–5" (#402): a card's place on the old side. */
function onRemoved(from: number, to: number): string {
  return `On ${removedLines({ lineStart: from, lineEnd: to })}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useDiffComments(
  taskId: number,
  path: string,
  /** The file as it is now, which the diff's new side shows. Null: no comments. */
  newText: string | null,
  unsaved: boolean,
  /**
   * Whether `newText` is a read made for this view, so a sent comment whose
   * lines are gone from it may resolve itself (#222). False while a view
   * shows a remembered read (the guide's, #199): the file may have moved on
   * since, and a comment made on its newer lines would resolve against the
   * older text.
   */
  fresh = true,
  /**
   * The task, when it is a review task (#287): its comments can go to GitHub,
   * and other reviewers' threads show at their lines. Null or absent for
   * every other task, whose comments are exactly as before.
   */
  review: ReviewTask | null = null,
  /**
   * The diff's base, its old side (#402): where a comment on removed lines
   * is found again, and the + on deleted rows is offered. Null or absent:
   * no base to point at, so deleted rows take no comment and one already
   * made shows in the bar.
   */
  oldText: string | null = null,
  /**
   * #402: `oldText` is from the final base (gh has answered for the PR). A
   * base read before then may be the wrong branch's: it places comments on
   * removed lines but never resolves one.
   */
  oldSettled = true,
): { annotations: DiffAnnotations | null; notice: string | null; clearNotice: () => void; bar: ReactNode } {
  const isReview = !!review?.reviewUrl;
  const pr = isReview ? reviewPr(review) : null;
  const threads = useReviewThreads(isReview ? review!.reviewUrl! : null, pr, isReview ? review!.worktreePath : null);
  const ranges = usePrRanges(isReview ? review : null);
  const drafts = useGithubDrafts(isReview ? review : null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<{ from: number; to: number } | null>(null);
  const [pickingRemoved, setPickingRemoved] = useState<{ from: number; to: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Comments that resolved themselves while this diff was open (#222). */
  const [traces, setTraces] = useState<ReviewComment[]>([]);
  useEffect(() => setTraces([]), [taskId, path]);

  useEffect(() => {
    let live = true;
    const load = () =>
      void listComments(taskId).then(
        (all) => {
          if (live) setComments(all.filter((c) => c.path === path));
        },
        (err: unknown) => console.warn('[comments] could not load', err),
      );
    load();
    const off = onCommentsChanged((id) => {
      if (id === taskId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [taskId, path]);

  // Where each comment sits in the file now. One whose code is gone is in
  // the bar above the diff (#222): outdated when unsent, and resolved on its
  // own, with a trace, when sent. Never pinned to whatever is there now.
  // One on removed lines (#402) sits under its deleted rows while they are
  // still removed; back in the file, it resolves when sent, and is in the
  // bar otherwise, as is one whose text the base no longer has.
  const { placed, removed, outdated, back, resolving } = useMemo(() => {
    const out = {
      placed: [] as Array<{ comment: ReviewComment; from: number; to: number }>,
      removed: [] as Array<{ comment: ReviewComment; from: number; to: number; row: number }>,
      outdated: [] as ReviewComment[],
      back: new Set<number>(),
      resolving: [] as ReviewComment[],
    };
    if (newText === null) return out;
    for (const c of comments) {
      if (sideOf(c) === 'old') {
        const gone = oldText === null ? null : placeRemoved(c, oldText, newText);
        if (gone?.state === 'removed') out.removed.push({ comment: c, from: gone.lineStart, to: gone.lineEnd, row: gone.row });
        else if (gone?.state === 'back' && oldSettled && !unsaved && fresh && shouldAutoResolve(c, newText, oldText)) out.resolving.push(c);
        else {
          if (gone?.state === 'back') out.back.add(c.id);
          out.outdated.push(c);
        }
        continue;
      }
      const at = relocate(c, newText);
      if (at.state === 'current') out.placed.push({ comment: c, from: at.lineStart, to: at.lineEnd });
      // `newText` is the file on disk; unsaved typing is not.
      else if (!unsaved && fresh && shouldAutoResolve(c, newText)) out.resolving.push(c);
      else out.outdated.push(c);
    }
    return out;
  }, [comments, newText, oldText, oldSettled, unsaved, fresh]);

  const resolvingKey = resolving.map((c) => c.id).join(',');
  useEffect(() => {
    if (resolving.length === 0) return;
    setTraces((prev) => [...prev.filter((t) => !resolving.some((r) => r.id === t.id)), ...resolving]);
    resolveComments(taskId, resolving.map((c) => c.id)).catch((err: unknown) =>
      setNotice(`Could not resolve the comments whose lines changed: ${message(err)}`),
    );
    // The ids decide; `resolving` is rebuilt on every render of the same set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, resolvingKey]);

  const report = useCallback(
    (write: Promise<unknown>, what: string) => {
      write.catch((err: unknown) => setNotice(`Could not ${what}: ${message(err)}`));
    },
    [],
  );

  const pick = useCallback(
    (from: number, to: number, done: boolean) => {
      if (!done) {
        setPicking({ from, to });
        return;
      }
      setPicking(null);
      if (unsaved) {
        setNotice('Save your edits first: a comment refers to the file as it is on disk.');
        return;
      }
      setNotice(null);
      setDraft({ from, to, editing: null });
    },
    [unsaved],
  );

  // The + on deleted rows, and a selection over them (#402): the same rules
  // as the new side's, on the base's lines.
  const pickRemoved = useCallback(
    (from: number, to: number, done: boolean) => {
      if (!done) {
        setPickingRemoved({ from, to });
        return;
      }
      setPickingRemoved(null);
      if (unsaved) {
        setNotice('Save your edits first: a comment refers to the file as it is on disk.');
        return;
      }
      setNotice(null);
      setDraft({ from, to, editing: null, side: 'old' });
    },
    [unsaved],
  );

  // A selection over deleted and added lines (#402): one box, under the
  // added lines, saved as one comment per side.
  const pickBoth = useCallback(
    (added: { from: number; to: number }, gone: { from: number; to: number }) => {
      if (unsaved) {
        setNotice('Save your edits first: a comment refers to the file as it is on disk.');
        return;
      }
      setNotice(null);
      setDraft({ ...added, editing: null, removed: gone });
    },
    [unsaved],
  );

  const save = useCallback(
    (d: Draft, text: string, github: 'draft' | null) => {
      if (newText === null) return;
      const editing = d.editing;
      // Only a review task's comment says where it goes (#287).
      const where = isReview ? { github } : {};
      // On removed lines (#402): the base's lines, quoted from the base.
      const removedRow = (r: { from: number; to: number }): NewComment | null =>
        oldText === null
          ? null
          : {
              taskId,
              path,
              lineStart: r.from,
              lineEnd: r.to,
              anchorText: oldText.split('\n').slice(r.from - 1, r.to).join('\n'),
              body: text,
              ...where,
              side: 'old',
            };
      const newRow: NewComment = {
        taskId,
        path,
        lineStart: d.from,
        lineEnd: d.to,
        anchorText: newText.split('\n').slice(d.from - 1, d.to).join('\n'),
        body: text,
        ...where,
      };
      const unknownBase = () => Promise.reject(new Error('the base of this diff is not known'));
      let write: Promise<unknown>;
      if (editing) {
        write = editComment(taskId, editing.id, text).then(() =>
          isReview && github !== editing.github ? setCommentGithub(taskId, editing.id, github) : undefined,
        );
      } else if (d.side === 'old') {
        const row = removedRow(d);
        write = row ? addComment(row) : unknownBase();
      } else if (d.removed) {
        // Both sides in one statement: both stored, or neither.
        const row = removedRow(d.removed);
        write = row ? addCommentsTogether([row, newRow]) : unknownBase();
      } else {
        write = addComment(newRow);
      }
      write.then(
        () => {
          setNotice(null);
          setDraft(null);
        },
        (err: unknown) => setNotice(`Could not save the comment, which is still in its box: ${message(err)}`),
      );
    },
    [taskId, path, newText, oldText, isReview],
  );

  // Other reviewers' threads on this file (#287, step 4): at the line
  // holding their code here, or, when it is not on this version's lines, in
  // the bar above the file. Never pinned to a guess.
  const { threadsAt, threadsAside } = useMemo(() => {
    const at = new Map<number, ReviewThread[]>();
    const aside: ReviewThread[] = [];
    if (!isReview || newText === null) return { threadsAt: at, threadsAside: aside };
    for (const t of threads) {
      if (t.path !== path) continue;
      const line = placeThread(t, newText);
      if (line === null) aside.push(t);
      else at.set(line, [...(at.get(line) ?? []), t]);
    }
    return { threadsAt: at, threadsAside: aside };
  }, [isReview, threads, path, newText]);

  const reply = useCallback(
    (t: ReviewThread, text: string) => {
      const write = addComment({
        taskId,
        path: t.path,
        lineStart: t.line ?? t.originalLine ?? 1,
        lineEnd: t.line ?? t.originalLine ?? 1,
        anchorText: '',
        body: text,
        replyTo: t.replyTo,
      });
      write.then(
        () => setNotice(null),
        (err: unknown) => setNotice(`Could not save the reply, which is still in its box: ${message(err)}`),
      );
      return write;
    },
    [taskId],
  );
  const threadCard = useCallback(
    (t: ReviewThread, line: number | null) => (
      <ThreadCardView
        key={t.id}
        thread={t}
        prUrl={review?.reviewUrl ?? ''}
        line={line}
        replies={drafts.filter((d) => d.replyTo === t.replyTo)}
        onReply={(text) => reply(t, text)}
        onEditReply={(r, text) => {
          const write = editComment(taskId, r.id, text);
          write.catch((err: unknown) => setNotice(`Could not save the reply, which is still in its box: ${message(err)}`));
          return write;
        }}
        onDeleteReply={(r) => report(deleteComment(taskId, r.id), 'delete the reply')}
      />
    ),
    [review?.reviewUrl, drafts, reply, taskId, report],
  );

  const draftView = useCallback((d: Draft): ReactNode => (
    <CommentDraftView
      key={`draft-${d.editing?.id ?? 'new'}-${d.side ?? 'new'}-${d.from}`}
      from={d.from}
      to={d.to}
      label={
        d.side === 'old'
          ? onRemoved(d.from, d.to)
          : d.removed
            ? `${onRemoved(d.removed.from, d.removed.to)} and ${d.from === d.to ? `line ${d.from}` : `lines ${d.from}–${d.to}`}`
            : undefined
      }
      initial={d.editing?.body ?? ''}
      editing={d.editing !== null}
      onSave={(text, github) => save(d, text, github)}
      onCancel={() => setDraft(null)}
      // A review task's comment goes to GitHub unless you say so (#287).
      destination={isReview ? (d.editing ? d.editing.github : 'draft') : undefined}
    />
  ), [save, isReview]);

  const after = useCallback(
    (line: number): ReactNode => {
      const here = placed.filter((p) => p.to === line && p.comment.id !== draft?.editing?.id);
      const draftHere = draft !== null && draft.side !== 'old' && draft.to === line;
      const threadsHere = threadsAt.get(line) ?? [];
      if (here.length === 0 && !draftHere && threadsHere.length === 0) return null;
      return (
        <>
          {threadsHere.map((t) => threadCard(t, line))}
          {here.map((p) => (
            <CommentCardView
              key={p.comment.id}
              outside={p.comment.github === 'draft' && ranges !== null && !inDiff(ranges, path, p.from, p.to)}
              comment={{ ...p.comment, lineStart: p.from, lineEnd: p.to }}
              onEdit={() => setDraft({ from: p.from, to: p.to, editing: p.comment })}
              onResolve={() => report(resolveComment(taskId, p.comment.id), 'resolve the comment')}
              onDelete={() => report(deleteComment(taskId, p.comment.id), 'delete the comment')}
            />
          ))}
          {draftHere && draft ? draftView(draft) : null}
        </>
      );
    },
    [placed, draft, taskId, report, draftView, threadsAt, threadCard, ranges, path],
  );

  // Under a deleted row (#402): the comments on removed lines that end there, and their box.
  const afterRemoved = useCallback(
    (line: number): ReactNode => {
      const here = removed.filter((p) => p.row === line && p.comment.id !== draft?.editing?.id);
      const draftHere = draft !== null && draft.side === 'old' && (draft.row ?? draft.to) === line;
      if (here.length === 0 && !draftHere) return null;
      return (
        <>
          {here.map((p) => (
            <CommentCardView
              key={p.comment.id}
              outside={p.comment.github === 'draft' && ranges !== null && !inDiff(ranges, path, p.from, p.to, 'old')}
              comment={{ ...p.comment, lineStart: p.from, lineEnd: p.to }}
              onEdit={() => setDraft({ from: p.from, to: p.to, row: p.row, side: 'old', editing: p.comment })}
              onResolve={() => report(resolveComment(taskId, p.comment.id), 'resolve the comment')}
              onDelete={() => report(deleteComment(taskId, p.comment.id), 'delete the comment')}
            />
          ))}
          {draftHere && draft ? draftView(draft) : null}
        </>
      );
    },
    [removed, draft, taskId, report, draftView, ranges, path],
  );

  // The lines an open comment covers get an edge (#252), so a card's lines
  // read as commented after its card is scrolled past.
  const commented = useCallback((line: number) => placed.some((p) => line >= p.from && line <= p.to), [placed]);
  const commentedRemoved = useCallback((line: number) => removed.some((p) => line >= p.from && line <= p.to), [removed]);
  // Deleted rows take comments only with a base to point at (#402).
  const removedHooks = useMemo<RemovedAnnotations | undefined>(
    () =>
      oldText === null ? undefined : { after: afterRemoved, picking: pickingRemoved, pick: pickRemoved, commented: commentedRemoved },
    [oldText, afterRemoved, pickingRemoved, pickRemoved, commentedRemoved],
  );
  const annotations = useMemo<DiffAnnotations | null>(
    () =>
      newText === null
        ? null
        : removedHooks
          ? { after, picking, pick, commented, removed: removedHooks, pickBoth }
          : { after, picking, pick, commented },
    [newText, after, picking, pick, commented, removedHooks, pickBoth],
  );

  const bar = (
    <CommentsBar
      traces={traces}
      outdated={outdated}
      back={back}
      onReopen={(c) => {
        setTraces((prev) => prev.filter((t) => t.id !== c.id));
        report(reopenComment(taskId, c.id), 'reopen the comment');
      }}
      onResolve={(c) => report(resolveComment(taskId, c.id), 'resolve the comment')}
      onDelete={(c) => report(deleteComment(taskId, c.id), 'delete the comment')}
      aside={threadsAside.length > 0 ? <ThreadsAside threads={threadsAside} render={(t) => threadCard(t, null)} /> : null}
    />
  );

  return { annotations, notice, clearNotice: () => setNotice(null), bar };
}
