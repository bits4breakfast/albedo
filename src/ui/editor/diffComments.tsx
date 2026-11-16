/**
 * Review comments in the editor's Diff mode: the same comments as the File
 * mode, placed on the new side of the diff by their code (`relocate`),
 * written by pressing or dragging the + on the rows.
 *
 * The rules are the File mode's: a comment points at the file as it is on
 * disk, so a new one is refused while the editor holds unsaved edits; a box
 * closes only once its comment is stored; a failed write says so.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { DiffAnnotations } from '../transcript/Diff';
import {
  addComment,
  deleteComment,
  editComment,
  setCommentGithub,
  listComments,
  onCommentsChanged,
  relocate,
  reopenComment,
  resolveComment,
  resolveComments,
  shouldAutoResolve,
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
): { annotations: DiffAnnotations | null; notice: string | null; clearNotice: () => void; bar: ReactNode } {
  const isReview = !!review?.reviewUrl;
  const pr = isReview ? reviewPr(review) : null;
  const threads = useReviewThreads(isReview ? review!.reviewUrl! : null, pr, isReview ? review!.worktreePath : null);
  const ranges = usePrRanges(isReview ? review : null);
  const drafts = useGithubDrafts(isReview ? review : null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<{ from: number; to: number } | null>(null);
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
  const { placed, outdated, resolving } = useMemo(() => {
    const out = {
      placed: [] as Array<{ comment: ReviewComment; from: number; to: number }>,
      outdated: [] as ReviewComment[],
      resolving: [] as ReviewComment[],
    };
    if (newText === null) return out;
    for (const c of comments) {
      const at = relocate(c, newText);
      if (at.state === 'current') out.placed.push({ comment: c, from: at.lineStart, to: at.lineEnd });
      // `newText` is the file on disk; unsaved typing is not.
      else if (!unsaved && fresh && shouldAutoResolve(c, newText)) out.resolving.push(c);
      else out.outdated.push(c);
    }
    return out;
  }, [comments, newText, unsaved, fresh]);

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

  const save = useCallback(
    (d: Draft, text: string, github: 'draft' | null) => {
      if (newText === null) return;
      const editing = d.editing;
      const write = editing
        ? editComment(taskId, editing.id, text).then(() =>
            isReview && github !== editing.github ? setCommentGithub(taskId, editing.id, github) : undefined,
          )
        : addComment({
            taskId,
            path,
            lineStart: d.from,
            lineEnd: d.to,
            anchorText: newText.split('\n').slice(d.from - 1, d.to).join('\n'),
            body: text,
            // Only a review task's comment says where it goes (#287).
            ...(isReview ? { github } : {}),
          });
      write.then(
        () => {
          setNotice(null);
          setDraft(null);
        },
        (err: unknown) => setNotice(`Could not save the comment, which is still in its box: ${message(err)}`),
      );
    },
    [taskId, path, newText, isReview],
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

  const after = useCallback(
    (line: number): ReactNode => {
      const here = placed.filter((p) => p.to === line && p.comment.id !== draft?.editing?.id);
      const draftHere = draft !== null && draft.to === line;
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
          {draftHere && draft ? (
            <CommentDraftView
              key={`draft-${draft.editing?.id ?? 'new'}-${draft.from}`}
              from={draft.from}
              to={draft.to}
              initial={draft.editing?.body ?? ''}
              editing={draft.editing !== null}
              onSave={(text, github) => save(draft, text, github)}
              onCancel={() => setDraft(null)}
              // A review task's comment goes to GitHub unless you say so (#287).
              destination={isReview ? (draft.editing ? draft.editing.github : 'draft') : undefined}
            />
          ) : null}
        </>
      );
    },
    [placed, draft, taskId, report, save, threadsAt, threadCard, ranges, path, isReview],
  );

  // The lines an open comment covers get an edge (#252), so a card's lines
  // read as commented after its card is scrolled past.
  const commented = useCallback((line: number) => placed.some((p) => line >= p.from && line <= p.to), [placed]);
  const annotations = useMemo<DiffAnnotations | null>(
    () => (newText === null ? null : { after, picking, pick, commented }),
    [newText, after, picking, pick, commented],
  );

  const bar = (
    <CommentsBar
      traces={traces}
      outdated={outdated}
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
