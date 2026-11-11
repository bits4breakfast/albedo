/**
 * Comments on a waiting preview (#348), not sent yet, and the answer they make.
 *
 * Kept per waiting call (its request id), so a comment can only go with the
 * call it was left on, and in memory only: they survive switching tasks and
 * projects, and nothing longer is needed -- a call cannot outlive the app run
 * (previewGate.ts closes earlier ones at launch). They leave when the call
 * stops waiting, however it ends, or one by one (✕).
 *
 * A comment belongs to the version that was shown when it was written. A pin
 * is numbered within that version, and says where it sits as a percentage of
 * the page, across and down: Albedo cannot look inside the sandboxed page, so
 * it cannot name the element under the pin.
 *
 * Nothing here sends anything. The card composes the answer and sends it on a
 * click.
 */

import { useSyncExternalStore } from 'react';
import { onPreviewChange, isPreviewWaiting } from '../../capture/previewGate';

export interface PreviewPin {
  /** 1, 2, ... within its version. */
  n: number;
  /** Where on the page, in percent of its width and height. */
  x: number;
  y: number;
}

export interface PreviewComment {
  id: string;
  version: number;
  pin: PreviewPin | null;
  text: string;
  addedAt: number;
}

type Store = ReadonlyMap<string, readonly PreviewComment[]>;

let store: Store = new Map();
const subscribers = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function commit(next: Store): void {
  store = next;
  for (const cb of [...subscribers]) cb();
}

/** A call that stopped waiting takes its comments with it. */
function sweep(): void {
  const kept = [...store].filter(([key]) => isPreviewWaiting(key));
  if (kept.length !== store.size) commit(new Map(kept));
}

const NONE: readonly PreviewComment[] = [];

export function previewCommentsOf(requestId: string | null): readonly PreviewComment[] {
  unsubscribe ??= onPreviewChange(sweep);
  return requestId === null ? NONE : (store.get(requestId) ?? NONE);
}

/** The next pin number on `version`. */
export function nextPin(comments: readonly PreviewComment[], version: number): number {
  return comments.filter((c) => c.version === version && c.pin !== null).reduce((n, c) => Math.max(n, c.pin!.n), 0) + 1;
}

export function addPreviewComment(
  requestId: string,
  c: { version: number; pin: { x: number; y: number } | null; text: string },
  now = Date.now(),
): PreviewComment | null {
  const text = c.text.trim();
  if (text.length === 0) return null;
  const list = previewCommentsOf(requestId);
  const pin = c.pin ? { n: nextPin(list, c.version), x: clampPct(c.pin.x), y: clampPct(c.pin.y) } : null;
  const comment: PreviewComment = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    version: c.version,
    pin,
    text,
    addedAt: now,
  };
  const next = new Map(store);
  next.set(requestId, [...list, comment]);
  commit(next);
  return comment;
}

export function removePreviewComment(requestId: string, id: string): void {
  const list = previewCommentsOf(requestId);
  if (!list.some((c) => c.id === id)) return;
  const next = new Map(store);
  const rest = list.filter((c) => c.id !== id);
  if (rest.length === 0) next.delete(requestId);
  else next.set(requestId, rest);
  commit(next);
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** One call's comments, re-read on every change. */
export function usePreviewComments(requestId: string | null): readonly PreviewComment[] {
  const read = () => previewCommentsOf(requestId);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam. */
export function __resetPreviewComments(): void {
  store = new Map();
  subscribers.clear();
  unsubscribe?.();
  unsubscribe = null;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** "about 62% across and 18% down the page". */
export function pinPlace(pin: PreviewPin): string {
  return `about ${pin.x}% across and ${pin.y}% down the page`;
}

/**
 * In the order they are listed and sent: by version, newest first; within one,
 * pins by number, then plain comments as written.
 */
export function inAnswerOrder(comments: readonly PreviewComment[]): PreviewComment[] {
  return [...comments].sort(
    (a, b) =>
      b.version - a.version ||
      (a.pin ? 0 : 1) - (b.pin ? 0 : 1) ||
      (a.pin && b.pin ? a.pin.n - b.pin.n : 0) ||
      a.addedAt - b.addedAt,
  );
}

function body(text: string): string {
  const [first = '', ...rest] = text.trim().split('\n');
  return [first.trimEnd(), ...rest.map((l) => `   ${l.trimEnd()}`)].join('\n');
}

/**
 * The answer "Send N Comments" sends: "changes requested on v2:" and one
 * numbered item per comment. A pinned one names its pin and where it sits.
 * Comments on more than one version say which, item by item.
 */
export function composeChanges(comments: readonly PreviewComment[]): string {
  const ordered = inAnswerOrder(comments);
  const versions = [...new Set(ordered.map((c) => c.version))];
  const several = versions.length > 1;
  const head = `changes requested on ${versions.map((v) => `v${v}`).join(' and ')}:`;
  const items = ordered.map((c, i) => {
    const where = [several ? `on v${c.version}` : null, c.pin ? `pin ${c.pin.n}, ${pinPlace(c.pin)}` : null].filter(
      (s): s is string => s !== null,
    );
    return `${i + 1}. ${where.length > 0 ? `(${where.join(', ')}) ` : ''}${body(c.text)}`;
  });
  return [head, ...items].join('\n');
}

/**
 * The answer Approve sends: "approved", or, when an earlier version than the
 * one waiting is on screen, which version that is.
 */
export function composeApproval(shown: number, waiting: number): string {
  return shown === waiting ? 'approved' : `approved v${shown}, not v${waiting}: build v${shown} as shown`;
}
