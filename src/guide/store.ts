/**
 * What the Review Guide remembers (#186), all of it in localStorage
 * (persisted.ts): no table, no contract change.
 *
 *  - **The guide**, one per task, kept with the hash of the diff it was
 *    written for. Reopening costs nothing; a diff that moved on shows the
 *    guide with a "changed since" banner rather than throwing it away. At most
 *    {@link MAX_GUIDES}, the oldest written going first, so the store stays
 *    bounded without having to know which tasks still exist.
 *  - **Reviewed**, per task, as keys of "this file's blocks in this group"
 *    (`reviewedKey`). The key is made of the block ids, which follow the
 *    content, so a file changed after it was ticked is simply not ticked any
 *    more: Reviewed is kept per task AND per diff. A task's marks go once its
 *    guide has (`setReviewed` prunes them), so this stays bounded too.
 *    When something was last ticked is kept beside them (#315), pruned with
 *    them: the Reviewing tab's Review Started compares it with your last
 *    submitted review.
 *  - **A write in progress**, in memory only: which task it is for, and how
 *    far it got. It belongs to the task that started it -- the result is
 *    saved for that task whatever is on screen when it lands.
 *  - **Notes being written** (#224), in memory only: once the groups are
 *    saved, the notes are asked for a group at a time, the group in view
 *    first, and each lands in the saved guide as it comes. A queue belongs to
 *    one guide (its `writtenAt`): a rewrite replaces it, and a late answer for
 *    the old guide is dropped. A restart loses it; opening the guide again
 *    queues whatever groups still have no notes.
 */

import { useSyncExternalStore } from 'react';
import { KEYS, writePersisted, type Codec } from '../ui/persisted';
import type { Guide } from './validate';
import type { BranchDiff } from './blocks';
import type { LoadedBranchDiff } from './branchDiff';
import { GuideError, writeGuide, writeNotes, type GroupNotes, type GuideErrorKind, type Progress } from './writer';
import { notableFiles } from './validate';
import { asFocus, isSetAside, type GuideFocus } from './focus';

export const MAX_GUIDES = 40;
/** Per task; a branch with more reviewed file-groups than this is not a review. */
export const MAX_REVIEWED = 2000;

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

function isGuide(v: unknown): v is Guide {
  if (typeof v !== 'object' || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.diffHash === 'string' &&
    typeof g.writtenAt === 'number' &&
    typeof g.base === 'string' &&
    (g.fallback === null || typeof g.fallback === 'string') &&
    typeof g.files === 'object' &&
    g.files !== null &&
    Array.isArray(g.groups) &&
    g.groups.every(
      (x: unknown) =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { title?: unknown }).title === 'string' &&
        typeof (x as { summary?: unknown }).summary === 'string' &&
        Array.isArray((x as { blocks?: unknown }).blocks),
    )
  );
}

/** task id -> guide. A malformed entry is dropped, not fatal. */
export const guidesCodec: Codec<Record<string, Guide>> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: Record<string, Guide> = {};
    for (const [k, v] of Object.entries(parsed)) if (isGuide(v)) out[k] = v;
    return out;
  },
  encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
};

/** task id -> reviewed keys. */
export const reviewedCodec: Codec<Record<string, string[]>> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    }
    return out;
  },
  encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
};

/** task id -> when something was last marked Reviewed (#315). */
export const reviewedAtCodec: Codec<Record<string, number>> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  },
  encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
};

// ---------------------------------------------------------------------------
// Reading storage, decoded once per stored string (#365)
// ---------------------------------------------------------------------------

/**
 * The last string read per key and what it decoded to. The task list asks
 * for every guide on each activity change and the pane on each render; up to
 * 40 guides are a lot of JSON to parse and check every time. Keyed on the
 * stored string itself, so whatever writes the key -- this store, another
 * window, a test -- is read afresh the next time, with no event to miss.
 *
 * The values are shared between callers: nothing here or in a reader may
 * change one in place (every write builds a new object, as it always has).
 */
const decoded = new Map<string, { raw: string; value: unknown }>();

