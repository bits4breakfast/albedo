/**
 * What a review comment's card says about its state (#222), shared by the
 * File mode's CodeMirror widget (comments.ts) and the Diff mode's React card
 * (CommentViews.tsx), so the two read the same. Pure.
 *
 * The state is a chip, never a ✓: the ✓ is Resolve, and "✓ Sent" read as
 * done. Waiting says where it goes; Sent says when it went.
 */

import type { ReviewComment } from '../../db/comments';

/** "just now", "4 min ago", "2 h ago", "on 3 Nov". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `on ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

export interface CardState {
  /** For `data-state` on the card and its chip. */
  state: 'waiting' | 'sent';
  chip: string;
  /** The one action on the card's row; the others are under ⋯. */
  main: 'edit' | 'resolve';
  more: ReadonlyArray<'edit' | 'resolve' | 'delete'>;
}

export function cardState(
  c: Pick<ReviewComment, 'sentAt'> & Partial<Pick<ReviewComment, 'github'>>,
  now = Date.now(),
  /** #287: a draft for GitHub whose lines are not in the PR's diff. */
  outside = false,
): CardState {
  // A draft for GitHub (#287) waits for Submit Review, and says so. Nothing
  // to resolve before it is sent: it goes, or you delete it. Once GitHub has
  // it, it is resolved, and the thread GitHub shows takes its place.
  if (c.github === 'draft' && c.sentAt === null) {
    return {
      state: 'waiting',
      // ↑, as Push's count: it goes out to the remote. Where it goes is not
      // carried by the words alone.
      chip: outside ? '↑ Draft · not in the diff: in the summary' : '↑ Draft · goes with Submit Review',
      main: 'edit',
      more: ['delete'],
    };
  }
  if (c.sentAt === null) {
    return { state: 'waiting', chip: 'Waiting · goes with your next message', main: 'edit', more: ['resolve', 'delete'] };
  }
  return { state: 'sent', chip: `↗ Sent ${ago(c.sentAt, now)}`, main: 'resolve', more: ['edit', 'delete'] };
}

export const ACTION_LABEL: Record<'edit' | 'resolve' | 'delete', string> = {
  edit: 'Edit',
  resolve: '✓ Resolve',
  delete: 'Delete',
};

/** The trace a comment resolved on its own leaves on the file (#222). */
export function resolvedTrace(c: Pick<ReviewComment, 'lineStart' | 'lineEnd'>): string {
  const where = c.lineStart === c.lineEnd ? `Line ${c.lineStart}` : `Lines ${c.lineStart}–${c.lineEnd}`;
  return `${where} changed after it was sent`;
}

/**
 * Where a new comment goes on a review task (#287): a question for the
 * review session, or a draft for the pull request. Same words in the File
 * mode's box (comments.ts) and the Diff mode's (CommentViews.tsx).
 */
export const DESTINATIONS: ReadonlyArray<{ github: 'draft' | null; label: string }> = [
  { github: null, label: 'Ask Claude' },
  { github: 'draft', label: 'Draft for GitHub' },
];

export function draftPlaceholder(github: 'draft' | null): string {
  return github === 'draft'
    ? 'A comment for the pull request, sent with Submit Review. ⌘↵ to save, Esc to cancel.'
    : 'Leave a comment for Claude — any number of lines. ⌘↵ to save, Esc to cancel.';
}

/** The box's save button: Comment for Claude, Add Draft for GitHub; Save when editing. */
export function draftSaveLabel(github: 'draft' | null, editing: boolean): string {
  if (editing) return 'Save';
  return github === 'draft' ? 'Add Draft' : 'Comment';
}
