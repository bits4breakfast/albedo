/**
 * What sessions asked for through Albedo's MCP server (#157), waiting on the
 * user: the "Requests" button in the header and its list.
 *
 * Each request arrives once from the inbox (capture/inbox.ts) and stays here
 * until the user acts on it:
 *
 *   - `request_session`: Approve opens New Task filled in from the request;
 *     the request leaves the queue only once that task is created. Deny drops
 *     it. Nothing starts without the click -- the queue never creates a task.
 *   - `create_reminder`: set at once by {@link handleCreateReminder}, as a
 *     reminder on the asking task (#156); it never waits here. Only one Albedo
 *     could not set -- its task gone, say -- is kept, saying so, until dismissed.
 *   - `notify_blocked`: the task is marked and the user cued (attention.ts),
 *     and the message is kept here until dismissed: opening the task clears
 *     its mark, but the message is only here, so it stays until read. A newer
 *     one from the same task replaces it.
 *
 * Kept across a restart in localStorage, as the composer's drafts are: no
 * database table, since the requests are the user's to clear, not history.
 * A request older than a week is dropped. The ids of handled requests are
 * kept too (the last few hundred), so a line the inbox hands on twice -- a
 * crash between reading and compacting -- is not queued again.
 */

import { useSyncExternalStore } from 'react';
import { decodeStoredRequest, encodeRequest, type InboxRequest } from '../capture/inbox';
import { createReminder, listPendingReminders } from '../reminders';
import { noteAgentBlocked } from './attention';
import { KEYS, readPersisted, writePersisted, type Codec } from './persisted';

export type QueuedRequest = InboxRequest;
export type SessionRequest = Extract<InboxRequest, { tool: 'request_session' }>;
export type ReminderRequest = Extract<InboxRequest, { tool: 'create_reminder' }>;
export type BlockedNotice = Extract<InboxRequest, { tool: 'notify_blocked' }>;

/** How long a request waits before it is dropped unanswered. */
export const REQUEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Pending requests of one kind one task may have; more are dropped. */
export const MAX_PENDING_PER_TASK = 10;
/** Handled ids remembered, against a line handed on twice. */
export const HANDLED_MAX = 500;
/**
 * A notice older than this when it arrives (written while Albedo was closed)
 * is listed, but does not bounce the dock or post a banner: it is not news.
 */
export const NOTICE_FRESH_MS = 10 * 60 * 1000;

export interface QueueState {
  /** Oldest first. */
  items: readonly QueuedRequest[];
  handled: readonly string[];
}

const EMPTY: QueueState = { items: [], handled: [] };

export const queueCodec: Codec<QueueState> = {
  decode: (raw) => {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== 'object' || o === null) return null;
    const { items, handled } = o as { items?: unknown; handled?: unknown };
    return {
      items: Array.isArray(items) ? items.map(decodeStoredRequest).filter((r): r is QueuedRequest => r !== null) : [],
      handled: Array.isArray(handled) ? handled.filter((h): h is string => typeof h === 'string') : [],
    };
  },
  encode: (s) =>
    s.items.length === 0 && s.handled.length === 0
      ? null
      : JSON.stringify({ items: s.items.map(encodeRequest), handled: s.handled }),
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** What the caller knows about the requesting task. */
export interface TaskInfo {
  /** Undefined: no such task (deleted, or never one of ours). */
  title: string | undefined;
  archived: boolean;
}

export type Admission =
  | { add: true; replaces: string | null }
  | { add: false; why: 'seen' | 'unknown-task' | 'expired' | 'too-many' };

/** Whether `req` joins the queue, and which earlier item it replaces. */
export function admit(state: QueueState, req: QueuedRequest, task: TaskInfo, now: number): Admission {
  if (state.handled.includes(req.id) || state.items.some((r) => r.id === req.id)) return { add: false, why: 'seen' };
  if (task.title === undefined || task.archived) return { add: false, why: 'unknown-task' };
  if (now - req.at >= REQUEST_MAX_AGE_MS) return { add: false, why: 'expired' };
  if (req.tool === 'notify_blocked') {
    const prior = state.items.find((r) => r.tool === 'notify_blocked' && r.taskId === req.taskId);
    return { add: true, replaces: prior?.id ?? null };
  }
  const same = state.items.filter((r) => r.tool === req.tool && r.taskId === req.taskId).length;
  return same >= MAX_PENDING_PER_TASK ? { add: false, why: 'too-many' } : { add: true, replaces: null };
}

function remember(handled: readonly string[], ids: readonly string[]): string[] {
  const next = [...handled.filter((h) => !ids.includes(h)), ...ids];
  return next.length > HANDLED_MAX ? next.slice(next.length - HANDLED_MAX) : next;
}