/** `readPersisted` with an empty record as the fallback, decoded once per stored string. */
function readStored<T extends object>(key: string, codec: Codec<T>): T {
  const empty = {} as T;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return empty;
  }
  if (raw === null) return empty;
  const hit = decoded.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T | null;
  try {
    value = codec.decode(raw);
  } catch {
    value = null;
  }
  const out = value ?? empty;
  decoded.set(key, { raw, value: out });
  return out;
}

// ---------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;
/**
 * Bumped only when a guide or a Reviewed mark is written (#315): what
 * {@link guideProgress} reads. A write's progress or a focus draft changes
 * `version` alone, so the Reviewing tab does not read storage again for them.
 */
let reviewedVersion = 0;
function changed(): void {
  version++;
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function loadGuide(taskId: number): Guide | null {
  return readStored(KEYS.reviewGuides, guidesCodec)[String(taskId)] ?? null;
}

/** Keep the newest {@link MAX_GUIDES}. Pure. */
export function capGuides(all: Record<string, Guide>, max = MAX_GUIDES): Record<string, Guide> {
  const entries = Object.entries(all).sort((a, b) => b[1].writtenAt - a[1].writtenAt);
  return Object.fromEntries(entries.slice(0, max));
}

export function saveGuide(taskId: number, guide: Guide): void {
  const all = readStored(KEYS.reviewGuides, guidesCodec);
  writePersisted(KEYS.reviewGuides, guidesCodec, capGuides({ ...all, [String(taskId)]: guide }));
  reviewedVersion++;
  changed();
}

// ---------------------------------------------------------------------------
// Reviewed
// ---------------------------------------------------------------------------

/** "This file's blocks in this group": changes when any of them does. */
export function reviewedKey(path: string, blocks: readonly string[]): string {
  return `${path}#${blocks.join(',')}`;
}

export function loadReviewed(taskId: number): ReadonlySet<string> {
  return new Set(readStored(KEYS.reviewGuideReviewed, reviewedCodec)[String(taskId)] ?? []);
}

/**
 * The tasks being reviewed (#219): a guide, and at least one Reviewed mark
 * that still names blocks in it. A mark is `path#id,id` (reviewedKey); once
 * the blocks it names are gone from the guide (a rewrite after the branch
 * moved), it no longer counts. Two reads of storage, whatever the task count.
 */
export function reviewingTaskIds(): ReadonlySet<number> {
  const guides = readStored(KEYS.reviewGuides, guidesCodec);
  const marks = readStored(KEYS.reviewGuideReviewed, reviewedCodec);
  const out = new Set<number>();
  for (const [id, keys] of Object.entries(marks)) {
    const guide = guides[id];
    if (guide && marksCurrent(guide, keys)) out.add(Number(id));
  }
  return out;
}

/** Whether any of a task's marks still names blocks in its guide (#219). Pure. */
function marksCurrent(guide: Guide, keys: readonly string[]): boolean {
  return keys.some((k) => {
    const at = k.lastIndexOf('#');
    const known = at > 0 ? guide.files[k.slice(0, at)] : undefined;
    const blocks = at > 0 ? k.slice(at + 1).split(',').filter(Boolean) : [];
    return known !== undefined && blocks.length > 0 && blocks.every((b) => known.includes(b));
  });
}

export function setReviewed(taskId: number, keys: readonly string[], on: boolean): void {
  const all = readStored(KEYS.reviewGuideReviewed, reviewedCodec);
  const mine = new Set(all[String(taskId)] ?? []);
  for (const k of keys) {
    if (on) mine.add(k);
    else mine.delete(k);
  }
  const list = [...mine].slice(-MAX_REVIEWED);
  // Bounded like the guides: marks are kept only for tasks that still have a
  // guide, so a task whose guide aged out (or was deleted) takes its own along.
  const guides = readStored(KEYS.reviewGuides, guidesCodec);
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(all)) if (k in guides) next[k] = v;
  if (list.length === 0) delete next[String(taskId)];
  else next[String(taskId)] = list;
  writePersisted(KEYS.reviewGuideReviewed, reviewedCodec, next);
  // When, for Review Started (#315): a tick, never an untick. Kept for the
  // tasks whose marks are kept.
  const times = readStored(KEYS.reviewGuideReviewedAt, reviewedAtCodec);
  const keptTimes: Record<string, number> = {};
  for (const [k, v] of Object.entries(times)) if (k in next) keptTimes[k] = v;
  if (on && keys.length > 0 && String(taskId) in next) keptTimes[String(taskId)] = Date.now();
  writePersisted(KEYS.reviewGuideReviewedAt, reviewedAtCodec, keptTimes);
  reviewedVersion++;
  changed();
}

