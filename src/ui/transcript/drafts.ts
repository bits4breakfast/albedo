/**
 * The composer's unsent drafts, one per task.
 *
 * The composer is one box shared by every task, so switching task used to
 * throw the draft away. Here each task keeps its own: the text, the large
 * pastes its placeholders stand for (see pastedText.ts), and with the text
 * the attached paths, which go into the box as typed paths.
 *
 * Memory is the store; localStorage is its copy, written a moment after the
 * last change, so a draft outlives a restart or a crash. When storage is
 * unavailable drafts still survive a task switch, just not a restart.
 *
 * A draft leaves when it is sent, when its task is archived or deleted, or
 * once it is a week old. A send under way is never a draft: restoring it
 * could send it twice. Leaving a task whose send is held or waiting cancels
 * that send first, and only then keeps its text (`keepUnsent`).
 */

import { useSyncExternalStore } from 'react';
import { KEYS, readPersisted, writePersisted } from '../persisted';
import type { Codec } from '../persisted';
import { pastesIn } from './pastedText';
import { mentionsIn, type Mention, type MentionStore } from './mentions';

export interface Draft {
  text: string;
  /** Placeholder id -> the pasted text it stands for. */
  pastes: ReadonlyArray<readonly [number, string]>;
  savedAt: number;
  /**
   * Token -> the task or file it stands for (#154, mentions.ts). Absent when
   * the draft has none, and in drafts saved before references existed.
   */
  mentions?: ReadonlyArray<readonly [string, Mention]>;
  /**
   * A send that was held or waiting for a session when its task was left. The
   * hold is cancelled and the text kept here, so it says "not sent" on return.
   */
  notSent?: boolean;
}

export type DraftMap = ReadonlyMap<number, Draft>;

export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long after the last change the copy in storage is written. */
export const DRAFT_WRITE_DELAY_MS = 400;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.text === 'string' &&
    typeof d.savedAt === 'number' &&
    (d.notSent === undefined || typeof d.notSent === 'boolean') &&
    (d.mentions === undefined ||
      (Array.isArray(d.mentions) &&
        d.mentions.every(
          (m: unknown) =>
            Array.isArray(m) &&
            m.length === 2 &&
            typeof m[0] === 'string' &&
            typeof m[1] === 'object' &&
            m[1] !== null &&
            ((m[1] as { kind?: unknown }).kind === 'task' || (m[1] as { kind?: unknown }).kind === 'file'),
        ))) &&
    Array.isArray(d.pastes) &&
    d.pastes.every(
      (p: unknown) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string',
    )
  );
}

/**
 * A JSON object of task id -> draft. A malformed entry is dropped, not fatal;
 * no drafts at all removes the key.
 */
export const draftsCodec: Codec<DraftMap> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const map = new Map<number, Draft>();
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (Number.isInteger(id) && isDraft(value)) map.set(id, value);
    }
    return map;
  },
  encode: (drafts) => (drafts.size === 0 ? null : JSON.stringify(Object.fromEntries(drafts))),
};

/** The drafts younger than a week at `now`; the same map when none is older. */
export function withoutExpired(drafts: DraftMap, now: number): DraftMap {
  const kept = [...drafts].filter(([, d]) => now - d.savedAt < DRAFT_MAX_AGE_MS);
  return kept.length === drafts.size ? drafts : new Map(kept);
}

