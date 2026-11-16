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
import { setMarking, useHeld, useMarking } from './outbox';
import { composeWithComments, type TranscriptComment } from './transcriptQuotes';
import { formatCiFailure, takeQueuedCi, type QueuedCiFailure } from './ciFailure';

// ---------------------------------------------------------------------------
// Releasing: delivered, being marked sent
// ---------------------------------------------------------------------------

/*
   Between a message carrying code comments being delivered and the database
   saying they are sent (and every view having read that back), they are no
   longer held -- the held message left the outbox -- and not yet sent. Left
   alone they would flash back into To Send, and a quick second Send would
   carry them again (#404 review). They stay "on their way" -- shown as Held
   -- from delivery until `RELEASE_SETTLE_MS` after the write settles, by
   which time every view's re-read has landed. A write that fails returns
   them to To Send at once, as before.
*/

/** How long after the sent mark is written a released comment still counts as on its way. */
export const RELEASE_SETTLE_MS = 2_000;

/**
 * Mark delivered code comments sent, keeping them on their way meanwhile:
 * the one way a delivered message's comments are marked (`takeCarried`, the
 * outbox's release).
 */
export function markCarriedSent(taskId: number, ids: readonly number[], what: string): void {
  if (ids.length === 0) return;
  setMarking(taskId, ids, true);
  markCommentsSent(taskId, ids).then(
    () => window.setTimeout(() => setMarking(taskId, ids, false), RELEASE_SETTLE_MS),
    (err: unknown) => {
      setMarking(taskId, ids, false);
      console.warn(what, err);
    },
  );
}

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
  // Delivered and being marked sent (`markCarriedSent`): on their way too.
  const carried = useCarriedCodeIds(taskId);
  const rows = waiting.taskId === taskId && taskId !== null ? waiting.rows : NONE;
  return useMemo(() => {
    if (carried.size === 0) return rows;
    const left = rows.filter((c) => !carried.has(c.id));
    return left.length === rows.length ? rows : left;
  }, [rows, carried]);
}

const NONE: readonly ReviewComment[] = [];

/**
 * The code comments on their way (#409): carried by a held message, or
 * delivered and being marked sent (`markCarriedSent`). Shown as Held, not To
 * Send, wherever they are listed, until they read as Sent.
 */
export function useCarriedCodeIds(taskId: number | null): ReadonlySet<number> {
  const held = useHeld(taskId);
  const marking = useMarking(taskId);
  return useMemo(() => {
    const ids = held.flatMap((h) => h.commentIds ?? []);
    if (ids.length === 0) return marking;
    return new Set([...ids, ...marking]);
  }, [held, marking]);
}

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
  markCarriedSent(taskId, carried.code, '[comments] the message went out, but its code comments could not be marked as sent');
}
