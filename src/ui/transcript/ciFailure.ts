/**
 * A PR's failing checks, waiting to go with the next message (#280, step 1).
 *
 * Whenever a task's open PR reads as failing on its head commit -- the
 * badge's own final reading (`summarizeChecks`) -- the failure joins the
 * task's waiting items, with the comments: listed above the message box, in
 * the Files pane's "Waiting", counted by the guide's Send. It goes with the
 * owner's next message, or alone with Send / ⇧⌘S, through the composer's own
 * path (held while a turn runs, a prompt is open or the app is offline).
 * **Nothing here sends.** Queueing is all a failure does by itself.
 *
 * Not `ciStep`'s once-per-commit rule: that one is for banners, where a
 * launch must not open with old news. Queueing is silent, so a failure that
 * was already final when first seen (it failed while the app was closed)
 * queues too, and so does a rerun that fails again on the same commit. What
 * stops a repeat is the owner: a commit they **handled** -- its failure went
 * out in a message (sent or held), they removed it, or Ask Claude to Fix put
 * it in the box -- never queues again, rerun or not. "Handled" is kept per
 * task for the head commit only, with the queue, and forgotten when the head
 * moves, the PR closes or the task goes.
 *
 * What it carries is what GitHub's checks say, whatever runs the CI: each
 * failing check's name, its conclusion and its link, with the PR number and
 * the head commit. Nothing is fetched (no logs, no steps).
 *
 * One per task, keyed by the head commit. It leaves:
 *   - when a message carrying it is delivered or held (`takeQueuedCi`), or
 *     the owner removes it, or Ask Claude to Fix takes the same commit
 *     (`removeQueuedCi`) -- all three mark the commit handled;
 *   - by itself, when the head moves (the new commit's failure queues in
 *     turn), when its checks run again or pass on the same commit, or when
 *     the PR is merged or closed (`ciQueueStep`);
 *   - with its task, when the task is archived or deleted
 *     (`forgetQueuedCi`, `keepQueuedCiFor`).
 *
 * Memory is the store; localStorage its copy, so it survives a restart.
 */

import { useSyncExternalStore } from 'react';
import { headKey } from '../../gh/ciTransition';
import type { PrStatus } from '../../gh/prStatus';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';

export interface FailedCheck {
  name: string;
  /** GitHub's conclusion in words: "failed", "timed out", "cancelled", ... */
  conclusion: string;
  url: string | null;
}

export interface QueuedCiFailure {
  prNumber: number;
  /** The head commit (`headKey`): a full SHA, or `#<pr>` when gh did not name one. */
  sha: string;
  checks: readonly FailedCheck[];
  queuedAt: number;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** The PR's failing checks, as the queue keeps them. */
export function failingChecks(pr: Pick<PrStatus, 'lines'>): FailedCheck[] {
  return pr.lines
    .filter((l) => l.bucket === 'fail')
    .map((l) => ({ name: l.name, conclusion: l.reason ?? 'failed', url: l.url }));
}

const live = (pr: PrStatus) => pr.state === 'open' || pr.state === 'draft';

function sameChecks(a: readonly FailedCheck[], b: readonly FailedCheck[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i]!.name && c.conclusion === b[i]!.conclusion && c.url === b[i]!.url);
}

/** What is kept per task: the queued failure, and the head commit the owner already handled. */
export interface CiQueueEntry {
  item?: QueuedCiFailure;
  /** A commit whose failure was sent, held, removed, or taken by Ask Claude to Fix. */
  handled?: string;
}

/**
 * One PR answer, against what is kept for the task. Queues on any failing
 * reading of a commit nothing is queued for and the owner has not handled;
 * drops the item when the head moves, the checks run again or pass, or the
 * PR is merged or closed.
 *
 * `pr` null is "no PR, or gh could not say": nothing is learned, all stays.
 */
export function ciQueueStep(prev: CiQueueEntry, pr: PrStatus | null, now: number): CiQueueEntry {
  if (pr === null) return prev;
  if (!live(pr)) return {}; // merged or closed: its checks stopped mattering
  const sha = headKey(pr);
  const handled = prev.handled === sha ? sha : undefined; // a push forgets the old commit
  const item = prev.item?.sha === sha ? prev.item : undefined;
  let next: QueuedCiFailure | undefined;
  if (pr.checks.kind === 'failing') {
    const checks = failingChecks(pr);
    if (item) {
      // Still failing: keep the list current (a job rerun to green leaves
      // it; one failing since joins it).
      next = sameChecks(checks, item.checks) && item.prNumber === pr.number ? item : { ...item, prNumber: pr.number, checks };
    } else if (handled === undefined) {
      next = { prNumber: pr.number, sha, checks, queuedAt: now };
    }
  }
  // Running again, passing, or no checks: nothing queued.
  if (next === prev.item && handled === prev.handled) return prev;
  return { ...(next ? { item: next } : {}), ...(handled !== undefined ? { handled } : {}) };
}

