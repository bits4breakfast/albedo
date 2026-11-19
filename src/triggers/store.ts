/**
 * What triggers keep per task (#448): the watch over its PR (`detect.ts`),
 * and the cards that fired and wait on you.
 *
 * Kept in localStorage (`albedo.triggers`, persisted.ts), as the CI queue's
 * "handled" commit and the composer's drafts are: per-machine app state, not
 * a shared contract and not user settings (those are files under
 * `~/.albedo/triggers/`, settings.ts). It must survive a restart, both halves:
 *   - the watch, so a restart neither fires an old event again nor misses a
 *     merge that happened while Albedo was closed;
 *   - the cards, because a card stays until you Send, act or Skip.
 * It goes with its task: archived or deleted, everything kept for it goes
 * (`keepTriggersFor`, `forgetTriggers`).
 *
 * Nothing here sends, merges or posts: a card is a record of what was
 * offered. Only the card's buttons act (TriggerCard.tsx).
 */

import { useSyncExternalStore } from 'react';
import { KEYS, readPersisted, writePersisted, type Codec } from '../ui/persisted';
import type { FailedCheck } from '../ui/transcript/ciFailure';
import type { TriggerWatch } from './detect';
import type { TriggerEvent } from './settings';

export interface TriggerCard {
  /** Unique within the task: the event, the PR, and what fired it. */
  id: string;
  event: TriggerEvent;
  mode: 'draft' | 'suggest';
  /** When it fired. */
  at: number;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  /** What happened, for the card's head: "PR #412 was merged". */
  subject: string;
  /** What happened in a word or two, for the task's row: "PR merged". */
  label: string;
  /** Draft: the project's template when it fired. */
  template: string;
  /** Draft: the event's facts, appended to the template. */
  facts: string;
  /** Suggest: one line on why it is offered. */
  why?: string;
  /** CI: the commit and its failing checks. Approved: the commit. */
  sha?: string;
  checks?: FailedCheck[];
  /** Review: what it covers -- since when, who asked for changes, how many new threads. */
  review?: { since: number; changesBy: string[]; newThreads: number };
  /** The draft as edited on the card. Absent: the template and the facts. */
  text?: string;
  /** Moved to the message box (Edit in Message Box): it goes when a message carrying it is sent. */
  inBox?: boolean;
  /**
   * It no longer applies, and you had edited it, so it was kept rather than
   * removed: why, in a few words ("PR merged meanwhile"). Send and Skip still work.
   */
  stale?: string;
  /** A line a sent message must carry, whole, to count as this draft (its first line when moved). */
  boxKey?: string;
}

export interface TriggerEntry {
  watch?: TriggerWatch;
  cards: TriggerCard[];
  /** When it was last written: a prune never drops what is newer than its own read. */
  savedAt?: number;
}

type TriggerMap = ReadonlyMap<number, TriggerEntry>;

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

const EVENTS: readonly string[] = ['merged', 'ciFailed', 'review', 'approved'];
const STATES: readonly string[] = ['open', 'draft', 'merged', 'closed'];

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function isWatch(v: unknown): v is TriggerWatch {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Record<string, unknown>;
  return (
    isNum(w.pr) &&
    isStr(w.state) &&
    STATES.includes(w.state) &&
    isStr(w.ciSha) &&
    isStrList(w.ciFailed) &&
    isStrList(w.reviews) &&
    (w.threads === null || isNum(w.threads)) &&
    isNum(w.reviewSince) &&
    (w.ready === null || isStr(w.ready))
  );
}

function isCheck(v: unknown): v is FailedCheck {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return isStr(c.name) && isStr(c.conclusion) && (c.url === null || isStr(c.url));
}

function isReview(v: unknown): v is NonNullable<TriggerCard['review']> {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return isNum(r.since) && isStrList(r.changesBy) && isNum(r.newThreads);
}

