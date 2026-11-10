/**
 * Which group of the task list a task sits in, and its place there.
 *
 * Pure. The groups are a presentation of facts the app already has, never a
 * status of their own: the derived status (`capture/status.ts`), when the
 * session last handed control back, when the task was last open
 * (`Task.seenAt`), its PR as the PR store last saw it (checks, review
 * decision, review threads), whether a finished turn left work on the branch
 * (`git/reviewWork.ts`), and whether you have started reviewing it in the
 * Review Guide (`guide/store.ts`). No new channel, and nothing read from the
 * terminal.
 *
 * Highest first; the first that holds decides (#278):
 *
 *   Archived
 *   Needs You        blocked
 *   Stopped on an    idle, and its last turn stopped on an API error
 *   Error            (`Task.apiError`, #338): it waits on you too
 *   Running          running
 *   Done             marked done, or its PR merged
 *   Needs You        its open or draft PR's checks failed (not while they run)
 *   Ready to Review  an unseen finish, with work to review
 *   Approved         an open PR, approved (GitHub's decision, else the
 *                    latest reviews: a change request outranks an approval)
 *   In Review        an open PR with changes requested, or with review threads
 *   Awaiting Review  an open PR with neither
 *   My Review        a Reviewed mark in its guide that still matches (#219),
 *                    and no PR up for review (none, a draft, or closed)
 *   Idle             everything else that is live
 *
 * "Open" is open and not a draft: once a PR is up for review, GitHub's state
 * decides, whatever the guide marks say. A chat has no branch and no PR, so
 * it never reaches the PR or review groups.
 */

import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';

export type GroupKey =
  | 'blocked'
  | 'errored'
  | 'active'
  | 'review'
  | 'mine'
  | 'team'
  | 'awaiting'
  | 'approved'
  | 'quiet'
  | 'done'
  | 'archived';

export const GROUP_ORDER: readonly GroupKey[] = [
  'blocked',
  'errored',
  'active',
  'review',
  'mine',
  'team',
  'awaiting',
  'approved',
  'quiet',
  'done',
  'archived',
];

export const GROUP_TITLE: Record<GroupKey, string> = {
  blocked: 'Needs You',
  errored: 'Stopped on an Error',
  active: 'Running',
  review: 'Ready to Review',
  mine: 'My Review',
  team: 'In Review',
  awaiting: 'Awaiting Review',
  approved: 'Approved',
  quiet: 'Idle',
  done: 'Done',
  archived: 'Archived',
};

/**
 * The colour a group is drawn in: the `--status-<hue>-fill/-edge/-ink` tokens
 * (styles.css). One colour per stage, so the two review pairs share theirs:
 * your own pass (Ready to Review, My Review) and the team's (In Review,
 * Awaiting Review). The collapsed rail merges each pair into one circle.
 */
export const GROUP_HUE: Record<GroupKey, string> = {
  blocked: 'blocked',
  errored: 'errored',
  active: 'running',
  review: 'review',
  mine: 'review',
  team: 'team',
  awaiting: 'team',
  approved: 'approved',
  quiet: 'idle',
  done: 'done',
  archived: 'archived',
};

/**
 * The group header's icon (#278): a pie in the group's edge colour that fills
 * as work moves along. A number is the filled fraction; `full` a solid dot,
 * `check` a solid dot with a check, `thin` archived's thin ring, `ring` a
 * heavier empty ring (Stopped on an Error: work that went nowhere, beside
 * Needs You's solid dot and in a red of its own, #338).
 */
export type GroupPieShape = number | 'full' | 'check' | 'thin' | 'ring';

export const GROUP_PIE: Record<GroupKey, GroupPieShape> = {
  blocked: 'full',
  errored: 'ring',
  active: 1 / 4,
  review: 1 / 2,
  mine: 1 / 2,
  awaiting: 5 / 8,
  team: 3 / 4,
  approved: 7 / 8,
  quiet: 0,
  done: 'check',
  archived: 'thin',
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
  /**
   * A Reviewed mark in the task's guide still matches its blocks (#219).
   * Absent reads as not reviewing.
   */
  reviewing?: boolean;
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

/** Open and not a draft: up for review. */
function prUpForReview(pr: PrStatus | null | undefined): pr is PrStatus {
  return pr?.state === 'open';
}

/**
 * The checks on an open or draft PR finished, and one failed: the badge's own
 * final reading. Never while they run (`pending`), and never on a merged or
 * closed PR, whose last checks are history.
 */
export function checksFailing(pr: PrStatus | null | undefined): boolean {
  return prOpen(pr) && pr?.checks.kind === 'failing';
}

/**
 * Where an open PR's review stands (#278). Approved is GitHub's decision (or
 * the latest reviews where no rule asks for one), and a change request
 * outranks an approval there already, so an approved PR has none standing.
 * Unresolved threads do not hold it back: the reviewer said it can go, and
 * the row still shows how many are open. Unknown threads read as none.
 */
export function reviewStage(pr: PrStatus): 'approved' | 'team' | 'awaiting' {
  if (pr.review === 'approved') return 'approved';
  if (pr.review === 'changes-requested') return 'team';
  if ((pr.reviewThreads?.total ?? 0) > 0) return 'team';
  return 'awaiting';
}

/**
 * The task is idle and its last turn stopped on an API error (#338). Only
 * idle: a turn running, a prompt waiting, a mark of Done or an archive is the
 * task having moved on, whatever is still stored.
 */
export function stoppedOnError(task: Pick<Task, 'status' | 'apiError'>): boolean {
  return task.status === 'idle' && task.apiError !== null;
}

/** Highest first: a prompt waiting on you outranks everything else. See the table above. */
export function groupOf(task: Pick<Task, 'kind' | 'status' | 'seenAt' | 'apiError'>, facts: GroupFacts): GroupKey {
  if (task.status === 'archived') return 'archived';
  if (task.status === 'blocked') return 'blocked';
  if (stoppedOnError(task)) return 'errored';
  if (task.status === 'running') return 'active';
  if (task.status === 'done' || prMerged(facts.pr)) return 'done';
  // A chat's PR is always null (the list never asks), so these are work tasks.
  if (task.kind !== 'chat' && checksFailing(facts.pr)) return 'blocked';
  if (unseenFinish(facts.finishedAt, task.seenAt) && hasWorkToReview(task, facts)) return 'review';
  // Below Ready to Review: a new finish is news about the branch, so it is
  // shown as such until you look.
  if (task.kind === 'chat') return 'quiet';
  if (prUpForReview(facts.pr)) return reviewStage(facts.pr);
  if (facts.reviewing === true) return 'mine';
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
