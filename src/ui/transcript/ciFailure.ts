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
 * the head commit. A project may ask for more (step 2, `Project.ciDetails`):
 * the failing step and the end of its log, fetched once when the failure is
 * queued (`ciDetailsQueue.ts`) and kept on the item as `details`. The item
 * shows at once and fills in; a fetch that fails leaves names and links and
 * says why. A fetch happens again only when the failure changes: a new
 * commit, or a check that was not failing before.
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
import { failedDetailsLine, formatCheckDetail, type CheckDetail, type CiDetailsState } from '../../gh/ciDetails';

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
  /**
   * The step and log tail per check (#280, step 2). Absent: not asked yet.
   * `fetching` is never kept across a restart, so a fetch the app quit in
   * the middle of is asked again.
   */
  details?: CiDetailsState;
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
      // it; one failing since joins it). A check joining is a new failure,
      // so its details are asked again; one leaving changes nothing to fetch.
      if (sameChecks(checks, item.checks) && item.prNumber === pr.number) next = item;
      else {
        const known = new Set(item.checks.map((c) => c.name));
        const { details, ...rest } = item;
        next = { ...rest, prNumber: pr.number, checks, ...(details && checks.every((c) => known.has(c.name)) ? { details } : {}) };
      }
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

/** A check's fetched details, when the item has them. */
export function detailOf(f: QueuedCiFailure, name: string): CheckDetail | null {
  return f.details?.state === 'ready' ? (f.details.checks.find((d) => d.name === name) ?? null) : null;
}

/**
 * What Claude reads, ahead of the code comments in the message: each check
 * with its step and log tail when they were fetched, and one line saying so
 * when they could not be. Still being fetched at Send: names and links.
 */
export function formatCiFailure(f: QueuedCiFailure): string {
  const sha = shortSha(f.sha);
  const head = `CI failed on PR #${f.prNumber}${sha ? ` (${sha})` : ''}:`;
  const lines = f.checks.flatMap((c) => {
    const d = detailOf(f, c.name);
    return [`- ${c.name}: ${c.conclusion}${c.url ? ` — ${c.url}` : ''}`, ...(d ? formatCheckDetail(d) : [])];
  });
  const failed = f.details?.state === 'failed' ? [failedDetailsLine(f.details.reason)] : [];
  return [head, ...lines, ...failed].join('\n');
}

/**
 * Which fetch a result belongs to: the commit and the checks it was asked
 * for. A result lands only while the item is still that commit's and asks
 * for no check the fetch did not.
 */
export function detailsKey(f: Pick<QueuedCiFailure, 'sha' | 'checks'>): string {
  return [f.sha, ...f.checks.map((c) => c.name)].join('\n');
}

function keyCovers(key: string, f: QueuedCiFailure): boolean {
  const [sha, ...names] = key.split('\n');
  const asked = new Set(names);
  return sha === f.sha && f.checks.every((c) => asked.has(c.name));
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

function isDetail(value: unknown): value is CheckDetail {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.name === 'string' &&
    (d.step === null || typeof d.step === 'string') &&
    Array.isArray(d.log) &&
    d.log.every((l) => typeof l === 'string') &&
    typeof d.more === 'number'
  );
}

/** A kept `details`, or undefined: malformed, or `fetching` (asked again). */
function keptDetails(value: unknown): CiDetailsState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const d = value as Record<string, unknown>;
  if (d.state === 'none') return { state: 'none' };
  if (d.state === 'failed' && typeof d.reason === 'string') return { state: 'failed', reason: d.reason };
  if (d.state === 'ready' && Array.isArray(d.checks) && d.checks.every(isDetail)) return { state: 'ready', checks: d.checks };
  return undefined;
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
      if (!Number.isInteger(id) || !isEntry(value) || (!value.item && value.handled === undefined)) continue;
      if (value.item) {
        const { details, ...item } = value.item;
        const kept = keptDetails(details);
        value.item = kept ? { ...item, details: kept } : item;
      }
      map.set(id, value);
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
 * The task's queued failure when its details have not been asked for yet --
 * just queued, changed, or brought back after a restart -- else null.
 */
export function ciDetailsWanted(taskId: number): QueuedCiFailure | null {
  const item = queuedCiOf(taskId);
  return item && item.details === undefined ? item : null;
}

/**
 * A fetch's answer (or its `fetching` mark), for the failure `key` names
 * (`detailsKey`). Dropped when the item has since moved on: sent, removed,
 * another commit, or a check the fetch did not ask about.
 */
export function setQueuedCiDetails(taskId: number, key: string, details: CiDetailsState): void {
  const entry = current().get(taskId);
  const item = entry?.item;
  if (!entry || !item || !keyCovers(key, item)) return;
  put(taskId, { ...entry, item: { ...item, details } });
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
