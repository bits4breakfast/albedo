/**
 * The permission mode each session was last seen in, for the composer's label.
 *
 * Fed by the capture watcher with what `permissionModesIn` (adapter.ts, where
 * the format lives) finds in each chunk it ingests. Held in memory only: it is
 * one word per session, and after a restart `loadPermissionMode` recovers it
 * from the session's stored rows the first time the label asks.
 *
 * It is the mode as of the last prompt sent, not as of now: Claude Code writes
 * it with each prompt (see `permissionModeOf`), so ⇧⇥ in the terminal shows up
 * here with the next message.
 */

import { permissionModeOf, type PermissionMode } from './adapter';
import { getMessages } from '../db';

/** Present: seen. Null: seen, but a mode this build does not know. */
const modes = new Map<string, PermissionMode | null>();
/** Sessions `loadPermissionMode` has already looked up this run. */
const tried = new Set<string>();
const listeners = new Set<(sessionId: string) => void>();

/** Rows `loadPermissionMode` looks back through for the last prompt sent. */
export const PERMISSION_MODE_LOOKBACK_ROWS = 200;

/** Apply what a chunk recorded. Returns the sessions whose mode changed. */
export function applyPermissionModes(
  state: Map<string, PermissionMode | null>,
  seen: ReadonlyMap<string, PermissionMode | null>,
): string[] {
  const changed: string[] = [];
  for (const [sessionId, mode] of seen) {
    if (state.has(sessionId) && state.get(sessionId) === mode) continue;
    state.set(sessionId, mode);
    changed.push(sessionId);
  }
  return changed;
}

/** Called by the watcher with the latest mode per session in each chunk. */
export function recordPermissionModes(seen: ReadonlyMap<string, PermissionMode | null>): void {
  if (seen.size === 0) return;
  for (const sid of applyPermissionModes(modes, seen)) for (const l of listeners) l(sid);
}

/** The session's last known mode, or null when it is unknown. */
export function permissionModeFor(sessionId: string): PermissionMode | null {
  return modes.get(sessionId) ?? null;
}

/**
 * The newest mode among stored rows (ascending, as getMessages returns them),
 * or undefined if none records one.
 */
export function lastPermissionModeIn(rows: readonly { rawJson: string }[]): PermissionMode | null | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const seen = permissionModeOf(rows[i]?.rawJson ?? '');
    if (seen) return seen.mode;
  }
  return undefined;
}

/**
 * Recover a session's mode from its stored rows, once per session per run:
 * after a restart nothing has been seen live, and a session that sends nothing
 * would otherwise show no mode at all. Only the `user` lines of prompts carry
 * it in the database (`permission-mode` lines are bookkeeping and never stored),
 * and only the last PERMISSION_MODE_LOOKBACK_ROWS are read: a session whose last
 * prompt is further back than that stays unknown until the next one.
 *
 * Whatever the watcher records meanwhile is newer, so it wins.
 */
export async function loadPermissionMode(sessionId: string): Promise<void> {
  if (modes.has(sessionId) || tried.has(sessionId)) return;
  tried.add(sessionId);
  try {
    const rows = await getMessages({ sessionId, parentOnly: true, limit: PERMISSION_MODE_LOOKBACK_ROWS });
    const mode = lastPermissionModeIn(rows);
    if (mode !== undefined && !modes.has(sessionId)) recordPermissionModes(new Map([[sessionId, mode]]));
  } catch {
    /* unknown, which shows nothing */
  }
}

/** Subscribe to changes; the callback gets the session that changed. */
export function onPermissionModeChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