function isCard(v: unknown): v is TriggerCard {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    isStr(c.id) &&
    isStr(c.event) &&
    EVENTS.includes(c.event) &&
    (c.mode === 'draft' || c.mode === 'suggest') &&
    isNum(c.at) &&
    isNum(c.prNumber) &&
    isStr(c.prTitle) &&
    isStr(c.prUrl) &&
    isStr(c.subject) &&
    isStr(c.label) &&
    isStr(c.template) &&
    isStr(c.facts) &&
    (c.why === undefined || isStr(c.why)) &&
    (c.sha === undefined || isStr(c.sha)) &&
    (c.checks === undefined || (Array.isArray(c.checks) && c.checks.every(isCheck))) &&
    (c.review === undefined || isReview(c.review)) &&
    (c.text === undefined || isStr(c.text)) &&
    (c.inBox === undefined || typeof c.inBox === 'boolean') &&
    (c.boxKey === undefined || isStr(c.boxKey)) &&
    (c.stale === undefined || isStr(c.stale))
  );
}

/** Task id -> what is kept for it. A malformed watch or card is dropped, never guessed at. */
export const triggersCodec: Codec<TriggerMap> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const map = new Map<number, TriggerEntry>();
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (!Number.isInteger(id) || typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const entry: TriggerEntry = {
        ...(isWatch(v.watch) ? { watch: v.watch } : {}),
        cards: Array.isArray(v.cards) ? v.cards.filter(isCard) : [],
        ...(isNum(v.savedAt) ? { savedAt: v.savedAt } : {}),
      };
      if (entry.watch || entry.cards.length > 0) map.set(id, entry);
    }
    return map;
  },
  encode: (map) => (map.size === 0 ? null : JSON.stringify(Object.fromEntries(map))),
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let state: TriggerMap | null = null;
const listeners = new Set<() => void>();
let version = 0;

function current(): TriggerMap {
  if (state === null) state = readPersisted(KEYS.triggers, triggersCodec, new Map());
  return state;
}

function commit(next: TriggerMap): void {
  if (next === state) return;
  state = next;
  cancelEditWrite();
  writePersisted(KEYS.triggers, triggersCodec, next);
  version += 1;
  for (const cb of [...listeners]) cb();
}

function put(taskId: number, entry: TriggerEntry): void {
  const prev = current();
  const next = new Map(prev);
  if (entry.watch || entry.cards.length > 0) next.set(taskId, { ...entry, savedAt: Date.now() });
  else if (prev.has(taskId)) next.delete(taskId);
  else return;
  commit(next);
}

function entryOf(taskId: number): TriggerEntry {
  return current().get(taskId) ?? { cards: [] };
}

const NO_CARDS: readonly TriggerCard[] = [];

/** What the watch remembered about the task's PR, or undefined for nothing yet. */
export function triggerWatchOf(taskId: number): TriggerWatch | undefined {
  return current().get(taskId)?.watch;
}

export function setTriggerWatch(taskId: number, watch: TriggerWatch): void {
  const e = entryOf(taskId);
  if (JSON.stringify(e.watch) === JSON.stringify(watch)) return;
  put(taskId, { ...e, watch });
}

/** The cards waiting on you for a task, oldest first. */
export function triggerCardsOf(taskId: number): readonly TriggerCard[] {
  return current().get(taskId)?.cards ?? NO_CARDS;
}

/** A trigger card waits on you: the task is in Needs You. */
export function triggerWaiting(taskId: number): boolean {
  return triggerCardsOf(taskId).length > 0;
}

/** The task ids with a card waiting. */
export function tasksWithTriggerCards(): number[] {
  return [...current()].filter(([, e]) => e.cards.length > 0).map(([id]) => id);
}

/** Whether a card is as it fired: not edited, not in the message box. */
export function untouched(c: TriggerCard): boolean {
  return c.text === undefined && !c.inBox;
}

/**
 * A card fired. It replaces a card for the same event still waiting as it
 * fired (the newer one says more), never one you edited or moved to the
 * message box: that is your text, kept until you send or skip it.
 */
