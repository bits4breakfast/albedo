/**
 * Comments on a plan in the "waiting on you" card (#272), not sent yet.
 *
 * Kept per prompt: by task and the request id of the hook waiting for the
 * answer, so a comment can only ever go with the question it was left on.
 * They survive switching tasks and projects (memory, with a copy in
 * localStorage, as drafts.ts keeps the composer's), and leave in one way
 * only: the prompt they belong to is gone -- answered from the card, from
 * the terminal, or the session ended. That is read from the hook events
 * (`onPromptChange`), never from a click: a click that sent nothing (refused,
 * or the terminal won) leaves them where they were. Removing one by hand
 * (✕) is the other way out. A day after it was last changed an entry goes
 * too: no hook waits that long.
 *
 * Nothing here sends anything. The card composes the answer (planDoc.ts) and
 * sends it on a click.
 */

import { useSyncExternalStore } from 'react';
import { onPromptChange, type PendingPrompt } from '../../capture/hookEvents';
import { KEYS, readPersisted, writePersisted, type Codec } from '../persisted';

export interface PlanComment {
  id: string;
  /** The passage, as selected. */
  quote: string;
  /** Non-blank characters before the passage in the document (passages.ts). */
  offset: number;
  comment: string;
  addedAt: number;
}

interface Entry {
  comments: readonly PlanComment[];
  savedAt: number;
}

type Store = ReadonlyMap<string, Entry>;

/** How long an entry outlives its last change. The answer window is an hour. */
export const PLAN_COMMENTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The key of one prompt's comments. */
export function planCommentKey(taskId: number, requestId: string): string {
  return `${taskId}:${requestId}`;
}

function taskOf(key: string): number {
  return Number(key.slice(0, key.indexOf(':')));
}

function isComment(v: unknown): v is PlanComment {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.quote === 'string' &&
    typeof c.offset === 'number' &&
    typeof c.comment === 'string' &&
    typeof c.addedAt === 'number'
  );
}

export const planCommentsCodec: Codec<Store> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out = new Map<string, Entry>();
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^\d+:[\w-]+$/.test(key) || typeof value !== 'object' || value === null) continue;
      const e = value as Record<string, unknown>;
      if (typeof e.savedAt !== 'number' || !Array.isArray(e.comments)) continue;
      const comments = e.comments.filter(isComment);
      if (comments.length > 0) out.set(key, { comments, savedAt: e.savedAt });
    }
    return out;
  },
  encode: (store) => (store.size === 0 ? null : JSON.stringify(Object.fromEntries(store))),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let store: Store | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function current(): Store {
  if (store === null) {
    const now = Date.now();
    const read = readPersisted(KEYS.planComments, planCommentsCodec, new Map<string, Entry>());
    store = new Map([...read].filter(([, e]) => now - e.savedAt < PLAN_COMMENTS_MAX_AGE_MS));
    // Whatever task it is, and whether or not its card is on screen.
    unsubscribe ??= onPromptChange(promptChanged);
  }
  return store;
}

function commit(next: Store): void {
  if (next === store) return;
  store = next;
  writePersisted(KEYS.planComments, planCommentsCodec, next);
  for (const cb of [...listeners]) cb();
}

/**
 * A task's prompt changed: comments on any other of its prompts have nothing
 * left to answer. The prompt now on screen keeps its own.
 */
function promptChanged(taskId: number, next: PendingPrompt | null): void {
  const keep = next !== null && next.kind !== 'notice' && next.requestId !== null ? planCommentKey(taskId, next.requestId) : null;
  const prev = current();
  const kept = [...prev].filter(([key]) => taskOf(key) !== taskId || key === keep);
  if (kept.length !== prev.size) commit(new Map(kept));
}

const NONE: readonly PlanComment[] = [];

export function planCommentsOf(key: string | null): readonly PlanComment[] {
  const all = current(); // the first read also starts listening for prompts to end
  return key === null ? NONE : (all.get(key)?.comments ?? NONE);
}

function put(key: string, comments: readonly PlanComment[], now: number): void {
  const next = new Map(current());
  if (comments.length === 0) next.delete(key);
  else next.set(key, { comments, savedAt: now });
  commit(next);
}

export function addPlanComment(key: string, c: Omit<PlanComment, 'id' | 'addedAt'>, now = Date.now()): PlanComment {
  const comment: PlanComment = { ...c, id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, addedAt: now };
  put(key, [...planCommentsOf(key), comment], now);
  return comment;
}

/** Change what a comment says. Empty text is not a comment: use `removePlanComment`. */
export function editPlanComment(key: string, id: string, text: string, now = Date.now()): void {
  const list = planCommentsOf(key);
  if (text.trim().length === 0 || !list.some((c) => c.id === id)) return;
  put(
    key,
    list.map((c) => (c.id === id ? { ...c, comment: text.trim() } : c)),
    now,
  );
}

export function removePlanComment(key: string, id: string, now = Date.now()): void {
  const list = planCommentsOf(key);
  if (!list.some((c) => c.id === id)) return;
  put(
    key,
    list.filter((c) => c.id !== id),
    now,
  );
}

/** In the document's order: the order they are numbered, listed and sent in. */
export function inDocumentOrder(comments: readonly PlanComment[]): PlanComment[] {
  return [...comments].sort((a, b) => a.offset - b.offset || a.addedAt - b.addedAt);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** One prompt's comments, re-read on every change. */
export function usePlanComments(key: string | null): readonly PlanComment[] {
  const read = () => planCommentsOf(key);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam: forget everything in memory, so the next read comes from storage. */
export function __resetPlanComments(): void {
  store = null;
  listeners.clear();
  unsubscribe?.();
  unsubscribe = null;
}
