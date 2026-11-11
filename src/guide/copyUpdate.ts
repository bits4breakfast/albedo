/**
 * Keeping a review copy current (#352): what Albedo remembers about it, and
 * the one action that moves it (Update Copy). No table, no contract change:
 * like the guide (store.ts), it lives in localStorage and in memory.
 *
 *  - **The last update, per task** (persisted): the head the copy was on and
 *    the one it moved to, whether that was a force-push, when, whether
 *    "Since your review" was hidden, and the explanation once written. The
 *    explanation is kept with the heads it was written for, so it is written
 *    once per update, never again on a restart. At most {@link MAX_UPDATES},
 *    the oldest going first.
 *  - **An update running, or the last one's failure** (memory): one at a
 *    time per task; a failure keeps git's words until the next try.
 *  - **The copy as last read** (memory): its head and commit count, read
 *    with git when the PR's head on GitHub changes or the copy moves. Never
 *    polled: the Reviewing tab's poll is what says GitHub moved.
 *  - **The explanation being written** (memory): for which heads, or why it
 *    failed. A late answer for heads that are no longer the last update's is
 *    dropped.
 *
 * Nothing here runs on its own: an update is a click (the band's Update
 * Copy, or "Update from GitHub" in the task's menu), and the explanation
 * follows that click once.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { KEYS, readPersisted, writePersisted, type Codec } from '../ui/persisted';
import { parsePrUrl } from '../git/reviewCheckout';
import { explainMaterial, readCopy, sinceChanges, updateReviewCopy, type CopyState, type SinceChanges } from '../git/reviewUpdate';
import { GuideError, writeChangesExplanation } from './writer';
import type { ReviewPr } from '../gh/reviewRequests';

export const MAX_UPDATES = 40;

export interface Explanation {
  text: string;
  /** Written from a diff cut to fit the call. */
  cut: boolean;
  at: number;
}

export interface UpdateRecord {
  prev: string;
  next: string;
  forced: boolean;
  /** When the copy moved, ms. */
  at: number;
  /** "Since your review" hidden until the next update. */
  hidden?: boolean;
  explanation?: Explanation;
}

function isRecord(v: unknown): v is UpdateRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const ex = r.explanation as Record<string, unknown> | undefined;
  return (
    typeof r.prev === 'string' &&
    typeof r.next === 'string' &&
    typeof r.forced === 'boolean' &&
    typeof r.at === 'number' &&
    (r.hidden === undefined || typeof r.hidden === 'boolean') &&
    (ex === undefined ||
      (typeof ex === 'object' && ex !== null && typeof ex.text === 'string' && typeof ex.cut === 'boolean' && typeof ex.at === 'number'))
  );
}

/** task id -> its last update. A malformed entry is dropped, not fatal. */
export const updatesCodec: Codec<Record<string, UpdateRecord>> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: Record<string, UpdateRecord> = {};
    for (const [k, v] of Object.entries(parsed)) if (isRecord(v)) out[k] = v;
    return out;
  },
  encode: (value) => {
    const newest = Object.entries(value)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_UPDATES);
    return newest.length === 0 ? null : JSON.stringify(Object.fromEntries(newest));
  },
};

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version++;
  for (const l of [...listeners]) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders on any change here: a record, an update, a copy read, an explanation. */
export function useSinceReviewVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function allRecords(): Record<string, UpdateRecord> {
  return readPersisted(KEYS.reviewUpdates, updatesCodec, {} as Record<string, UpdateRecord>);
}

export function updateRecordOf(taskId: number): UpdateRecord | null {
  return allRecords()[String(taskId)] ?? null;
}

function writeRecord(taskId: number, next: (r: UpdateRecord | null) => UpdateRecord | null): void {
  const all = allRecords();
  const r = next(all[String(taskId)] ?? null);
  if (r === null) delete all[String(taskId)];
  else all[String(taskId)] = r;
  writePersisted(KEYS.reviewUpdates, updatesCodec, all);
  changed();
}

/** Hide "Since your review" until the next update. */
export function hideSince(taskId: number): void {
  writeRecord(taskId, (r) => (r ? { ...r, hidden: true } : r));
}

// ---------------------------------------------------------------------------
// The copy as last read
// ---------------------------------------------------------------------------

/** What a review task's copy is checked against. */
export type CopyTask = Pick<Task, 'id' | 'worktreePath' | 'baseBranch' | 'reviewUrl'> & Partial<Pick<Task, 'createdAt'>>;

interface CopyEntry {
  /** What the read was asked for: the PR head on GitHub at the time, and the worktree. */
  key: string;
  state: CopyState | null;
}

const copies = new Map<number, CopyEntry>();
const copyReads = new Map<number, Promise<void>>();

export function copyOf(taskId: number): CopyState | null {
  return copies.get(taskId)?.state ?? null;
}

