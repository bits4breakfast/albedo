/**
 * Whether Remote Control is on for a session, from the transcript only (#343).
 *
 * Two facts say so, both read by adapter.ts (where the format lives):
 *  - the "Remote Control is active" row `/remote-control` writes, stored as a
 *    `system` row (`remoteControlLineSince`, db);
 *  - the `remote_session_change` attachment Claude Code writes with the first
 *    prompt of each process, and with the first prompt after the link changes:
 *    the link, or null when it is off (`RemoteSessionFact`). A session resumed
 *    with Remote Control on writes only this one.
 *
 * The attachment is a bookkeeping line and is never stored as a row, so its
 * newest per session is held here in memory, fed by the capture watcher as it
 * ingests each chunk and, the first time it touches a file this run, from the
 * file's recent history (watcher.ts, as the queue is). Only facts written
 * since the task's pty was spawned count, which are always read live.
 */

import type { RemoteSessionFact } from './adapter';
import { remoteControlLineSince } from '../db';

const latest = new Map<string, RemoteSessionFact>();
const listeners = new Set<(sessionId: string) => void>();

/** Called by the watcher with the facts in each chunk, in file order. */
export function recordRemoteSessions(facts: readonly RemoteSessionFact[]): void {
  const touched = new Set<string>();
  for (const f of facts) {
    const was = latest.get(f.sessionId);
    if (was && was.ts > f.ts) continue;
    if (was && was.ts === f.ts && was.url === f.url) continue;
    latest.set(f.sessionId, f);
    touched.add(f.sessionId);
  }
  for (const sid of touched) for (const l of [...listeners]) l(sid);
}

/** The newest fact for the session written at or after `sinceTs`, or null. */
export function remoteSessionSince(sessionId: string, sinceTs: number): RemoteSessionFact | null {
  const f = latest.get(sessionId);
  return f && f.ts >= sinceTs ? f : null;
}

/** Subscribe to new facts; the callback gets the session. */
export function onRemoteSessionChange(cb: (sessionId: string) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * The session's claude.ai link while Remote Control is on, judged from what
 * was written at or after `sinceTs` (the pty's spawn), else null. The newer of
 * the two facts decides: an attachment saying off after an "is active" row
 * means it went off; an "is active" row after an attachment saying off means
 * it came on. With neither, it is off as far as anything written says.
 */
export async function remoteControlSince(sessionId: string, sinceTs: number): Promise<string | null> {
  const fact = remoteSessionSince(sessionId, sinceTs);
  const line = await remoteControlLineSince(sessionId, sinceTs);
  if (fact !== null && (line === null || fact.ts > line.ts)) return fact.url;
  return line?.url ?? null;
}

/** Test seam. */
export function __resetRemoteSessions(): void {
  latest.clear();
  listeners.clear();
}
