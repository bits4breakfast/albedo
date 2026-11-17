/**
 * To Send (#404): everything that goes with the task's next message, in the
 * order the message carries it -- a PR's failing checks (#280), then the
 * comments on code by file and line (#222), then the comments on transcript
 * passages in transcript order (#187). GitHub drafts (#287) are never here:
 * they go with Submit Review.
 *
 * Every view reads this one list, so they show the same items and the same
 * count: the list above the message box, Files ▸ Comments, the Review
 * Guide's Send and its file bubbles, Send N, and a marked passage's
 * popover in the transcript (#434), which shows that passage's quotes. What is sent is still made
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

/** Why Send N and ⇧⌘S do nothing while a send already carries To Send (#404): one wording everywhere. */
export const ON_ITS_WAY = 'Your message is already on its way with To Send';

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

// ---------------------------------------------------------------------------
// Open edits: kept beside the list, not in its rows
// ---------------------------------------------------------------------------

/*
   An edit of a To Send item is kept here, not in the row that shows it: the
   row goes when its item leaves the list -- delivered, or held with a
   message -- and what was typed must not go with it (#404 review). The
   composer settles an edit whose item has left (`settleOpenEdits` there): a
   code comment now sent takes the words as an edit, as a sent card's Edit
   would; a quote's words go into the message box. One per view, as each
   view opens its own: the list above the box, Files ▸ Comments, and the
   popover on a marked passage (#434).
*/

export type EditView = 'box' | 'files' | 'passage';

export interface OpenEdit {
  taskId: number;
  view: EditView;
  kind: 'code' | 'quote';
  /** A code comment's row id, or a quote's id. */
  id: number | string;
  /** What the field opened with: unchanged words settle as nothing. */
  initial: string;
  words: string;
}

const edits = new Map<string, OpenEdit>();
const editListeners = new Set<() => void>();
let editsByTask = new Map<number, readonly OpenEdit[]>();

const editKey = (taskId: number, view: EditView, kind: OpenEdit['kind'], id: number | string) => `${taskId}\u0000${view}\u0000${kind}\u0000${id}`;

function editsChanged(): void {
  editsByTask = new Map();
  for (const cb of [...editListeners]) cb();
}

export function openEdit(e: Omit<OpenEdit, 'words'>): void {
  edits.set(editKey(e.taskId, e.view, e.kind, e.id), { ...e, words: e.initial });
  editsChanged();
}

export function setEditWords(e: Pick<OpenEdit, 'taskId' | 'view' | 'kind' | 'id'>, words: string): void {
  const key = editKey(e.taskId, e.view, e.kind, e.id);
  const prev = edits.get(key);
  if (!prev || prev.words === words) return;
  edits.set(key, { ...prev, words });
  editsChanged();
}

export function closeEdit(e: Pick<OpenEdit, 'taskId' | 'view' | 'kind' | 'id'>): void {
  if (edits.delete(editKey(e.taskId, e.view, e.kind, e.id))) editsChanged();
}

/** Removed on purpose: its open edits in every view go too, never into the box. */
export function closeEditsFor(taskId: number, kind: OpenEdit['kind'], id: number | string): void {
  let any = false;
  for (const [k, e] of edits) {
    if (e.taskId === taskId && e.kind === kind && e.id === id) {
      edits.delete(k);
      any = true;
    }
  }
  if (any) editsChanged();
}

/** The task's open edits, every view's. */
export function editsOf(taskId: number): readonly OpenEdit[] {
  let list = editsByTask.get(taskId);
  if (!list) {
    list = [...edits.values()].filter((e) => e.taskId === taskId);
    editsByTask.set(taskId, list);
  }
  return list;
}

function subscribeEdits(cb: () => void): () => void {
  editListeners.add(cb);
  return () => {
    editListeners.delete(cb);
  };
}

const NO_EDITS: readonly OpenEdit[] = [];

/** The task's open edits, kept current. */
export function useOpenEdits(taskId: number | null): readonly OpenEdit[] {
  const read = () => (taskId === null ? NO_EDITS : editsOf(taskId));
  return useSyncExternalStore(subscribeEdits, read, read);
}

/** One item's open edit in one view, or undefined. */
export function findEdit(list: readonly OpenEdit[], view: EditView, kind: OpenEdit['kind'], id: number | string): OpenEdit | undefined {
  return list.find((e) => e.view === view && e.kind === kind && e.id === id);
}

/** Test seam. */
export function __resetOpenEdits(): void {
  edits.clear();
  editsChanged();
}
