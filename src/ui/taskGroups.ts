/**
 * Which group of the task list a task sits in, and its place there.
 *
 * Pure. The groups are a presentation of facts the app already has, never a
 * status of their own: the derived status (`capture/status.ts`), when the
 * session last handed control back, when the task was last open
 * (`Task.seenAt`), its PR as the PR store last saw it, and whether a finished
 * turn left work on the branch (`git/reviewWork.ts`). No new channel, and
 * nothing read from the terminal.
 *
 *   Needs You        blocked
 *   Running          running
 *   Ready to Review  an unseen finish, with work to review
 *   Idle             everything else that is live
 *   Done             marked done, or its PR merged
 *   Archived
 */

import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';

export type GroupKey = 'blocked' | 'active' | 'review' | 'quiet' | 'done' | 'archived';

export const GROUP_ORDER: readonly GroupKey[] = ['blocked', 'active', 'review', 'quiet', 'done', 'archived'];

export const GROUP_TITLE: Record<GroupKey, string> = {
  blocked: 'Needs You',
  active: 'Running',
  review: 'Ready to Review',
  quiet: 'Idle',
  done: 'Done',
  archived: 'Archived',
};

/**
 * The glyph a group's label and its rows carry (`.status-dot[data-status]`).
 * Shape first: a row moved into a group by something other than its status
 * (Ready to Review, a merged PR's Done) wears the group's shape, so the label
 * and the rows beneath it never disagree.
 */
export const GROUP_GLYPH: Record<GroupKey, string> = {
  blocked: 'blocked',
  active: 'running',
  review: 'review',
  quiet: 'idle',
  done: 'done',
  archived: 'archived',
};

/** What a task's row does not carry, gathered by the list. */
export interface GroupFacts {
  /** When the session last handed control back; null if it never has. */
  finishedAt: number | null;
  /** The PR store's answer: a PR, null for none, undefined for not asked yet. */
  pr: PrStatus | null | undefined;
  /**
   * Whether the finish at `finishedAt` left commits against the base or
   * uncommitted changes. Undefined while not known, null when git could not
   * say -- both read as no work, so an unknown never claims your attention.
   */
  work: boolean | null | undefined;
}

/** A turn ended after the task was last open. Never opened: any finish. */
export function unseenFinish(finishedAt: number | null, seenAt: number | null): boolean {
  return finishedAt !== null && (seenAt === null || finishedAt > seenAt);
}

export function prMerged(pr: PrStatus | null | undefined): boolean {
  return pr?.state === 'merged';
}

function prOpen(pr: PrStatus | null | undefined): boolean {
  return pr?.state === 'open' || pr?.state === 'draft';
}

/**
 * There is something to review: an open PR, or the probe found commits or
 * uncommitted changes. A chat never has any -- it changes nothing by design.
 */
export function hasWorkToReview(task: Pick<Task, 'kind'>, facts: Pick<GroupFacts, 'pr' | 'work'>): boolean {
  if (task.kind === 'chat') return false;
  return prOpen(facts.pr) || facts.work === true;
}

/**
 * Whether the list should ask git about this task's branch: an unseen finish
 * on a work task whose PR does not already answer. Asked once per finish.
 */
export function wantsWorkProbe(task: Pick<Task, 'kind' | 'status' | 'seenAt'>, facts: GroupFacts): boolean {
  if (task.kind === 'chat' || task.status !== 'idle') return false;
  if (prOpen(facts.pr) || prMerged(facts.pr)) return false;
  return unseenFinish(facts.finishedAt, task.seenAt);
}

/** Highest first: a prompt waiting on you outranks everything else. */
export function groupOf(task: Pick<Task, 'kind' | 'status' | 'seenAt'>, facts: GroupFacts): GroupKey {
  if (task.status === 'archived') return 'archived';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'running') return 'active';
  if (task.status === 'done' || prMerged(facts.pr)) return 'done';
  if (unseenFinish(facts.finishedAt, task.seenAt) && hasWorkToReview(task, facts)) return 'review';
  return 'quiet';
}

function recency(t: Pick<Task, 'lastActivityAt' | 'createdAt'>): number {
  return t.lastActivityAt ?? t.createdAt;
}

/** When it became done, as near as is known: the merge, else its last activity. */
function doneAt(t: Pick<Task, 'lastActivityAt' | 'createdAt'>, facts: GroupFacts): number {
  const merged = facts.pr?.state === 'merged' && facts.pr.mergedAt ? Date.parse(facts.pr.mergedAt) : NaN;
  return Number.isFinite(merged) ? merged : recency(t);
}

/**
 * Order within a group. Ready to Review is oldest finish first, so nothing
 * waits forever behind newer work; Done is newest first; the rest are most
 * recent activity first, as the list always was.
 */
export function compareInGroup(
  group: GroupKey,
  a: Pick<Task, 'id' | 'lastActivityAt' | 'createdAt'>,
  fa: GroupFacts,
  b: Pick<Task, 'id' | 'lastActivityAt' | 'createdAt'>,
  fb: GroupFacts,
): number {
  let d: number;
  if (group === 'review') d = (fa.finishedAt ?? 0) - (fb.finishedAt ?? 0);
  else if (group === 'done') d = doneAt(b, fb) - doneAt(a, fa);
  else d = recency(b) - recency(a);
  return d !== 0 ? d : b.id - a.id;
}

/**
 * The `seenAt` to write now that the task is on screen, or null when the one
 * stored already covers its latest finish. Never earlier than the finish
 * itself, so a clock behind the transcript's cannot leave it unseen.
 */
export function seenUpdate(seenAt: number | null, finishedAt: number | null, now: number): number | null {
  if (!unseenFinish(finishedAt, seenAt)) return null;
  return Math.max(now, finishedAt ?? now);
}

/**
 * "Mark as Done" is offered on a task at rest that is not Done already. A task
 * working, or waiting on you, would replace the mark at once
 * (`keepUserStatus`), so it is not offered there.
 */
export function canMarkDone(task: Pick<Task, 'status'>, pr: PrStatus | null | undefined): boolean {
  return task.status === 'idle' && !prMerged(pr);
}

/**
 * "Mark as Not Done" undoes the mark, and only the mark: a merged PR is
 * GitHub's fact, not a choice to undo, and the task would stay in Done.
 */
export function canMarkNotDone(task: Pick<Task, 'status'>, pr: PrStatus | null | undefined): boolean {
  return task.status === 'done' && !prMerged(pr);
}