export function addTriggerCard(taskId: number, card: TriggerCard): void {
  const e = entryOf(taskId);
  if (e.cards.some((c) => c.id === card.id)) return;
  const cards = [...e.cards.filter((c) => !(c.event === card.event && untouched(c))), card];
  put(taskId, { ...e, cards });
}

function updateCard(taskId: number, id: string, patch: (c: TriggerCard) => TriggerCard): void {
  const e = entryOf(taskId);
  if (!e.cards.some((c) => c.id === id)) return;
  put(taskId, { ...e, cards: e.cards.map((c) => (c.id === id ? patch(c) : c)) });
}

/** The draft as edited on the card. */
export function editTriggerCard(taskId: number, id: string, text: string): void {
  // Typing is not news: held in memory at once (so a newer card never
  // replaces it, `addTriggerCard`), written soon after, and no one is told --
  // the task list does not regroup per keystroke. The card keeps its own copy.
  const e = current().get(taskId);
  if (!e || !e.cards.some((c) => c.id === id)) return;
  const next = new Map(current());
  next.set(taskId, { ...e, cards: e.cards.map((c) => (c.id === id ? { ...c, text } : c)), savedAt: Date.now() });
  state = next;
  writeEditSoon();
}

/** How long typing waits before it is written. */
export const EDIT_WRITE_MS = 400;
let editTimer: ReturnType<typeof setTimeout> | null = null;
let flushHooked = false;

function cancelEditWrite(): void {
  if (editTimer !== null) clearTimeout(editTimer);
  editTimer = null;
}

function writeEditSoon(): void {
  if (!flushHooked && typeof window !== 'undefined') {
    // Closing the app while typing: written on the way out.
    flushHooked = true;
    window.addEventListener('pagehide', flushTriggerEdits);
    window.addEventListener('beforeunload', flushTriggerEdits);
  }
  if (editTimer === null) editTimer = setTimeout(flushTriggerEdits, EDIT_WRITE_MS);
}

/** Write an edit still waiting for its timer (leaving the card, closing the app). */
export function flushTriggerEdits(): void {
  if (editTimer === null) return;
  cancelEditWrite();
  if (state !== null) writePersisted(KEYS.triggers, triggersCodec, state);
}

/** Edit in Message Box took it: the card waits for a message carrying `boxKey` to be sent. */
export function markTriggerInBox(taskId: number, id: string, boxKey: string): void {
  updateCard(taskId, id, (c) => ({ ...c, inBox: true, boxKey }));
}

/**
 * Text was delivered to the task's session, by whatever path (the message
 * box, the outbox's release): a card moved to the box goes once a message
 * carrying its line was sent. Only ever removes a card; never sends.
 */
export function noteTriggerTextSent(taskId: number, text: string): void {
  if (!triggerCardsOf(taskId).some((c) => c.inBox)) return;
  // A whole line, never a substring: "ok" is inside "look" (REGRESSIONS).
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  resolveTriggerCards(taskId, (c) => c.inBox === true && !!c.boxKey && lines.has(c.boxKey.trim()));
}

/** Sent, acted on, or skipped: the card goes. */
export function resolveTriggerCard(taskId: number, id: string): void {
  const e = entryOf(taskId);
  if (!e.cards.some((c) => c.id === id)) return;
  put(taskId, { ...e, cards: e.cards.filter((c) => c.id !== id) });
}

/**
 * Commit `sha`'s failure went to Claude with an ordinary message (the CI
 * queue's copy): a CI card for that commit has nothing left to say.
 */
export function noteCiFailureSent(taskId: number, sha: string): void {
  retireTriggerCards(taskId, (c) => c.event === 'ciFailed' && c.sha === sha, 'This failure was already sent with your message.');
}

