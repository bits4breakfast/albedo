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
  listComments,
  onCommentsChanged,
  relocate,
  resolveComment,
  type ReviewComment,
} from '../../db/comments';
import { CommentCardView, CommentDraftView } from './CommentViews';

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
): { annotations: DiffAnnotations | null; notice: string | null; clearNotice: () => void } {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<{ from: number; to: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  // Where each comment sits in the file now; one whose code is gone is not
  // shown here (the File mode lists those as outdated).
  const placed = useMemo(() => {
    if (newText === null) return [];
    return comments.flatMap((c) => {
      const at = relocate(c, newText);
      return at.state === 'current' ? [{ comment: c, from: at.lineStart, to: at.lineEnd }] : [];
    });
  }, [comments, newText]);

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
    (d: Draft, text: string) => {
      if (newText === null) return;
      const write = d.editing
        ? editComment(taskId, d.editing.id, text)
        : addComment({
            taskId,
            path,
            lineStart: d.from,
            lineEnd: d.to,
            anchorText: newText.split('\n').slice(d.from - 1, d.to).join('\n'),
            body: text,
          });
      write.then(
        () => {
          setNotice(null);
          setDraft(null);
        },
        (err: unknown) => setNotice(`Could not save the comment, which is still in its box: ${message(err)}`),
      );
    },
    [taskId, path, newText],
  );

  const after = useCallback(
    (line: number): ReactNode => {
      const here = placed.filter((p) => p.to === line && p.comment.id !== draft?.editing?.id);
      const draftHere = draft !== null && draft.to === line;
      if (here.length === 0 && !draftHere) return null;
      return (
        <>
          {here.map((p) => (
            <CommentCardView
              key={p.comment.id}
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
              onSave={(text) => save(draft, text)}
              onCancel={() => setDraft(null)}
            />
          ) : null}
        </>
      );
    },
    [placed, draft, taskId, report, save],
  );

  const annotations = useMemo<DiffAnnotations | null>(
    () => (newText === null ? null : { after, picking, pick }),
    [newText, after, picking, pick],
  );

  return { annotations, notice, clearNotice: () => setNotice(null) };
}
