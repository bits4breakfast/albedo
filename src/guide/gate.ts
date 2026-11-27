/**
 * Review your own branch before its PR (#464): whether the Review Guide is
 * done for the branch as it is now.
 *
 * Create PR (the Files pane's GitBar, the task bar's PrBadge, the Guide's own
 * banner) is offered only once the task's guide was written for the branch as
 * it is now -- its `diffHash` is the hash of the change as last read -- and
 * every group it counts is Reviewed. Until then those places offer Review
 * Changes, with how far along it is. Set Aside does not count, as in the
 * pane's "N of M reviewed"; Reviewed marks on blocks that did not change
 * survive a rewrite, as they always did (store.ts).
 *
 * Every project, no setting: the owner's decision. The way past it is "Create
 * PR without Review…", behind a confirmation (UnreviewedPrDialog). Claude
 * running `gh pr create` itself is not blocked: no hook.
 *
 * Nothing new is stored. The facts are the guide store's (the guide, the
 * Reviewed marks, the last read of the branch and its hash) and git's (how
 * many commits since the guide's `head`). The branch is read the way the
 * pane reads it (`loadBranchDiff`), for a task with a guide only, at most
 * every {@link READ_MIN_MS}, and never while a turn runs -- work only changes
 * the branch then, and a turn's end is when to look.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { git } from '../git/worktree';
import { getPrStatus } from '../gh/prStore';
import { prLookupBranch } from '../gh/prBranch';
import { measuredBase } from '../ui/mergeTarget';
import { useMeasuredBase } from '../ui/useMeasuredBase';
import { loadBranchDiff, type LoadedBranchDiff } from './branchDiff';
import type { BranchDiff } from './blocks';
import { readWorkingFile } from './readWorking';
import {
  guideProgress,
  guideStoreVersion,
  keepLastRead,
  lastHashOf,
  lastReadOf,
  loadGuide,
  loadReviewed,
  reviewedKey,
  useGuideStoreVersion,
} from './store';
import { viewGuide, type Guide } from './validate';

/** Where a task's own review stands, as Create PR reads it. */
export type ReviewGate =
  /** No guide written for the task. */
  | { kind: 'no-guide' }
  /** A guide, and the branch not read yet this run: the counts are the guide's own. */
  | { kind: 'checking'; reviewed: number; total: number }
  /** The branch moved on since the guide was written: it has to be rewritten. Null: not counted. */
  | { kind: 'stale'; commitsSince: number | null }
  /** Written for the branch as it is, and groups still to review. */
  | { kind: 'reviewing'; reviewed: number; total: number }
  /** Every counted group Reviewed, for the branch as it is: Create PR. */
  | { kind: 'ready'; total: number };

/** Create PR is offered. */
export function gatePasses(gate: ReviewGate | null): boolean {
  return gate?.kind === 'ready';
}

/** The words beside Review Changes: "4 of 6", "out of date", "no guide". */
export function gateProgressText(gate: ReviewGate): string {
  switch (gate.kind) {
    case 'no-guide':
      return 'no guide';
    case 'stale':
      return 'out of date';
    case 'checking':
    case 'reviewing':
      return `${gate.reviewed} of ${gate.total}`;
    case 'ready':
      return `${gate.total} of ${gate.total}`;
  }
}

/** Why Create PR waits, in a sentence, for a tooltip or a confirmation. */
export function gateReason(gate: ReviewGate): string {
  switch (gate.kind) {
    case 'no-guide':
      return 'No Review Guide has been written for this branch yet.';
    case 'stale':
      return gate.commitsSince && gate.commitsSince > 0
        ? `The Review Guide is out of date: ${commitsText(gate.commitsSince)} since it was written.`
        : 'The Review Guide is out of date: the branch changed since it was written.';
    case 'checking':
      return 'The branch has not been read as it is now yet (it is read once Claude’s turn ends).';
    case 'reviewing': {
      const left = gate.total - gate.reviewed;
      return `${left} of ${gate.total} ${gate.total === 1 ? 'group is' : 'groups are'} not marked Reviewed yet.`;
    }
    case 'ready':
      return 'Every group is Reviewed.';
  }
}

export function commitsText(n: number): string {
  return n === 1 ? '1 commit' : `${n} commits`;
}

/**
 * The pane's own count (GuidePane's "N of M reviewed"), from the guide and the
 * branch as read: every group but Set Aside, a group Reviewed when every one
 * of its files' blocks in it is marked. Pure.
 */
