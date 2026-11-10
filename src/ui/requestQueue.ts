/**
 * What sessions asked for through Albedo's MCP server (#157), waiting on the
 * user: a request for a new session in the task list's Proposed group
 * (#332, ProposedGroup.tsx), the rest behind the "Requests" button in the
 * header.
 *
 * Each request arrives once from the inbox (capture/inbox.ts) and stays here
 * until the user acts on it:
 *
 *   - `request_session`: a row in the Proposed group. Approve… opens New Task
 *     filled in from the request; the request leaves the queue only once that
 *     task is created. Deny drops it. Nothing starts without the click -- the
 *     queue never creates a task.
 *   - `create_reminder`: set at once by {@link handleCreateReminder}, as a
 *     reminder on the asking task (#156); it never waits here. Only one Albedo
 *     could not set -- its task gone, say -- is kept, saying so, until dismissed.
 *   - `notify_blocked`: the task is marked and the user cued (attention.ts),
 *     and the message is kept here until dismissed: opening the task clears
 *     its mark, but the message is only here, so it stays until read. A newer
 *     one from the same task replaces it.
 *   - `set_task_summary` (#262): written to the asking task's `tasks.summary`
 *     at once by {@link handleSetTaskSummary}; never queued, never shown here.
 *     The last write wins, the user's included (the rename field).
 *
 * Kept across a restart in localStorage, as the composer's drafts are: no
 * database table, since the requests are the user's to clear, not history.
 * A request older than a week is dropped. The ids of handled requests are
 * kept too (the last few hundred), so a line the inbox hands on twice -- a
 * crash between reading and compacting -- is not queued again.
 *
 * What became of a request for a new session is kept as well (#332), the last
 * few hundred: denied, or spun out as which task. The asking task's
 * transcript says so on the `request_session` call (spinOut.ts). Like the
 * queue, it is the user's own state, not history, so it stays here.
 */

import { useSyncExternalStore } from 'react';
import { decodeStoredRequest, encodeRequest, type InboxRequest } from '../capture/inbox';
import { setTaskSummary } from '../db';
import { createReminder, listPendingReminders } from '../reminders';
import { noteAgentBlocked } from './attention';
import { KEYS, readPersisted, writePersisted, type Codec } from './persisted';

/** What can wait here: everything but a summary, which is written at once. */
export type QueuedRequest = Exclude<InboxRequest, { tool: 'set_task_summary' }>;
export type TaskSummaryRequest = Extract<InboxRequest, { tool: 'set_task_summary' }>;
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

/**
 * What became of a request for a new session (#332). Matched to the call in
 * the asking task's transcript by task and {@link requestKey}, since the call
 * carries no request id.
 */
export interface SessionOutcome {
  /** The request's id. */
  id: string;
  /** The task that asked. */
  taskId: number;
  /** {@link requestKey} of its title and brief. */
  key: string;
  outcome: 'denied' | 'spun';
  /** The task created from it, and its title then; null when denied. */
  spunTaskId: number | null;
  spunTitle: string | null;
}

export interface QueueState {
  /** Oldest first. */
  items: readonly QueuedRequest[];
  handled: readonly string[];
  /** Oldest first; at most {@link OUTCOMES_MAX}. */
  outcomes: readonly SessionOutcome[];
}

/** Outcomes remembered. */
export const OUTCOMES_MAX = 300;

const EMPTY: QueueState = { items: [], handled: [], outcomes: [] };

/** FNV-1a, 32 bits, as hex: a brief is up to 16 000 characters, the key need not be. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * What identifies a request among one task's: its title and its brief, as
 * the server stores them (trimmed). The same pair twice is "asking twice",
 * which the tool's description forbids; both would then read the same.
 */
export function requestKey(title: string, prompt: string): string {
  return `${title.trim()}\n${hash(prompt.trim())}`;
}

function isOutcome(o: unknown): o is SessionOutcome {
  if (typeof o !== 'object' || o === null) return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.taskId === 'number' &&
    typeof x.key === 'string' &&
    (x.outcome === 'denied' || x.outcome === 'spun') &&
    (x.spunTaskId === null || typeof x.spunTaskId === 'number') &&
    (x.spunTitle === null || typeof x.spunTitle === 'string')
  );
}

export const queueCodec: Codec<QueueState> = {
  decode: (raw) => {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== 'object' || o === null) return null;
    const { items, handled, outcomes } = o as { items?: unknown; handled?: unknown; outcomes?: unknown };
    return {
      items: Array.isArray(items)
        ? items.map(decodeStoredRequest).filter((r): r is QueuedRequest => r !== null && r.tool !== 'set_task_summary')
        : [],
      handled: Array.isArray(handled) ? handled.filter((h): h is string => typeof h === 'string') : [],
      // Absent in what a build before #332 stored.
      outcomes: Array.isArray(outcomes) ? outcomes.filter(isOutcome) : [],
    };
  },
  encode: (s) =>
    s.items.length === 0 && s.handled.length === 0 && s.outcomes.length === 0
      ? null
      : JSON.stringify({ items: s.items.map(encodeRequest), handled: s.handled, outcomes: s.outcomes }),
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
    ...state,
    items: [...items, req],
    handled: a.replaces === null ? state.handled : remember(state.handled, [a.replaces]),
  };
}

