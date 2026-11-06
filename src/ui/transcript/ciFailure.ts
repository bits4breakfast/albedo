/**
 * A PR's failing checks, waiting to go with the next message (#280, step 1).
 *
 * When a task's checks finish failing on a head commit -- `ciStep`'s final
 * failing reading (`gh/ciTransition.ts`), once per commit -- the failure joins
 * the task's waiting items, with the comments: listed above the message box,
 * in the Files pane's "Waiting", counted by the guide's Send. It goes with the
 * owner's next message, or alone with Send / ⇧⌘S, through the composer's own
 * path (held while a turn runs, a prompt is open or the app is offline).
 * **Nothing here sends.** Queueing is all a failure does by itself.
 *
 * What it carries is what GitHub's checks say, whatever runs the CI: each
 * failing check's name, its conclusion and its link, with the PR number and
 * the head commit. Nothing is fetched (no logs, no steps).
 *
 * One per task, keyed by the head commit. It leaves:
 *   - when a message carrying it is delivered or held (`takeQueuedCi`);
 *   - when the owner removes it, or Ask Claude to Fix puts the same failure
 *     in the box (`removeQueuedCi`);
 *   - by itself, when the PR's head moves (a newer failure replaces it if
 *     that one fails too), when its checks run again or pass on the same
 *     commit, or when the PR is merged or closed (`ciQueueStep`);
 *   - with its task, when the task is archived or deleted (`keepQueuedCiFor`).
 *
 * Memory is the store; localStorage its copy, so it survives a restart.
 */

import { useSyncExternalStore } from 'react';
import { headKey, type CiEvent } from '../../gh/ciTransition';
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

/**
 * One PR answer, against what is queued. `event` is what `ciStep` made of
 * the same answer: a failure is queued only on its final failing reading,
 * so the once-per-commit rule is `ciStep`'s.
 *
 * `pr` null is "no PR, or gh could not say": nothing is learned, the queued
 * one stays.
 */
export function ciQueueStep(
  prev: QueuedCiFailure | undefined,
  pr: PrStatus | null,
  event: CiEvent | null,
  now: number,
): QueuedCiFailure | undefined {
  if (pr === null) return prev;
  if (event?.outcome === 'fail' && live(pr)) {
    return { prNumber: pr.number, sha: event.sha, checks: failingChecks(pr), queuedAt: now };
  }
  if (!prev) return undefined;
  if (!live(pr)) return undefined; // merged or closed: its checks stopped mattering
  if (headKey(pr) !== prev.sha) return undefined; // a push: about a commit that is gone
  if (pr.checks.kind !== 'failing') return undefined; // running again, or passing
  // Still failing on the same commit: keep the list current (a job rerun to
  // green leaves it; one failing since joins it).
  const checks = failingChecks(pr);
  return sameChecks(checks, prev.checks) ? prev : { ...prev, prNumber: pr.number, checks };
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

type QueueMap = ReadonlyMap<number, QueuedCiFailure>;

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

/** Task id -> its queued failure. A malformed entry is dropped; none removes the key. */
export const queuedCiCodec: Codec<QueueMap> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const map = new Map<number, QueuedCiFailure>();
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (Number.isInteger(id) && isFailure(value)) map.set(id, value);
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

function put(taskId: number, f: QueuedCiFailure | undefined): void {
  const prev = current();
  if (prev.get(taskId) === f) return;
  const next = new Map(prev);
  if (f) next.set(taskId, f);
  else next.delete(taskId);
  commit(next);
}

/** The task's queued failure, or null. */
export function queuedCiOf(taskId: number): QueuedCiFailure | null {
  return current().get(taskId) ?? null;
}

/**
 * One PR answer for one task, with what `ciStep` made of it. The PR watch
 * (`ciNotice.ts` `observeCi`) is the production caller; chats and archived
 * tasks never get here.
 */
export function observeCiQueue(taskId: number, pr: PrStatus | null, event: CiEvent | null, now = Date.now()): void {
  const prev = current().get(taskId);
  put(taskId, ciQueueStep(prev, pr, event, now));
}

/** The owner removed it, or Ask Claude to Fix took that commit's failure. Only that commit's, when named. */
export function removeQueuedCi(taskId: number, sha?: string): void {
  const prev = current().get(taskId);
  if (!prev || (sha !== undefined && prev.sha !== sha)) return;
  put(taskId, undefined);
}

/**
 * A message carrying it was delivered or held. By commit: a newer failure
 * queued while that send was under way stays for the next.
 */
export function takeQueuedCi(taskId: number, sha: string): void {
  removeQueuedCi(taskId, sha);
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
