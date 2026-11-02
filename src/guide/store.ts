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
 *  - **A write in progress**, in memory only: which task it is for, and how
 *    far it got. It belongs to the task that started it -- the result is
 *    saved for that task whatever is on screen when it lands.
 */

import { useSyncExternalStore } from 'react';
import { KEYS, readPersisted, writePersisted, type Codec } from '../ui/persisted';
import type { Guide } from './validate';
import type { BranchDiff } from './blocks';
import type { LoadedBranchDiff } from './branchDiff';
import { GuideError, writeGuide, type GuideErrorKind, type Progress } from './writer';

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

// ---------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version++;
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function loadGuide(taskId: number): Guide | null {
  return readPersisted(KEYS.reviewGuides, guidesCodec, {} as Record<string, Guide>)[String(taskId)] ?? null;
}

/** Keep the newest {@link MAX_GUIDES}. Pure. */
export function capGuides(all: Record<string, Guide>, max = MAX_GUIDES): Record<string, Guide> {
  const entries = Object.entries(all).sort((a, b) => b[1].writtenAt - a[1].writtenAt);
  return Object.fromEntries(entries.slice(0, max));
}

export function saveGuide(taskId: number, guide: Guide): void {
  const all = readPersisted(KEYS.reviewGuides, guidesCodec, {} as Record<string, Guide>);
  writePersisted(KEYS.reviewGuides, guidesCodec, capGuides({ ...all, [String(taskId)]: guide }));
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
  return new Set(readPersisted(KEYS.reviewGuideReviewed, reviewedCodec, {} as Record<string, string[]>)[String(taskId)] ?? []);
}

/**
 * The tasks being reviewed (#219): a guide, and at least one Reviewed mark
 * that still names blocks in it. A mark is `path#id,id` (reviewedKey); once
 * the blocks it names are gone from the guide (a rewrite after the branch
 * moved), it no longer counts. Two reads of storage, whatever the task count.
 */
export function reviewingTaskIds(): ReadonlySet<number> {
  const guides = readPersisted(KEYS.reviewGuides, guidesCodec, {} as Record<string, Guide>);
  const marks = readPersisted(KEYS.reviewGuideReviewed, reviewedCodec, {} as Record<string, string[]>);
  const out = new Set<number>();
  for (const [id, keys] of Object.entries(marks)) {
    const guide = guides[id];
    if (!guide) continue;
    const current = keys.some((k) => {
      const at = k.lastIndexOf('#');
      const known = at > 0 ? guide.files[k.slice(0, at)] : undefined;
      const blocks = at > 0 ? k.slice(at + 1).split(',').filter(Boolean) : [];
      return known !== undefined && blocks.length > 0 && blocks.every((b) => known.includes(b));
    });
    if (current) out.add(Number(id));
  }
  return out;
}

export function setReviewed(taskId: number, keys: readonly string[], on: boolean): void {
  const all = readPersisted(KEYS.reviewGuideReviewed, reviewedCodec, {} as Record<string, string[]>);
  const mine = new Set(all[String(taskId)] ?? []);
  for (const k of keys) {
    if (on) mine.add(k);
    else mine.delete(k);
  }
  const list = [...mine].slice(-MAX_REVIEWED);
  // Bounded like the guides: marks are kept only for tasks that still have a
  // guide, so a task whose guide aged out (or was deleted) takes its own along.
  const guides = readPersisted(KEYS.reviewGuides, guidesCodec, {} as Record<string, Guide>);
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(all)) if (k in guides) next[k] = v;
  if (list.length === 0) delete next[String(taskId)];
  else next[String(taskId)] = list;
  writePersisted(KEYS.reviewGuideReviewed, reviewedCodec, next);
  changed();
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
 * Write a guide for `taskId`'s diff. A second request while one runs is
 * ignored. The result is saved for the task that asked, whatever is on screen.
 */
export async function startWrite(taskId: number, diff: BranchDiff, base: string): Promise<void> {
  if (writes.get(taskId)?.kind === 'writing') return;
  writes.set(taskId, { kind: 'writing', progress: null });
  changed();
  try {
    const guide = await writeGuide(diff, {
      base,
      onProgress: (p) => {
        writes.set(taskId, { kind: 'writing', progress: p });
        changed();
      },
    });
    saveGuide(taskId, guide);
    writes.delete(taskId);
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

/** Re-renders on any change to guides, Reviewed or a write. */
export function useGuideStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
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
  places.clear();
  lastReads.clear();
  writes.clear();
  changed();
}