/** The commit as a message names it: seven characters, or nothing when gh named none. */
export function shortSha(sha: string): string | null {
  return sha.startsWith('#') ? null : sha.slice(0, 7);
}

/** "✗ CI failed · 2 checks": the label the queue shows. */
export function ciFailureLabel(f: QueuedCiFailure): string {
  const n = f.checks.length;
  return `✗ CI failed · ${n} check${n === 1 ? '' : 's'}`;
}

/** What Claude reads, ahead of the code comments in the message. */
export function formatCiFailure(f: QueuedCiFailure): string {
  const sha = shortSha(f.sha);
  const head = `CI failed on PR #${f.prNumber}${sha ? ` (${sha})` : ''}:`;
  const lines = f.checks.map((c) => `- ${c.name}: ${c.conclusion}${c.url ? ` — ${c.url}` : ''}`);
  return [head, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type QueueMap = ReadonlyMap<number, CiQueueEntry>;

function isFailure(value: unknown): value is QueuedCiFailure {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.prNumber === 'number' &&
    typeof f.sha === 'string' &&
    typeof f.queuedAt === 'number' &&
    Array.isArray(f.checks) &&
    f.checks.every(
      (c: unknown) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as FailedCheck).name === 'string' &&
        typeof (c as FailedCheck).conclusion === 'string' &&
        ((c as FailedCheck).url === null || typeof (c as FailedCheck).url === 'string'),
    )
  );
}

function isEntry(value: unknown): value is CiQueueEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (e.item === undefined || isFailure(e.item)) && (e.handled === undefined || typeof e.handled === 'string');
}

/** Task id -> what is kept for it. A malformed entry is dropped; none removes the key. */
export const queuedCiCodec: Codec<QueueMap> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const map = new Map<number, CiQueueEntry>();
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (Number.isInteger(id) && isEntry(value) && (value.item || value.handled !== undefined)) map.set(id, value);
    }
    return map;
  },
  encode: (queue) => (queue.size === 0 ? null : JSON.stringify(Object.fromEntries(queue))),
};

let queue: QueueMap | null = null;
const listeners = new Set<() => void>();

function current(): QueueMap {
  if (queue === null) queue = readPersisted(KEYS.queuedCiFailures, queuedCiCodec, new Map());
  return queue;
}

function commit(next: QueueMap): void {
  if (next === queue) return;
  queue = next;
  writePersisted(KEYS.queuedCiFailures, queuedCiCodec, next);
  for (const cb of [...listeners]) cb();
}

function put(taskId: number, entry: CiQueueEntry): void {
  const prev = current();
  if (prev.get(taskId) === entry) return;
  const next = new Map(prev);
  if (entry.item || entry.handled !== undefined) next.set(taskId, entry);
  else if (prev.has(taskId)) next.delete(taskId);
  else return;
  commit(next);
}

/** The task's queued failure, or null. */
export function queuedCiOf(taskId: number): QueuedCiFailure | null {
  return current().get(taskId)?.item ?? null;
}

/**
 * One PR answer for one task. The PR watch (`ciNotice.ts` `observeCi`) is
 * the production caller; chats and archived tasks never get here.
 */
export function observeCiQueue(taskId: number, pr: PrStatus | null, now = Date.now()): void {
  put(taskId, ciQueueStep(current().get(taskId) ?? {}, pr, now));
}

/**
 * The owner is done with commit `sha`'s failure: they removed it, or Ask
 * Claude to Fix put it in the box. It leaves, and that commit never queues
 * again, even after a rerun. A newer commit's queued failure is left alone.
 */
export function removeQueuedCi(taskId: number, sha: string): void {
  const prev = current().get(taskId) ?? {};
  if (prev.item && prev.item.sha !== sha) return;
  if (!prev.item && prev.handled === sha) return;
  put(taskId, { handled: sha });
}

/**
 * A message carrying commit `sha`'s failure was delivered or held: handled,
 * as a removal is. By commit, so a newer failure queued while that send was
 * under way stays for the next.
 */
export function takeQueuedCi(taskId: number, sha: string): void {
  removeQueuedCi(taskId, sha);
}

/** Everything kept for the task goes: it was archived or deleted. */
export function forgetQueuedCi(taskId: number): void {
  put(taskId, {});
}

/** Keep only these tasks' (the live ones): an archived or deleted task's goes. */
export function keepQueuedCiFor(taskIds: Iterable<number>): void {
  const keep = new Set(taskIds);
  const prev = current();
  const kept = [...prev].filter(([id]) => keep.has(id));
  if (kept.length !== prev.size) commit(new Map(kept));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The task's queued failure, kept current. */
export function useQueuedCi(taskId: number | null): QueuedCiFailure | null {
  const read = () => (taskId === null ? null : queuedCiOf(taskId));
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam: forget what is in memory, so the next read comes from storage. */
export function __resetQueuedCi(): void {
  queue = null;
  listeners.clear();
}
