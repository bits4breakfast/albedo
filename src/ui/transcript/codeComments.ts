/**
 * Comments on code (the editor's File and Diff modes, the Review Guide, a
 * transcript diff) waiting to go with the next message (#222). One queue
 * with the transcript's own comments (#187): every unsent one is listed
 * above the message box, and Send takes them all.
 *
 * They live in SQLite (db/comments.ts), not in the draft store: a code
 * comment outlives a message box. The composer reads them here, and marks
 * them sent once a message carrying them is delivered, or held and then
 * delivered (outboxRelease.ts), exactly as transcript comments are taken.
 */

import { useEffect, useMemo, useState } from 'react';
import { formatForClaude, listComments, markCommentsSent, onCommentsChanged, type ReviewComment } from '../../db/comments';
import { takeComments } from './drafts';
import { useHeld } from './outbox';
import { composeWithComments, type TranscriptComment } from './transcriptQuotes';
import { formatCiFailure, takeQueuedCi, type QueuedCiFailure } from './ciFailure';

/** A task's open, unsent code comments, by file then line; kept current. */
export function useWaitingCodeComments(taskId: number | null): readonly ReviewComment[] {
  // Tagged with the task they were read for: on the render that switches
  // task the state is still the last task's, and a Send in that frame must
  // carry none of them into this task's message.
  const [waiting, setWaiting] = useState<{ taskId: number | null; rows: readonly ReviewComment[] }>({ taskId: null, rows: [] });
  useEffect(() => {
    if (taskId === null) return;
    let live = true;
    const load = () =>
      void listComments(taskId).then(
        (rows) => {
          // A draft for GitHub (#287) waits for Submit Review, never for a
          // message to Claude.
          if (live) setWaiting({ taskId, rows: rows.filter((c) => c.sentAt === null && c.github === null) });
        },
        (err: unknown) => console.warn('[comments] could not load the waiting ones', err),
      );
    load();
    const off = onCommentsChanged((id) => {
      if (id === taskId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [taskId]);
  // A comment a held message carries is on its way, not waiting: it is
  // marked sent when that message is delivered (outboxRelease.ts). Left in
  // the queue, the next message would carry it again and Claude would read
  // it twice. Removing the held message brings it back here.
  const held = useHeld(taskId);
  const rows = waiting.taskId === taskId && taskId !== null ? waiting.rows : NONE;
  return useMemo(() => {
    const carried = new Set(held.flatMap((h) => h.commentIds ?? []));
    if (carried.size === 0) return rows;
    const left = rows.filter((c) => !carried.has(c.id));
    return left.length === rows.length ? rows : left;
  }, [rows, held]);
}

const NONE: readonly ReviewComment[] = [];

/**
 * What Send hands Claude Code: a queued CI failure (#280, `formatCiFailure`),
 * the code comments under the intro (as `formatForClaude` writes them), then
 * the transcript comments as quotes, then the box's own text. Any part may be
 * empty.
 */
export function composeMessage(
  code: readonly ReviewComment[],
  intro: string,
  transcript: readonly TranscriptComment[],
  box: string,
  ci: QueuedCiFailure | null = null,
): string {
  const rest = composeWithComments(transcript, box);
  const parts = [ci ? formatCiFailure(ci) : '', code.length > 0 ? formatForClaude(code, intro) : '', rest];
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}

/**
 * What a message carries: transcript comments by id, code comments by row
 * id, and the queued CI failure by its commit (#280).
 */
export interface Carried {
  transcript: readonly string[];
  code: readonly number[];
  ci?: string;
}

export const NOTHING_CARRIED: Carried = { transcript: [], code: [] };

/**
 * A message carrying these is held in the outbox: the transcript comments
 * and the CI failure leave the waiting list now -- the held message has them,
 * in its body -- while the code comments are marked sent only once it is
 * delivered (outboxRelease.ts).
 */
export function takeHeldCarried(taskId: number, carried: Carried): void {
  takeComments(taskId, carried.transcript);
  if (carried.ci !== undefined) takeQueuedCi(taskId, carried.ci);
}

/**
 * A message carrying these was delivered: the transcript ones and the CI
 * failure leave the waiting list, the code ones are marked sent (and so
 * leave it too).
 */
export function takeCarried(taskId: number, carried: Carried): void {
  takeHeldCarried(taskId, carried);
  if (carried.code.length === 0) return;
  markCommentsSent(taskId, carried.code).catch((err: unknown) =>
    console.warn('[comments] the message went out, but its code comments could not be marked as sent', err),
  );
}
