/**
 * To Send (#404): everything that goes with the task's next message, in the
 * order the message carries it -- a PR's failing checks (#280), then the
 * comments on code by file and line (#222), then the comments on transcript
 * passages in transcript order (#187). GitHub drafts (#287) are never here:
 * they go with Submit Review.
 *
 * Every view reads this one list, so they show the same items and the same
 * count: the list above the message box, Files ▸ Comments, the Review
 * Guide's Send and its file bubbles, and Send N. What is sent is still made
 * by the composer from the same stores (`composeMessage`), so the count is
 * what goes.
 *
 * A code comment a held message carries is not here: it is on its way, and
 * shows as Held in the band (`useWaitingCodeComments`).
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { ReviewComment } from '../../db/comments';
import { useWaitingCodeComments } from './codeComments';
import { useComments } from './drafts';
import { useQueuedCi, type QueuedCiFailure } from './ciFailure';
import { inTranscriptOrder, type TranscriptComment } from './transcriptQuotes';

export interface ToSend {
  ci: QueuedCiFailure | null;
  /** By file, then line: as `listComments` returns them, and as the message lists them. */
  code: readonly ReviewComment[];
  /** In transcript order, as the message quotes them. */
  quotes: readonly TranscriptComment[];
  /** Every item, the CI failure counting as one. */
  count: number;
}

/** The list from its three stores. Pure. */
export function toSendOf(
  ci: QueuedCiFailure | null,
  code: readonly ReviewComment[],
  quotes: readonly TranscriptComment[],
): ToSend {
  return { ci, code, quotes: inTranscriptOrder(quotes), count: (ci ? 1 : 0) + code.length + quotes.length };
}

/** The task's To Send list, kept current. */
export function useToSend(taskId: number | null): ToSend {
  const ci = useQueuedCi(taskId);
  const code = useWaitingCodeComments(taskId);
  const quotes = useComments(taskId);
  return useMemo(() => toSendOf(ci, code, quotes), [ci, code, quotes]);
}

/** "Send 4"; just "Send" with nothing to send. */
export function sendLabel(count: number): string {
  return count > 0 ? `Send ${count}` : 'Send';
}

// ---------------------------------------------------------------------------
// Frozen while a send is under way
// ---------------------------------------------------------------------------

/*
   While the composer is sending -- writing, waiting for a session, or held at
   a permission prompt -- the message it made already carries these items, so
   none may be edited or removed from any view: an edit would be lost, and a
   removal would not take it out of what goes. The composer says when.
*/

const frozen = new Set<number>();
const frozenListeners = new Set<() => void>();

/** The composer's: whether a send of this task's is under way. */
export function setToSendFrozen(taskId: number, on: boolean): void {
  if (frozen.has(taskId) === on) return;
  if (on) frozen.add(taskId);
  else frozen.delete(taskId);
  for (const cb of [...frozenListeners]) cb();
}

function subscribeFrozen(cb: () => void): () => void {
  frozenListeners.add(cb);
  return () => {
    frozenListeners.delete(cb);
  };
}

/** Whether the task's To Send items can be changed now. */
export function useToSendFrozen(taskId: number | null): boolean {
  const read = () => taskId !== null && frozen.has(taskId);
  return useSyncExternalStore(subscribeFrozen, read, read);
}

/** Test seam. */
export function __resetToSendFrozen(): void {
  frozen.clear();
}