/**
 * Read the copy's head again, unless it was read for this same `key` (the
 * PR's head on GitHub) already. A failed read is "unknown", which shows
 * nothing.
 */
export function refreshCopy(task: CopyTask, key: string, force = false): Promise<void> {
  const fullKey = `${task.worktreePath}\n${key}`;
  const had = copies.get(task.id);
  if (!force && had?.key === fullKey) return copyReads.get(task.id) ?? Promise.resolve();
  copies.set(task.id, { key: fullKey, state: had?.state ?? null });
  const p = readCopy(task.worktreePath, task.baseBranch)
    .then((state) => state, () => null)
    .then((state) => {
      if (copies.get(task.id)?.key !== fullKey) return;
      copies.set(task.id, { key: fullKey, state });
      changed();
    })
    .finally(() => {
      if (copyReads.get(task.id) === p) copyReads.delete(task.id);
    });
  copyReads.set(task.id, p);
  return p;
}

// ---------------------------------------------------------------------------
// Is the copy behind? (pure)
// ---------------------------------------------------------------------------

export interface CopyBehind {
  /** New commits on GitHub, when they can be counted; null for "some". */
  commits: number | null;
  /** Force-pushed since the copy was taken. */
  forced: boolean;
  /** The PR's newest commit, and who opened the PR. */
  latestAt: number | null;
  author: string | null;
}

/**
 * Whether the PR's head on GitHub is not the copy's HEAD, and how: null when
 * they are the same or either is unknown. New comments alone never count.
 * The copy was taken at its last update, or when the task was made.
 */
export function copyBehind(
  pr: Pick<ReviewPr, 'headOid' | 'commitCount' | 'forcePushedAt' | 'lastCommitAt' | 'author'> | null,
  copy: CopyState | null,
  copiedAt: number | null,
): CopyBehind | null {
  if (!pr || !copy || pr.headOid === '' || copy.head === '' || pr.headOid === copy.head) return null;
  const forced = pr.forcePushedAt !== null && (copiedAt === null || pr.forcePushedAt > copiedAt);
  const n = copy.localCommits === null ? null : pr.commitCount - copy.localCommits;
  return { commits: !forced && n !== null && n > 0 ? n : null, forced, latestAt: pr.lastCommitAt, author: pr.author };
}

/** "3 new commits", "New commits", "Force-pushed". */
export function behindWords(b: CopyBehind): string {
  if (b.forced) return 'Force-pushed';
  if (b.commits === null) return 'New commits';
  return `${b.commits} new ${b.commits === 1 ? 'commit' : 'commits'}`;
}

// ---------------------------------------------------------------------------
// Update Copy
// ---------------------------------------------------------------------------

const updating = new Set<number>();
const failures = new Map<number, string>();
/** The last click found the copy already at the PR's head. */
const upToDate = new Set<number>();

export function isUpdating(taskId: number): boolean {
  return updating.has(taskId);
}

export function updateFailureOf(taskId: number): string | null {
  return failures.get(taskId) ?? null;
}

export function wasUpToDate(taskId: number): boolean {
  return upToDate.has(taskId);
}

export function dismissUpdateNotice(taskId: number): void {
  if (!failures.delete(taskId) && !upToDate.delete(taskId)) return;
  changed();
}

/** git's words, without the "(git … in …)" line Albedo adds for logs. */
function gitWords(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/\n\s*\(git [^\n]*\)\s*$/, '').trim() || m;
}

export interface UpdateOptions {
  /** Now, ms; a test seam. */
  now?: () => number;
  /** Write the explanation after a move (default true). */
  explain?: boolean;
}

/**
 * Update Copy: fetch the PR's head and move the copy to it, then record the
 * heads and write the explanation once. One at a time per task: a second
 * click while one runs does nothing. Never throws; a failure is kept for the
 * band, in git's words.
 */
export async function runReviewUpdate(task: CopyTask, o: UpdateOptions = {}): Promise<void> {
  if (updating.has(task.id)) return;
  const pr = task.reviewUrl ? parsePrUrl(task.reviewUrl) : null;
  if (!pr) return;
  updating.add(task.id);
  failures.delete(task.id);
  upToDate.delete(task.id);
  changed();
  try {
    const r = await updateReviewCopy(task.worktreePath, pr, task.baseBranch);
    if (r.moved) {
      const at = (o.now ?? Date.now)();
      writeRecord(task.id, () => ({ prev: r.prev, next: r.next, forced: r.forced, at }));
      if (o.explain !== false) void startExplanation(task.id, task.worktreePath);
    } else {
      upToDate.add(task.id);
    }
  } catch (err) {
    console.warn('[review] update failed', err);
    failures.set(task.id, gitWords(err));
  } finally {
    updating.delete(task.id);
    // The copy moved, or may have: read it again whatever GitHub says.
    void refreshCopy(task, 'after-update', true);
    changed();
  }
}