export function reviewCount(
  guide: Guide,
  diff: BranchDiff,
  reviewed: ReadonlySet<string>,
): { reviewed: number; total: number } {
  const led = viewGuide(guide, diff).groups.filter((g) => !g.setAside);
  const done = led.filter((g) => g.files.length > 0 && g.files.every((f) => reviewed.has(reviewedKey(f.path, f.blocks))));
  return { reviewed: done.length, total: led.length };
}

/**
 * The gate from what is known. `read` is the last read of the branch, when it
 * is still kept; `hash` the last read's hash, kept longer; `fallback` the
 * guide's own count (store.guideProgress) for when the read is gone. Pure.
 */
export function gateFrom(
  guide: Guide | null,
  read: Pick<LoadedBranchDiff, 'diff'> | null,
  hash: string | null,
  reviewed: ReadonlySet<string>,
  fallback: { reviewed: number; total: number } | null,
  commitsSince: number | null,
): ReviewGate {
  if (!guide) return { kind: 'no-guide' };
  const current = read ? read.diff.hash : hash;
  if (current !== null && current !== guide.diffHash) return { kind: 'stale', commitsSince };
  const counts = read ? reviewCount(guide, read.diff, reviewed) : (fallback ?? { reviewed: 0, total: 0 });
  if (current === null) return { kind: 'checking', ...counts };
  if (counts.reviewed >= counts.total) return { kind: 'ready', total: counts.total };
  return { kind: 'reviewing', ...counts };
}

// ---------------------------------------------------------------------------
// The store: reads of the branch, and commits since a guide
// ---------------------------------------------------------------------------

/** Reads of one task's branch are this far apart at least. */
export const READ_MIN_MS = 2_000;

export type GateTask = Pick<
  Task,
  'id' | 'kind' | 'status' | 'repoPath' | 'worktreePath' | 'branch' | 'baseBranch' | 'reviewUrl' | 'lastActivityAt'
>;

type Reader = (task: GateTask, base: string) => Promise<LoadedBranchDiff>;
const defaultReader: Reader = (task, base) =>
  loadBranchDiff(task.worktreePath, base, (rel) => readWorkingFile(task.worktreePath, rel));
let reader: Reader = defaultReader;

