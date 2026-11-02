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

import { useEffect, useState } from 'react';
import { formatForClaude, listComments, markCommentsSent, onCommentsChanged, type ReviewComment } from '../../db/comments';
import { takeComments } from './drafts';
import { composeWithComments, type TranscriptComment } from './transcriptQuotes';

/** A task's open, unsent code comments, by file then line; kept current. */
export function useWaitingCodeComments(taskId: number | null): readonly ReviewComment[] {
  const [waiting, setWaiting] = useState<readonly ReviewComment[]>([]);
  useEffect(() => {
    if (taskId === null) {
      setWaiting([]);
      return;
    }
    let live = true;
    const load = () =>
      void listComments(taskId).then(
        (rows) => {
          if (live) setWaiting(rows.filter((c) => c.sentAt === null));
        },
        (err: unknown) => console.warn('[comments] could not load the waiting ones', err),
      );
    setWaiting([]);
    load();
    const off = onCommentsChanged((id) => {
      if (id === taskId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [taskId]);
  return waiting;
}

/**
 * What Send hands Claude Code: the code comments under the intro (as
 * `formatForClaude` writes them), then the transcript comments as quotes,
 * then the box's own text. Any part may be empty.
 */
export function composeMessage(
  code: readonly ReviewComment[],
  intro: string,
  transcript: readonly TranscriptComment[],
  box: string,
): string {
  const rest = composeWithComments(transcript, box);
  if (code.length === 0) return rest;
  const head = formatForClaude(code, intro);
  return rest.trim().length > 0 ? `${head}\n\n${rest}` : head;
}

/** The comments a message carries: transcript ones by id, code ones by row id. */
export interface Carried {
  transcript: readonly string[];
  code: readonly number[];
}

export const NOTHING_CARRIED: Carried = { transcript: [], code: [] };

/**
 * A message carrying these was delivered: the transcript ones leave the
 * waiting list, the code ones are marked sent (and so leave it too).
 */
export function takeCarried(taskId: number, carried: Carried): void {
  takeComments(taskId, carried.transcript);
  if (carried.code.length === 0) return;
  markCommentsSent(taskId, carried.code).catch((err: unknown) =>
    console.warn('[comments] the message went out, but its code comments could not be marked as sent', err),
  );
}
