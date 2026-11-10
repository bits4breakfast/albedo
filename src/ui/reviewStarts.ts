/**
 * Which PRs you have started reviewing in Albedo (#315), for the Reviewing
 * tab: per review task, its Guide's Reviewed marks (guide/store.ts) and its
 * comments (db/comments.ts), as a {@link ReviewStart} keyed by the PR's url.
 *
 * Both are read when they change, never on a timer: the guide store's own
 * notification for a tick, and `onCommentsChanged` for a comment, which
 * re-reads that one task's comments in one query. Whether the PR is Started
 * -- these against your last submitted review -- is reviewActivity.ts's call.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../types';
import type { ReviewStart } from '../gh/reviewActivity';
import { commentFacts, onCommentsChanged, type CommentFacts } from '../db/comments';
import { guideProgress, useGuideStoreVersion } from '../guide/store';

/** The live review tasks among `tasks`: id -> PR url. */
function reviewIds(tasks: readonly Task[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const t of tasks) if (t.reviewUrl && t.status !== 'archived') out.set(t.id, t.reviewUrl);
  return out;
}

/** One PR's start, from its task's guide progress and comments; undefined when there is nothing to show for it. */
export function startOf(
  progress: { reviewing: boolean; tickedAt: number | null; reviewed: number; total: number } | undefined,
  comments: CommentFacts | undefined,
): ReviewStart | undefined {
  const ticked = progress?.reviewing === true;
  const commented = comments !== undefined && comments.total > 0;
  if (!ticked && !commented) return undefined;
  const times = [ticked ? progress.tickedAt : null, commented ? comments.latestAt : null].filter(
    (t): t is number => t !== null,
  );
  return {
    at: times.length > 0 ? Math.max(...times) : null,
    groups: progress ? { reviewed: progress.reviewed, total: progress.total } : null,
    drafts: comments?.drafts ?? 0,
    comments: commented ? comments.total - comments.drafts : 0,
  };
}

export function useReviewStarts(tasks: readonly Task[]): ReadonlyMap<string, ReviewStart> {
  const ids = useMemo(() => reviewIds(tasks), [tasks]);
  const idsKey = [...ids.keys()].sort((a, b) => a - b).join(',');
  const [comments, setComments] = useState<ReadonlyMap<number, CommentFacts>>(new Map());

  useEffect(() => {
    const wanted = idsKey === '' ? [] : idsKey.split(',').map(Number);
    if (wanted.length === 0) {
      setComments(new Map());
      return;
    }
    let live = true;
    const read = (which: readonly number[]) => {
      commentFacts(which)
        .then((facts) => {
          if (!live) return;
          setComments((prev) => {
            const next = new Map(prev);
            for (const id of which) {
              const f = facts.get(id);
              if (f) next.set(id, f);
              else next.delete(id);
            }
            return next;
          });
        })
        .catch((err) => console.warn('[reviews] could not read review comments', err));
    };
    read(wanted);
    const off = onCommentsChanged((taskId) => {
      if (wanted.includes(taskId)) read([taskId]);
    });
    return () => {
      live = false;
      off();
    };
  }, [idsKey]);

  const guideVersion = useGuideStoreVersion();
  return useMemo(() => {
    const progress = guideProgress([...ids.keys()]);
    const out = new Map<string, ReviewStart>();
    for (const [id, url] of ids) {
      const s = startOf(progress.get(id), comments.get(id));
      if (s) out.set(url, s);
    }
    return out;
    // guideVersion stands for the guide store read through guideProgress.
  }, [ids, comments, guideVersion]);
}