/**
 * Cards `which` picks no longer apply, by no doing of yours. One as it fired,
 * or folded with its text already in the message box, goes. One you edited is
 * your text (REGRESSIONS: defaults that lose work): it stays, with `note` on
 * it saying why, until you Send or Skip it.
 */
export function retireTriggerCards(taskId: number, which: (c: TriggerCard) => boolean, note: string): void {
  const e = entryOf(taskId);
  const hit = e.cards.filter(which);
  if (hit.length === 0) return;
  const keep = (c: TriggerCard) => !untouched(c) && !c.inBox;
  if (hit.every((c) => keep(c) && c.stale === note)) return;
  const cards = e.cards.flatMap((c) => (!which(c) ? [c] : keep(c) ? [{ ...c, stale: note }] : []));
  put(taskId, { ...e, cards });
}

/** The cards `which` picks go: an action they offered was taken elsewhere (a merge from the task bar). */
export function resolveTriggerCards(taskId: number, which: (c: TriggerCard) => boolean): void {
  const e = entryOf(taskId);
  if (!e.cards.some(which)) return;
  put(taskId, { ...e, cards: e.cards.filter((c) => !which(c)) });
}

/** Everything kept for the task goes: it was archived or deleted. */
export function forgetTriggers(taskId: number): void {
  bumpGen(taskId);
  if (current().has(taskId)) put(taskId, { cards: [] });
}

/**
 * Keep only these tasks' (the live ones), and whatever was written since
 * `readStartedAt`: a read of the task list cannot speak for a task newer than
 * itself (REGRESSIONS: a cleanup judged a task newer than its own read).
 */
export function keepTriggersFor(taskIds: Iterable<number>, readStartedAt = Infinity): void {
  const keep = new Set(taskIds);
  const prev = current();
  const kept = [...prev].filter(([id, e]) => keep.has(id) || (e.savedAt ?? 0) >= readStartedAt);
  if (kept.length === prev.size) return;
  for (const [id] of prev) if (!kept.some(([k]) => k === id)) bumpGen(id);
  commit(new Map(kept));
}

/** Bumped each time a task's triggers are forgotten: work started before it must not write after. */
const gens = new Map<number, number>();
function bumpGen(taskId: number): void {
  gens.set(taskId, (gens.get(taskId) ?? 0) + 1);
}

/** The task's forget count, for work that lands later (a review's threads). */
export function triggerGen(taskId: number): number {
  return gens.get(taskId) ?? 0;
}

export function onTriggerChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** A task's waiting cards, kept current. */
export function useTriggerCards(taskId: number | null): readonly TriggerCard[] {
  const read = () => (taskId === null ? NO_CARDS : triggerCardsOf(taskId));
  return useSyncExternalStore(onTriggerChange, read, read);
}

/** Re-render on any change here. */
export function useTriggerVersion(): number {
  return useSyncExternalStore(onTriggerChange, () => version);
}

// ---------------------------------------------------------------------------
// Suggest: Squash and Merge… opens the task bar's own dialog
// ---------------------------------------------------------------------------

type MergeListener = (taskId: number) => boolean | void;
const mergeListeners = new Set<MergeListener>();

/**
 * Ask the task bar to open its Squash and Merge dialog for this task (#448).
 * Opening is all: the dialog asks before anything merges. False when no task
 * bar took it (not this task's, or the PR is not mergeable now).
 */
export function requestTriggerMerge(taskId: number): boolean {
  let taken = false;
  for (const cb of [...mergeListeners]) {
    try {
      if (cb(taskId) === true) taken = true;
    } catch {
      /* a broken listener is not the card's problem */
    }
  }
  return taken;
}

export function onTriggerMergeRequest(cb: MergeListener): () => void {
  mergeListeners.add(cb);
  return () => {
    mergeListeners.delete(cb);
  };
}

/** Test seam: forget what is in memory, so the next read comes from storage. */
export function __resetTriggerStore(): void {
  cancelEditWrite();
  state = null;
  listeners.clear();
  mergeListeners.clear();
  version += 1;
}