/** Whether a draft holds anything worth keeping. Whitespace alone is not a draft. */
export function isEmptyDraft(text: string): boolean {
  return text.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let drafts: DraftMap | null = null;
/** The ids with a draft, replaced only when that set changes (the task list's marker). */
let ids: ReadonlySet<number> = new Set();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function current(): DraftMap {
  if (drafts === null) {
    drafts = withoutExpired(readPersisted(KEYS.composerDrafts, draftsCodec, new Map()), Date.now());
    ids = new Set(drafts.keys());
    // A quit inside the write delay would otherwise lose the last keystrokes.
    if (typeof window !== 'undefined') window.addEventListener('pagehide', flushDrafts);
  }
  return drafts;
}

function commit(next: DraftMap): void {
  if (next === drafts) return;
  drafts = next;
  if (writeTimer === null) writeTimer = setTimeout(flushDrafts, DRAFT_WRITE_DELAY_MS);
  const sameIds = next.size === ids.size && [...next.keys()].every((id) => ids.has(id));
  if (sameIds) return;
  ids = new Set(next.keys());
  for (const cb of [...listeners]) cb();
}

/** Write the copy in storage now rather than after the delay. */
export function flushDrafts(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = null;
  if (drafts !== null) writePersisted(KEYS.composerDrafts, draftsCodec, drafts);
}

/** The task's draft, or null when it has none or it is older than a week. */
export function getDraft(taskId: number, now = Date.now()): Draft | null {
  const d = current().get(taskId);
  if (!d) return null;
  if (now - d.savedAt >= DRAFT_MAX_AGE_MS) {
    dropDraft(taskId);
    return null;
  }
  return d;
}

/**
 * Keep the task's draft. Empty text removes it instead. A "not sent" mark
 * stays only while the text is still exactly what was not sent. Only the
 * pastes whose tokens are still intact in the text are kept (`pastesIn`): a
 * paste whose token was deleted or edited is gone with it.
 */
export function saveDraft(
  taskId: number,
  text: string,
  pastes: ReadonlyMap<number, string>,
  now = Date.now(),
  mentions: MentionStore = new Map(),
): void {
  if (isEmptyDraft(text)) {
    dropDraft(taskId);
    return;
  }
  const prev = current().get(taskId);
  put(taskId, {
    text,
    pastes: [...pastesIn(text, pastes)],
    ...usedMentions(text, mentions),
    savedAt: now,
    ...(prev?.notSent && prev.text === text ? { notSent: true } : {}),
  });
}

/** The references whose tokens are still intact, as a draft keeps them; nothing when none. */
function usedMentions(text: string, mentions: MentionStore): Pick<Draft, 'mentions'> {
  const used = mentionsIn(text, mentions);
  return used.size > 0 ? { mentions: [...used] } : {};
}

/**
 * Keep the text of a send that was cancelled because its task was left. The
 * caller must have cancelled the send first: text is never both pending and a draft.
 */
export function keepUnsent(
  taskId: number,
  text: string,
  pastes: ReadonlyMap<number, string>,
  now = Date.now(),
  mentions: MentionStore = new Map(),
): void {
  if (isEmptyDraft(text)) return;
  put(taskId, { text, pastes: [...pastesIn(text, pastes)], ...usedMentions(text, mentions), savedAt: now, notSent: true });
}

function put(taskId: number, draft: Draft): void {
  const next = new Map(current());
  next.set(taskId, draft);
  commit(next);
}

export function dropDraft(taskId: number): void {
  const prev = current();
  if (!prev.has(taskId)) return;
  const next = new Map(prev);
  next.delete(taskId);
  commit(next);
}

/**
 * Keep only the drafts of these tasks -- the live ones, from a fresh read of
 * the database -- and none older than a week. An archived or deleted task's
 * draft goes here.
 */
export function keepDraftsFor(taskIds: Iterable<number>, now = Date.now()): void {
  const live = new Set(taskIds);
  const prev = current();
  const kept = [...withoutExpired(prev, now)].filter(([id]) => live.has(id));
  commit(kept.length === prev.size ? prev : new Map(kept));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function draftIds(): ReadonlySet<number> {
  current();
  return ids;
}

/** The ids of the tasks with an unsent draft. Re-renders only when that set changes. */
export function useDraftTaskIds(): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, draftIds, draftIds);
}

/** Test seam: forget everything in memory, so the next read comes from storage. */
export function __resetDrafts(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = null;
  drafts = null;
  ids = new Set();
  listeners.clear();
}
