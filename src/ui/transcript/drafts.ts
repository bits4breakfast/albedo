/**
 * The composer's unsent drafts, one per task.
 *
 * The composer is one box shared by every task, so switching task used to
 * throw the draft away. Here each task keeps its own: the text, the large
 * pastes its placeholders stand for (see pastedText.ts), and with the text
 * the attached paths, which go into the box as typed paths. With them, the
 * comments on passages of the transcript waiting to go with the next message
 * (#187, transcriptQuotes.ts): a draft can be those alone, with an empty box.
 *
 * Memory is the store; localStorage is its copy, written a moment after the
 * last change, so a draft outlives a restart or a crash. When storage is
 * unavailable drafts still survive a task switch, just not a restart.
 *
 * A draft leaves when it is sent, when its task is archived or deleted, or
 * once it is a week old. A send under way is never a draft: restoring it
 * could send it twice. Leaving a task whose send is held or waiting cancels
 * that send first, and only then keeps its text (`keepUnsent`).
 *
 * Waiting comments are the exception to "under way": they stay until the
 * message carrying them is delivered or held in the outbox, and only then
 * leave, by id (`takeComments`). A send that fails, is cancelled or is lost
 * to a restart leaves them waiting, never gone; the window in which a crash
 * could send one twice is the moment of the write itself.
 */

import { useSyncExternalStore } from 'react';
import { KEYS, readPersisted, writePersisted } from '../persisted';
import type { Codec } from '../persisted';
import { pastesIn } from './pastedText';
import { mentionsIn, type Mention, type MentionStore } from './mentions';
import type { TranscriptComment } from './transcriptQuotes';

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
  /** Comments on passages of the transcript, waiting to be sent (#187). Absent when none. */
  comments?: readonly TranscriptComment[];
}

export type DraftMap = ReadonlyMap<number, Draft>;

export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long after the last change the copy in storage is written. */
export const DRAFT_WRITE_DELAY_MS = 400;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

function isComment(value: unknown): value is TranscriptComment {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.messageId === 'number' &&
    typeof c.quote === 'string' &&
    typeof c.code === 'boolean' &&
    (c.lang === undefined || typeof c.lang === 'string') &&
    typeof c.comment === 'string' &&
    typeof c.at === 'number' &&
    typeof c.offset === 'number' &&
    typeof c.addedAt === 'number'
  );
}

function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.text === 'string' &&
    (d.comments === undefined || (Array.isArray(d.comments) && d.comments.every(isComment))) &&
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
/** Told on every change: the waiting comments are read per task (`useComments`). */
const commentListeners = new Set<() => void>();

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
  for (const cb of [...commentListeners]) cb();
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
 * Keep the task's draft. Empty text removes it instead, unless comments are
 * waiting: they stay, with an empty box. A "not sent" mark
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
    dropDraftText(taskId, now);
    return;
  }
  const prev = current().get(taskId);
  put(taskId, {
    text,
    pastes: [...pastesIn(text, pastes)],
    ...usedMentions(text, mentions),
    savedAt: now,
    ...(prev?.notSent && prev.text === text ? { notSent: true } : {}),
    ...commentsKept(prev),
  });
}

function commentsKept(prev: Draft | undefined): Pick<Draft, 'comments'> {
  return prev?.comments && prev.comments.length > 0 ? { comments: prev.comments } : {};
}

/**
 * The box's part of the draft goes -- a send is under way, or it was
 * emptied -- and the waiting comments stay. Nothing left: no draft.
 */
export function dropDraftText(taskId: number, now = Date.now()): void {
  const prev = current().get(taskId);
  if (!prev) return;
  if (!prev.comments || prev.comments.length === 0) {
    dropDraft(taskId);
    return;
  }
  if (prev.text === '' && prev.pastes.length === 0 && !prev.mentions && !prev.notSent) return;
  put(taskId, { text: '', pastes: [], savedAt: now, comments: prev.comments });
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
  put(taskId, {
    text,
    pastes: [...pastesIn(text, pastes)],
    ...usedMentions(text, mentions),
    savedAt: now,
    notSent: true,
    ...commentsKept(current().get(taskId)),
  });
}

// ---------------------------------------------------------------------------
// Waiting comments (#187)
// ---------------------------------------------------------------------------

const NO_COMMENTS: readonly TranscriptComment[] = [];

/** The task's waiting comments, as added (the send puts them in transcript order). */
export function commentsOf(taskId: number): readonly TranscriptComment[] {
  return current().get(taskId)?.comments ?? NO_COMMENTS;
}

function putComments(taskId: number, comments: readonly TranscriptComment[], now: number): void {
  const prev = current().get(taskId);
  if (comments.length === 0) {
    if (!prev) return;
    if (isEmptyDraft(prev.text)) {
      dropDraft(taskId);
      return;
    }
    const rest: Draft = { ...prev };
    delete rest.comments;
    put(taskId, rest);
    return;
  }
  put(taskId, { ...(prev ?? { text: '', pastes: [] }), savedAt: now, comments });
}

/** Keep a comment with the task's draft. */
export function addComment(taskId: number, comment: TranscriptComment, now = Date.now()): void {
  putComments(taskId, [...commentsOf(taskId), comment], now);
}

/** Change what a waiting comment says. Empty text is not a comment: use `removeComment`. */
export function editComment(taskId: number, id: string, text: string, now = Date.now()): void {
  const list = commentsOf(taskId);
  if (!list.some((c) => c.id === id) || text.trim().length === 0) return;
  putComments(
    taskId,
    list.map((c) => (c.id === id ? { ...c, comment: text } : c)),
    now,
  );
}

export function removeComment(taskId: number, id: string, now = Date.now()): void {
  const list = commentsOf(taskId);
  if (!list.some((c) => c.id === id)) return;
  putComments(
    taskId,
    list.filter((c) => c.id !== id),
    now,
  );
}

/**
 * The comments a message carried leave the list: it was delivered, or it is
 * held in the outbox and goes from there. By id, so one added while that
 * send was under way stays for the next.
 */
export function takeComments(taskId: number, ids: readonly string[], now = Date.now()): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  const list = commentsOf(taskId);
  if (!list.some((c) => gone.has(c.id))) return;
  putComments(
    taskId,
    list.filter((c) => !gone.has(c.id)),
    now,
  );
}

function subscribeComments(cb: () => void): () => void {
  commentListeners.add(cb);
  return () => {
    commentListeners.delete(cb);
  };
}

/** The task's waiting comments, re-read on every change to the drafts. */
export function useComments(taskId: number | null): readonly TranscriptComment[] {
  const read = () => (taskId === null ? NO_COMMENTS : commentsOf(taskId));
  return useSyncExternalStore(subscribeComments, read, read);
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
 *
 * `readStartedAt`: when that read began. A draft saved since is kept whatever
 * the read says: the read cannot know a task created after it began, and New
 * Task saves a request's prompt as the new task's draft the moment the row
 * exists (#184). Without it, the list alone decides.
 */
export function keepDraftsFor(taskIds: Iterable<number>, now = Date.now(), readStartedAt = Infinity): void {
  const live = new Set(taskIds);
  const prev = current();
  const kept = [...withoutExpired(prev, now)].filter(([id, d]) => live.has(id) || d.savedAt >= readStartedAt);
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
  commentListeners.clear();
}