type Counter = (worktreePath: string, from: string) => Promise<number | null>;
const defaultCounter: Counter = async (worktreePath, from) => {
  try {
    const r = await git(['rev-list', '--count', `${from}..HEAD`], worktreePath);
    const n = r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};
let counter: Counter = defaultCounter;

const reading = new Map<number, Promise<LoadedBranchDiff | null>>();
const readAt = new Map<number, number>();
/** `${taskId}:${guide.head}:${hash}` -> commits since, null when git could not say. */
const since = new Map<string, number | null>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * A task Create PR is about: your own work on a branch that can have a PR. A
 * chat, a review task, and a task on its base branch itself or detached
 * (`prLookupBranch`) have none.
 */
export function gatedTask(task: Pick<Task, 'kind' | 'reviewUrl' | 'branch' | 'baseBranch'> | null): boolean {
  return !!task && task.kind !== 'chat' && !task.reviewUrl && prLookupBranch(task) !== null;
}

/**
 * Read the branch now and keep the read (store.keepLastRead), as the pane
 * would. One read per task at a time; a failure is logged and reads as
 * "not known". Never throws.
 */
export function readBranchForGate(task: GateTask, base: string): Promise<LoadedBranchDiff | null> {
  const running = reading.get(task.id);
  if (running) return running;
  readAt.set(task.id, Date.now());
  const p = reader(task, base)
    .then((data) => {
      keepLastRead(task.id, data);
      return data;
    })
    .catch((err: unknown) => {
      console.warn('[review-gate] could not read the branch', task.id, err instanceof Error ? err.message : String(err));
      return null;
    })
    .finally(() => {
      reading.delete(task.id);
      emit();
    });
  reading.set(task.id, p);
  return p;
}

function sinceKey(taskId: number, guide: Guide, hash: string): string {
  return `${taskId}:${guide.head ?? ''}:${hash}`;
}

/** The guide's head when it is a commit id: anything else stored is not passed to git. */
function headOf(guide: Guide): string | null {
  return typeof guide.head === 'string' && /^[0-9a-f]{40,64}$/.test(guide.head) ? guide.head : null;
}

/** Count the commits since the guide's head, once per guide and branch state. */
function countSince(task: GateTask, guide: Guide, hash: string): void {
  const key = sinceKey(task.id, guide, hash);
  const head = headOf(guide);
  if (since.has(key) || head === null) return;
  since.set(key, null);
  void counter(task.worktreePath, head).then((n) => {
    since.set(key, n);
    emit();
  });
}

/** The gate for a task now, from the stores. Not for a chat or a review task. */
export function currentGate(taskId: number): ReviewGate {
  const guide = loadGuide(taskId);
  if (!guide) return { kind: 'no-guide' };
  const read = lastReadOf(taskId);
  const hash = read ? read.diff.hash : lastHashOf(taskId);
  const commits = hash !== null ? (since.get(sinceKey(taskId, guide, hash)) ?? null) : null;
  return gateFrom(
    guide,
    read,
    hash,
    loadReviewed(taskId),
    read ? null : (guideProgress([taskId]).get(taskId) ?? null),
    commits,
  );
}

/**
 * The gate for a task with the branch read now, for a decision made away
 * from the screen (draftReady.ts): never from a read kept from before.
 */
export async function freshGate(task: GateTask): Promise<ReviewGate> {
  if (!loadGuide(task.id)) return { kind: 'no-guide' };
  const base = measuredBase(task, getPrStatus(task.id) ?? null);
  const data = await readBranchForGate(task, base);
  if (!data) return currentGate(task.id);
  const guide = loadGuide(task.id);
  const head = guide ? headOf(guide) : null;
  if (guide && head !== null && data.diff.hash !== guide.diffHash) {
    const n = await counter(task.worktreePath, head);
    since.set(sinceKey(task.id, guide, data.diff.hash), n);
  }
  return currentGate(task.id);
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

let forTests: ((taskId: number) => ReviewGate | null) | null = null;

/** Test seam: what the gate says, bypassing the stores; null restores them. */
export function setReviewGateForTests(fn: ((taskId: number) => ReviewGate | null) | null): void {
  forTests = fn;
  emit();
}

/** Test seam: the branch read and the commit count; no argument restores git. */
export function setGateReaderForTests(next?: Reader, count?: Counter): void {
  reader = next ?? defaultReader;
  counter = count ?? defaultCounter;
  reading.clear();
  readAt.clear();
  readFor.clear();
  since.clear();
}

const cache = new Map<number, { at: string; gate: ReviewGate }>();

function gateNow(taskId: number): ReviewGate {
  if (forTests) return forTests(taskId) ?? { kind: 'no-guide' };
  // Recomputed only when a guide, a mark, a read or a count changed.
  const at = `${guideStoreVersion()}:${version}`;
  const hit = cache.get(taskId);
  if (hit && hit.at === at) return hit.gate;
  const gate = currentGate(taskId);
  cache.set(taskId, { at, gate });
  return gate;
}

/** Bumped when the window regains focus, while anything listens. */
let focusVersion = 0;
const focusListeners = new Set<() => void>();
function onWindowFocus(): void {
  focusVersion++;
  for (const l of [...focusListeners]) l();
}
function subscribeFocus(cb: () => void): () => void {
  if (focusListeners.size === 0) window.addEventListener('focus', onWindowFocus);
  focusListeners.add(cb);
  return () => {
    focusListeners.delete(cb);
    if (focusListeners.size === 0) window.removeEventListener('focus', onWindowFocus);
  };
}

/** The branch state a read was for, per task: two readers on screen read it once. */
const readFor = new Map<number, string>();

/**
 * The gate for a task on screen, kept current. Unless `passive`, the branch is
 * read when the task, its base, its last activity or its guide change -- once,
 * however many readers are on screen -- and again when `refresh` changes (a
 * commit or a save the Files pane saw); at most every {@link READ_MIN_MS},
 * and never while a turn runs. Null for no task, a chat or a review task.
 */
export function useReviewGate(
  task: GateTask | null,
  opts: { refresh?: unknown; passive?: boolean } = {},
): ReviewGate | null {
  useGuideStoreVersion();
  useSyncExternalStore(subscribe, () => version);
  const gated = gatedTask(task);
  const base = useMeasuredBase(gated ? task : null).base;
  const guide = gated && task ? loadGuide(task.id) : null;
  const running = task?.status === 'running';
  const core =
    gated && task && guide && !forTests && !running && !opts.passive
      ? `${task.id}\n${task.worktreePath}\n${base}\n${task.lastActivityAt ?? ''}\n${guide.writtenAt}`
      : '';
  // Back to the window: commits made outside Albedo are read too (#464 review).
  const focused = useSyncExternalStore(subscribeFocus, () => focusVersion);
  // Not yet known (a count still on its way) is not a change: only a known
  // value replaced by another is, so a reader's first count is not a second read.
  const given = opts.refresh === undefined || opts.refresh === null ? null : String(opts.refresh);
  const refresh = `${given ?? ''}\n${focused}`;
  const taskRef = useRef(task);
  taskRef.current = task;
  const seen = useRef<{ core: string; given: string | null; focused: number }>({ core: '', given: null, focused });
  useEffect(() => {
    const t = taskRef.current;
    const was = seen.current;
    seen.current = { core, given: given ?? was.given, focused };
    if (core === '' || !t) return;
    // A new state of the branch is read once, by whichever reader gets to it
    // first; a refresh only by the reader it changed for.
    const refreshed =
      was.core === core && (was.focused !== focused || (was.given !== null && given !== null && was.given !== given));
    if (was.core === core && !refreshed) return;
    const go = () => {
      const now = taskRef.current;
      if (!now || (!refreshed && readFor.get(now.id) === core)) return;
      readFor.set(now.id, core);
      void readBranchForGate(now, base);
    };
    const wait = (readAt.get(t.id) ?? 0) + READ_MIN_MS - Date.now();
    if (wait <= 0) {
      go();
      return;
    }
    // A change inside the window is read when it closes, so the last one is.
    const timer = window.setTimeout(go, wait);
    return () => window.clearTimeout(timer);
    // `core` carries the task, its folder, base, activity and guide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, refresh]);

  const now = gated && task ? gateNow(task.id) : null;
  // While a turn runs the branch is not read, so the last read may be behind
  // it: never Create PR then (#464 review). It comes back when the turn ends.
  const gate: ReviewGate | null =
    now?.kind === 'ready' && running ? { kind: 'checking', reviewed: now.total, total: now.total } : now;
  // Out of date: how many commits since (the banner's and the button's words).
  const hash = gated && task ? lastHashOf(task.id) : null;
  useEffect(() => {
    const t = taskRef.current;
    if (!t || !guide || hash === null || hash === guide.diffHash || forTests) return;
    countSince(t, guide, hash);
  }, [task?.id, guide?.writtenAt, guide?.head, hash]);
  return gate;
}

/** The gate for any task, cached until a guide, a mark, a read or a count changes. */
export function gateOf(taskId: number): ReviewGate {
  return gateNow(taskId);
}

/** Bumped when a read or a count lands, for a list that shows many tasks' gates. */
export function useGateVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/**
 * The words on a My Review row (#464): what is left before the PR. A draft
 * is past Create PR and waits on its checks.
 */
export function gateRowText(gate: ReviewGate, prState: string | null | undefined): string {
  if (prState === 'draft') return 'draft PR';
  switch (gate.kind) {
    case 'no-guide':
      return 'no guide yet';
    case 'stale':
      return 'guide out of date';
    case 'checking':
    case 'reviewing':
      return `${gate.reviewed} of ${gate.total} reviewed`;
    case 'ready':
      return 'reviewed · Create PR';
  }
}

/** One list read at a time: a launch with several guides is not a burst of reads. */
let listChain: Promise<unknown> = Promise.resolve();
const listAsked = new Set<string>();

/**
 * Read the branch of each of these tasks once per finish and guide (#464), so
 * a My Review row can say "guide out of date" without its task being opened.
 * Only tasks with a guide, at rest; one at a time.
 */
export function useGateReads(tasks: GateTask[]): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  const wanted = tasks.flatMap((t) => {
    if (!gatedTask(t) || t.status !== 'idle' || forTests) return [];
    const guide = loadGuide(t.id);
    return guide ? [`${t.id}:${t.lastActivityAt ?? ''}:${guide.writtenAt}`] : [];
  });
  const key = wanted.join(',');
  useEffect(() => {
    for (const t of ref.current) {
      const guide = gatedTask(t) && t.status === 'idle' ? loadGuide(t.id) : null;
      if (!guide) continue;
      const k = `${t.id}:${t.lastActivityAt ?? ''}:${guide.writtenAt}`;
      if (listAsked.has(k)) continue;
      listAsked.add(k);
      const task = t;
      listChain = listChain.then(() => {
        // Already read for this state by a reader on screen: nothing to add.
        if (lastHashOf(task.id) !== null && (readAt.get(task.id) ?? 0) >= (task.lastActivityAt ?? 0)) return;
        return readBranchForGate(task, measuredBase(task, getPrStatus(task.id) ?? null));
      });
    }
  }, [key]);
}

/** Tests only. */
export function resetGateForTests(): void {
  forTests = null;
  cache.clear();
  listAsked.clear();
  listChain = Promise.resolve();
  setGateReaderForTests();
  emit();
}