// ---------------------------------------------------------------------------
// The explanation
// ---------------------------------------------------------------------------

export type ExplainState = { kind: 'writing' } | { kind: 'failed'; message: string };

const explaining = new Map<number, { key: string; state: ExplainState }>();

function headsKey(r: Pick<UpdateRecord, 'prev' | 'next'>): string {
  return `${r.prev}..${r.next}`;
}

/** Being written, or failed, for the task's last update; null otherwise. */
export function explainStateOf(taskId: number): ExplainState | null {
  const r = updateRecordOf(taskId);
  const e = explaining.get(taskId);
  return r && e && e.key === headsKey(r) ? e.state : null;
}

/**
 * Write the explanation for the task's last update: once right after it,
 * and again on Rewrite. A second call while one is being written does
 * nothing. The answer is kept only if the last update is still the one it
 * was asked for.
 */
export async function startExplanation(taskId: number, worktreePath: string): Promise<void> {
  const r = updateRecordOf(taskId);
  if (!r) return;
  const key = headsKey(r);
  if (explaining.get(taskId)?.key === key && explaining.get(taskId)?.state.kind === 'writing') return;
  explaining.set(taskId, { key, state: { kind: 'writing' } });
  changed();
  try {
    const material = await explainMaterial(worktreePath, r.prev, r.next);
    const out = await writeChangesExplanation({ ...material, forced: r.forced });
    const now = updateRecordOf(taskId);
    if (!now || headsKey(now) !== key) return;
    writeRecord(taskId, (cur) => (cur && headsKey(cur) === key ? { ...cur, explanation: { ...out, at: Date.now() } } : cur));
    if (explaining.get(taskId)?.key === key) explaining.delete(taskId);
  } catch (err) {
    const message = err instanceof GuideError ? err.message : gitWords(err);
    console.warn('[review] explanation failed', message);
    if (explaining.get(taskId)?.key === key) explaining.set(taskId, { key, state: { kind: 'failed', message } });
  } finally {
    changed();
  }
}

// ---------------------------------------------------------------------------
// The commits and files between the two heads
// ---------------------------------------------------------------------------

export type ChangesLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; changes: SinceChanges }
  | { kind: 'error'; message: string };

/** By worktree and heads: what git says about two commits never changes. A few are kept. */
const MAX_CHANGES = 8;
const changesCache = new Map<string, ChangesLoad>();

function loadChanges(worktreePath: string, r: Pick<UpdateRecord, 'prev' | 'next'>): void {
  const key = `${worktreePath}\n${headsKey(r)}`;
  if (changesCache.has(key)) return;
  changesCache.set(key, { kind: 'loading' });
  while (changesCache.size > MAX_CHANGES) changesCache.delete(changesCache.keys().next().value as string);
  sinceChanges(worktreePath, r.prev, r.next).then(
    (changes) => changesCache.set(key, { kind: 'ready', changes }),
    (err: unknown) => changesCache.set(key, { kind: 'error', message: gitWords(err) }),
  ).finally(changed);
}

/** The commits and files of a task's last update, read once per pair of heads; null with no update. */
export function useSinceChanges(worktreePath: string, record: Pick<UpdateRecord, 'prev' | 'next'> | null): ChangesLoad | null {
  useSinceReviewVersion();
  const prev = record?.prev ?? null;
  const next = record?.next ?? null;
  useEffect(() => {
    if (prev && next) loadChanges(worktreePath, { prev, next });
  }, [worktreePath, prev, next]);
  if (!prev || !next) return null;
  return changesCache.get(`${worktreePath}\n${prev}..${next}`) ?? { kind: 'loading' };
}

/**
 * Whether a review task's copy is behind the PR on GitHub (the band, the
 * Reviewing row), from the list the Reviewing tab already polls. The copy
 * is read again only when that list's head for the PR changes.
 */
export function useCopyBehind(task: CopyTask | null, pr: ReviewPr | null): CopyBehind | null {
  useSinceReviewVersion();
  const head = pr?.headOid ?? '';
  const id = task?.id ?? null;
  const worktree = task?.worktreePath ?? '';
  const taskRef = task;
  useEffect(() => {
    if (taskRef && head) void refreshCopy(taskRef, head);
    // The task object changes on every list refresh; its id and folder are what matter.
  }, [id, worktree, head]);
  if (!task) return null;
  const rec = updateRecordOf(task.id);
  return copyBehind(pr, copyOf(task.id), rec?.at ?? task.createdAt ?? null);
}

/** Tests only. */
export function resetSinceReviewForTests(): void {
  copies.clear();
  copyReads.clear();
  updating.clear();
  failures.clear();
  upToDate.clear();
  explaining.clear();
  changesCache.clear();
  changed();
}