/** `state` without the items `drop` picks; their ids are remembered as handled. */
export function without(state: QueueState, drop: (r: QueuedRequest) => boolean): QueueState {
  const gone = state.items.filter(drop).map((r) => r.id);
  if (gone.length === 0) return state;
  return { ...state, items: state.items.filter((r) => !drop(r)), handled: remember(state.handled, gone) };
}

/**
 * `state` with request `id` decided (#332): out of the queue and, when it was
 * a request for a new session, what became of it remembered. `spun` is the
 * task created from it; null means denied.
 */
export function decided(state: QueueState, id: string, spun: { id: number; title: string } | null): QueueState {
  const req = state.items.find((r) => r.id === id);
  const next = without(state, (r) => r.id === id);
  if (!req || req.tool !== 'request_session') return next;
  const outcome: SessionOutcome = {
    id,
    taskId: req.taskId,
    key: requestKey(req.title, req.prompt),
    outcome: spun ? 'spun' : 'denied',
    spunTaskId: spun?.id ?? null,
    spunTitle: spun?.title ?? null,
  };
  const outcomes = [...state.outcomes.filter((o) => o.id !== id), outcome];
  return {
    ...next,
    outcomes: outcomes.length > OUTCOMES_MAX ? outcomes.slice(outcomes.length - OUTCOMES_MAX) : outcomes,
  };
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
// set_task_summary (#262)
// ---------------------------------------------------------------------------

/**
 * Write a session's summary to the task that asked: `tasks.summary`, nothing
 * else. Already checked twice (the server, then inbox.ts): one line, trimmed,
 * at most 120 characters. Resolves false, logged, when it was not written.
 */
export async function handleSetTaskSummary(
  req: TaskSummaryRequest,
  write: (taskId: number, summary: string) => Promise<boolean> = setTaskSummary,
): Promise<boolean> {
  try {
    const ok = await write(req.taskId, req.summary);
    if (!ok) console.warn(`[requests] summary from task ${req.taskId} not set: no such task`);
    return ok;
  } catch (e) {
    console.warn(`[requests] summary from task ${req.taskId} not set:`, e);
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
 * anything. A summary is written, not queued.
 */
export function receiveRequest(
  req: InboxRequest,
  task: TaskInfo,
  now = Date.now(),
  writeSummary?: (taskId: number, summary: string) => Promise<boolean>,
): void {
  const prev = current();
  if (req.tool === 'set_task_summary') {
    // Not queued, so not aged out either: lines are read in the order they
    // were written, and the latest is the one that should stand.
    if (prev.handled.includes(req.id)) return;
    if (task.title === undefined) {
      console.warn(`[requests] summary from task ${req.taskId} not set: unknown-task`);
      return;
    }
    commit({ ...prev, handled: remember(prev.handled, [req.id]) });
    void handleSetTaskSummary(req, writeSummary);
    return;
  }
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

/** The user dismissed it (a notice, a reminder that could not be set). */
export function dismissRequest(id: string): void {
  commit(without(current(), (r) => r.id === id));
}

/** Deny on a proposed task (#332): it leaves, and its transcript says "Not spun out". */
export function denyRequest(id: string): void {
  commit(decided(current(), id, null));
}

/** A request was carried out: `task` was created from it. */
export function resolveRequest(id: string, task: { id: number; title: string }): void {
  commit(decided(current(), id, task));
}

/** Drop the requests of tasks that are gone or archived, and any older than a week. */
export function keepRequestsFor(liveTaskIds: Iterable<number>, now = Date.now()): void {
  const live = new Set(liveTaskIds);
  commit(withoutExpired(without(current(), (r) => !live.has(r.taskId)), now));
}

export function pendingRequests(): readonly QueuedRequest[] {
  return current().items;
}

/** What became of requests for new sessions (#332), oldest first. */
export function sessionOutcomes(): readonly SessionOutcome[] {
  return current().outcomes;
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

function outcomesSnapshot(): readonly SessionOutcome[] {
  return current().outcomes;
}

/** What became of requests for new sessions (#332), re-rendering on every change. */
export function useSessionOutcomes(): readonly SessionOutcome[] {
  return useSyncExternalStore(subscribe, outcomesSnapshot, outcomesSnapshot);
}

/** Test seam: forget everything in memory, so the next read comes from storage. */
export function __resetRequests(): void {
  state = null;
  listeners.clear();
}