/** A task's Guide as the Reviewing tab tells it (#315). */
export interface GuideProgress {
  /** Something is marked Reviewed that still names blocks in the guide. */
  reviewing: boolean;
  /** When something was last ticked; null when unknown (ticked before #315). */
  tickedAt: number | null;
  /** The guide's groups all Reviewed, of how many. */
  reviewed: number;
  total: number;
}

/**
 * Each task's guide progress, for the tasks given that have a guide. Read
 * from the guide alone, without the diff: the guide's groups, plus Unsorted
 * when it left blocks out, never Set Aside -- what the pane counts as "N of M
 * reviewed" while the branch is where the guide was written. A group is
 * Reviewed when every one of its blocks is in a Reviewed mark. Each key is
 * read once, whatever the task count; callers re-read only on
 * {@link useGuideReviewedVersion}.
 */
export function guideProgress(taskIds: readonly number[]): ReadonlyMap<number, GuideProgress> {
  const guides = readStored(KEYS.reviewGuides, guidesCodec);
  const marks = readStored(KEYS.reviewGuideReviewed, reviewedCodec);
  const times = readStored(KEYS.reviewGuideReviewedAt, reviewedAtCodec);
  const out = new Map<number, GuideProgress>();
  for (const id of taskIds) {
    const guide = guides[String(id)];
    if (!guide) continue;
    const mine = marks[String(id)] ?? [];
    const ticked = new Set<string>();
    for (const k of mine) {
      const at = k.lastIndexOf('#');
      if (at > 0) for (const b of k.slice(at + 1).split(',')) if (b) ticked.add(b);
    }
    const sets: string[][] = guide.groups.map((g) => g.blocks).filter((b) => b.length > 0);
    const placed = new Set(sets.flat());
    const focus = asFocus(guide.focus);
    const rest = Object.entries(guide.files).flatMap(([path, ids]) =>
      focus && isSetAside(focus, path) ? [] : ids.filter((b) => !placed.has(b)),
    );
    if (rest.length > 0) sets.push(rest);
    out.set(id, {
      reviewing: marksCurrent(guide, mine),
      tickedAt: times[String(id)] ?? null,
      reviewed: sets.filter((b) => b.every((x) => ticked.has(x))).length,
      total: sets.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes in progress
// ---------------------------------------------------------------------------

export type WriteState =
  | { kind: 'writing'; progress: Progress | null }
  | { kind: 'error'; error: GuideErrorKind; message: string };

const writes = new Map<number, WriteState>();

export function writeStateOf(taskId: number): WriteState | null {
  return writes.get(taskId) ?? null;
}

/**
 * Write a guide for `taskId`'s diff, setting aside and marking by `focus`
 * (#295). A second request while one runs is ignored. The result is saved
 * for the task that asked, whatever is on screen.
 */
export async function startWrite(taskId: number, diff: BranchDiff, base: string, focus?: GuideFocus): Promise<void> {
  if (writes.get(taskId)?.kind === 'writing') return;
  writes.set(taskId, { kind: 'writing', progress: null });
  changed();
  try {
    const guide = await writeGuide(diff, {
      base,
      focus,
      onProgress: (p) => {
        writes.set(taskId, { kind: 'writing', progress: p });
        changed();
      },
    });
    saveGuide(taskId, guide);
    writes.delete(taskId);
    // The lists as typed are done with only now (#295 review): a failed write
    // keeps them, so Try Again writes with what was typed, never the defaults.
    focusDrafts.delete(taskId);
    // The guide is on screen from here; its notes follow (#224).
    ensureNotes(taskId, guide, diff);
  } catch (err) {
    const e = err instanceof GuideError ? err : new GuideError('failed', err instanceof Error ? err.message : String(err));
    console.warn('[guide] write failed', e.kind, e.message);
    writes.set(taskId, { kind: 'error', error: e.kind, message: e.message });
  }
  changed();
}

export function clearWriteError(taskId: number): void {
  if (writes.get(taskId)?.kind !== 'error') return;
  writes.delete(taskId);
  changed();
}

// ---------------------------------------------------------------------------
// Notes, a group at a time (#224)
// ---------------------------------------------------------------------------

interface NotesJob {
  writtenAt: number;
  diff: BranchDiff;
  /** Indexes into `guide.groups` still to ask about, the next first. */
  queue: number[];
  running: number | null;
  failed: Set<number>;
}

const notesJobs = new Map<number, NotesJob>();

/** Groups with no notes yet (never asked) that have a file the rule allows one, in reading order. */
function groupsToNote(guide: Guide, diff: BranchDiff): number[] {
  const out: number[] = [];
  guide.groups.forEach((g, i) => {
    if (g.notes === undefined && notableFiles(g.blocks, diff).length > 0) out.push(i);
  });
  return out;
}

/**
 * Queue the notes of `guide`'s groups that have none yet, and start writing
 * them, one call at a time. `first` (a group's index) goes to the front. Only
 * for the diff the guide was written for: an out-of-date guide gets no new
 * notes, and a rewrite will bring its own.
 */
export function ensureNotes(taskId: number, guide: Guide, diff: BranchDiff, first?: number): void {
  if (diff.hash !== guide.diffHash) return;
  let job = notesJobs.get(taskId);
  if (!job || job.writtenAt !== guide.writtenAt) {
    const queue = groupsToNote(guide, diff);
    if (queue.length === 0) {
      if (job) notesJobs.delete(taskId);
      return;
    }
    job = { writtenAt: guide.writtenAt, diff, queue, running: null, failed: new Set() };
    notesJobs.set(taskId, job);
    changed();
  }
  if (first !== undefined) focusNotes(taskId, guide.writtenAt, first);
  void pump(taskId, job);
}

/** The group now in view is asked about next (#224). */
export function focusNotes(taskId: number, writtenAt: number, index: number): void {
  const job = notesJobs.get(taskId);
  if (!job || job.writtenAt !== writtenAt) return;
  const at = job.queue.indexOf(index);
  if (at > 0) {
    job.queue.splice(at, 1);
    job.queue.unshift(index);
  }
}

export type NotesState = 'pending' | 'failed';

/** Whether a group's notes are still coming, or could not be written. */
export function notesStateOf(taskId: number, writtenAt: number, index: number): NotesState | null {
  const job = notesJobs.get(taskId);
  if (!job || job.writtenAt !== writtenAt) return null;
  if (job.failed.has(index)) return 'failed';
  return job.running === index || job.queue.includes(index) ? 'pending' : null;
}

/** Ask again for a group whose notes failed, ahead of the rest. */
export function retryNotes(taskId: number, writtenAt: number, index: number): void {
  const job = notesJobs.get(taskId);
  if (!job || job.writtenAt !== writtenAt || !job.failed.delete(index)) return;
  job.queue.unshift(index);
  changed();
  void pump(taskId, job);
}

async function pump(taskId: number, job: NotesJob): Promise<void> {
  if (job.running !== null) return;
  const current = () => notesJobs.get(taskId) === job;
  while (current()) {
    const index = job.queue.shift();
    if (index === undefined) {
      // Done. Kept only while a failure waits for Retry (it needs the diff).
      if (job.failed.size === 0) notesJobs.delete(taskId);
      return;
    }
    const guide = loadGuide(taskId);
    const group = guide?.writtenAt === job.writtenAt ? guide.groups[index] : undefined;
    if (!guide || guide.writtenAt !== job.writtenAt) {
      notesJobs.delete(taskId);
      changed();
      return;
    }
    if (!group || group.notes !== undefined) continue;
    job.running = index;
    changed();
    let notes: GroupNotes | null = null;
    let ok = true;
    try {
      notes = await writeNotes(job.diff, group, { groupTitles: guide.groups.map((g) => g.title) });
    } catch (err) {
      ok = false;
      const e = err instanceof Error ? err.message : String(err);
      console.warn('[guide] notes failed', index, e);
    }
    job.running = null;
    if (!current()) return;
    // Saved into the guide as it is now, and only if it is still this one.
    const now = loadGuide(taskId);
    if (!now || now.writtenAt !== job.writtenAt) {
      notesJobs.delete(taskId);
      changed();
      return;
    }
    if (ok) {
      // `notes` alone marks the group as asked; `lines` is kept only when there are some (#264).
      const lines = notes && Object.keys(notes.lines).length > 0 ? { lines: notes.lines } : {};
      const groups = now.groups.map((g, i) => (i === index ? { ...g, notes: notes?.notes ?? {}, ...lines } : g));
      saveGuide(taskId, { ...now, groups });
    } else {
      job.failed.add(index);
      changed();
    }
  }
}

/** Re-renders only when a guide or a Reviewed mark is written (#315). */
export function useGuideReviewedVersion(): number {
  return useSyncExternalStore(subscribe, () => reviewedVersion);
}

/** Re-renders on any change to guides, Reviewed or a write. */
export function useGuideStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// ---------------------------------------------------------------------------
// The Write Guide screen's lists, as typed (#295)
// ---------------------------------------------------------------------------

/** The two lists as typed on the Write Guide screen, one pattern per line. */
export interface FocusDraft {
  setAside: string;
  careful: string;
}

/**
 * Per task, in memory: what was typed into the Write Guide screen's lists and
 * not yet written, kept, as the place is, while another task is on screen.
 * None means the project's defaults. A task with a guide AND a draft is in
 * Rewrite With Other Options…: the screen is shown over the guide, so it
 * survives the pane remounting on a task switch. Cleared when a write
 * succeeds (startWrite) or the screen is cancelled, never when one starts.
 */
const focusDrafts = new Map<number, FocusDraft>();

export function focusDraftOf(taskId: number): FocusDraft | null {
  return focusDrafts.get(taskId) ?? null;
}

export function setFocusDraft(taskId: number, draft: FocusDraft | null): void {
  if (draft === null) focusDrafts.delete(taskId);
  else focusDrafts.set(taskId, draft);
  changed();
}

// ---------------------------------------------------------------------------
// Where you are, and the last read of the branch (#199)
// ---------------------------------------------------------------------------

/**
 * Where a reader is in a task's guide: the group, by its key, and the file
 * picked in each group. Kept here, not in the pane, because the pane goes
 * whenever another task or the project view is selected. In memory only: a
 * restart, like a rewritten guide (another `writtenAt`), starts at the first
 * group not yet Reviewed.
 */
export interface GuidePlace {
  writtenAt: number;
  group: string | null;
  picked: Readonly<Record<string, string>>;
}

const places = new Map<number, GuidePlace>();

/** The place kept for this guide of the task, or null. */
export function placeOf(taskId: number, writtenAt: number): GuidePlace | null {
  const p = places.get(taskId);
  return p && p.writtenAt === writtenAt ? p : null;
}

export function keepPlace(taskId: number, place: GuidePlace): void {
  places.set(taskId, place);
}

/**
 * The branch as last read, shown at once when the pane comes back while it is
 * read again. In memory; never a guide's facts. A read holds both sides of
 * every changed file, so only the last few tasks' are kept: going back and
 * forth between a couple of tasks is what this is for.
 */
export const MAX_LAST_READS = 3;
const lastReads = new Map<number, LoadedBranchDiff>();

export function lastReadOf(taskId: number): LoadedBranchDiff | null {
  return lastReads.get(taskId) ?? null;
}

export function keepLastRead(taskId: number, data: LoadedBranchDiff): void {
  // Re-inserted, so the Map's order is least recently read first.
  lastReads.delete(taskId);
  lastReads.set(taskId, data);
  while (lastReads.size > MAX_LAST_READS) {
    const oldest = lastReads.keys().next().value as number;
    lastReads.delete(oldest);
  }
}

/** Tests only. */
export function resetGuideStoreForTests(): void {
  decoded.clear();
  places.clear();
  lastReads.clear();
  writes.clear();
  notesJobs.clear();
  focusDrafts.clear();
  changed();
}