/** `state` with `req` admitted, or the same state. */
export function withRequest(state: QueueState, req: QueuedRequest, task: TaskInfo, now: number): QueueState {
  const a = admit(state, req, task, now);
  if (!a.add) {
    // Remembered either way, so a refused line read again is refused quietly.
    return a.why === 'seen' ? state : { ...state, handled: remember(state.handled, [req.id]) };
  }
  const items = a.replaces === null ? state.items : state.items.filter((r) => r.id !== a.replaces);
  return {
    items: [...items, req],
    handled: a.replaces === null ? state.handled : remember(state.handled, [a.replaces]),
  };
}

/** `state` without the items `drop` picks; their ids are remembered as handled. */
export function without(state: QueueState, drop: (r: QueuedRequest) => boolean): QueueState {
  const gone = state.items.filter(drop).map((r) => r.id);
  if (gone.length === 0) return state;
  return { items: state.items.filter((r) => !drop(r)), handled: remember(state.handled, gone) };
}

/** Requests older than a week go. */
export function withoutExpired(state: QueueState, now: number): QueueState {
  return without(state, (r) => now - r.at >= REQUEST_MAX_AGE_MS);
}

// ---------------------------------------------------------------------------
// create_reminder: the one adapter to #156
// ---------------------------------------------------------------------------

/**
 * Turn a session's reminder request into a reminder on the task that asked.
 * The only place that calls #156's `createReminder`. Resolves false, with the
 * reason logged, when it could not be set -- or when the task already has
 * {@link MAX_PENDING_PER_TASK} still to come: nothing is in the way of a
 * session setting one, so a session in a loop must not set hundreds.
 */
export async function handleCreateReminder(req: ReminderRequest): Promise<boolean> {
  try {
    const waiting = await listPendingReminders(req.taskId);
    if (waiting.length >= MAX_PENDING_PER_TASK) {
      console.warn(`[requests] reminder from task ${req.taskId} not set: ${waiting.length} already to come`);
      return false;
    }
    await createReminder({
      taskId: req.taskId,
      text: req.text,
      dueAt: req.dueMs,
      createdBy: 'session',
      summary: req.summary,
    });
    return true;
  } catch (e) {
    console.warn(`[requests] reminder from task ${req.taskId} not set:`, e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let state: QueueState | null = null;
const listeners = new Set<() => void>();

function current(): QueueState {
  if (state === null) state = withoutExpired(readPersisted(KEYS.requestQueue, queueCodec, EMPTY), Date.now());
  return state;
}

function commit(next: QueueState): void {
  if (next === state) return;
  state = next;
  writePersisted(KEYS.requestQueue, queueCodec, next);
  for (const cb of [...listeners]) cb();
}

/**
 * A request from the inbox. `task` is what the app knows of the requesting
 * task right now. Cues the user for a fresh `notify_blocked`; never starts
 * anything.
 */
export function receiveRequest(req: QueuedRequest, task: TaskInfo, now = Date.now()): void {
  const prev = current();
  const a = admit(prev, req, task, now);
  if (!a.add && a.why !== 'seen') console.warn(`[requests] ${req.tool} from task ${req.taskId} not queued: ${a.why}`);
  if (a.add && req.tool === 'create_reminder') {
    // Handled before it is set, so a line handed on twice is never set twice;
    // queued only if it could not be.
    commit({ ...prev, handled: remember(prev.handled, [req.id]) });
    void handleCreateReminder(req).then((ok) => {
      // Already in `handled`, so appended as is: withRequest would see it as seen.
      if (!ok) commit({ ...current(), items: [...current().items, req] });
    });
    return;
  }
  commit(withRequest(prev, req, task, now));
  if (a.add && req.tool === 'notify_blocked' && now - req.at < NOTICE_FRESH_MS) {
    noteAgentBlocked(req.taskId, task.title ?? null, req.message);
  }
}

/** The user denied or dismissed it. */
export function dismissRequest(id: string): void {
  commit(without(current(), (r) => r.id === id));
}

/** A request was carried out (its task created). */
export const resolveRequest = dismissRequest;

/** Drop the requests of tasks that are gone or archived, and any older than a week. */
export function keepRequestsFor(liveTaskIds: Iterable<number>, now = Date.now()): void {
  const live = new Set(liveTaskIds);
  commit(withoutExpired(without(current(), (r) => !live.has(r.taskId)), now));
}

export function pendingRequests(): readonly QueuedRequest[] {
  return current().items;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function snapshot(): readonly QueuedRequest[] {
  return current().items;
}

/** The queue, re-rendering on every change. */
export function useRequests(): readonly QueuedRequest[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: forget everything in memory, so the next read comes from storage. */
export function __resetRequests(): void {
  state = null;
  listeners.clear();
}
