/**
 * src/db/sessions.ts
 *
 * Browsing previously-captured Claude Code sessions, so one can be reopened
 * with `claude --resume <session-id>`.
 *
 * This is a browsing problem: 115 sessions over 41.8 days on this machine, and
 * growing every time the user works. Everything here aggregates IN SQLITE --
 * pulling 38k+ message bodies into JS to count them would make the browser
 * slower the more history there is to browse, which is backwards.
 */

import type { Message } from '../types';
import { getDb, toFtsQuery } from './index';

export interface PastSession {
  sessionId: string;
  cwd: string | null;
  /** From an `ai-title` / `custom-title` line, else null. */
  title: string | null;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  /** Set when a task already adopted this session: the UI says "open", not "resume". */
  taskId: number | null;
  /**
   * Always null from this layer. Whether the recorded cwd still exists is a
   * filesystem question, and the db module has no business touching the disk
   * -- it would also make every list call N stat syscalls deep. The UI checks
   * the handful of rows it actually renders and fills this in.
   */
  cwdExists: boolean | null;
}

interface SessionRow {
  session_id: string;
  cwd: string | null;
  title: string | null;
  first_ts: number;
  last_ts: number;
  message_count: number;
  task_id: number | null;
}

const DEFAULT_LIMIT = 200;

export async function listPastSessions(opts?: {
  /** Full-text across message bodies. Sessions CONTAINING a match are listed. */
  query?: string;
  cwd?: string;
  /** Only sessions with activity at or after this timestamp. */
  since?: number;
  limit?: number;
}): Promise<PastSession[]> {
  const binds: unknown[] = [];
  const where: string[] = [];
  const having: string[] = [];

  if (opts?.query !== undefined && opts.query.trim().length > 0) {
    // Reuse the db layer's FTS escaping rather than writing a second one: a
    // stray apostrophe or colon from a search box otherwise raises
    // "fts5: syntax error" instead of returning no results.
    const match = toFtsQuery(opts.query);
    if (match === null) return []; // nothing searchable in the query
    binds.push(match);
    // Filter which SESSIONS are listed, not which of their rows are counted,
    // so messageCount stays the session's real length rather than its number
    // of hits.
    where.push(`m.session_id IN (
      SELECT DISTINCT m2.session_id
        FROM messages_fts
        JOIN messages m2 ON m2.id = messages_fts.rowid
       WHERE messages_fts MATCH $${binds.length}
    )`);
  }

  if (opts?.cwd !== undefined) {
    binds.push(opts.cwd);
    where.push(`tf.cwd = $${binds.length}`);
  }

  if (opts?.since !== undefined) {
    binds.push(opts.since);
    having.push(`MAX(m.ts) >= $${binds.length}`);
  }

  binds.push(Math.max(1, opts?.limit ?? DEFAULT_LIMIT));

  const db = await getDb();
  const rows = await db.select<SessionRow[]>(
    `SELECT m.session_id                AS session_id,
            tf.cwd                      AS cwd,
            tf.title                    AS title,
            MIN(m.ts)                   AS first_ts,
            MAX(m.ts)                   AS last_ts,
            COUNT(*)                    AS message_count,
            MAX(m.task_id)              AS task_id
       FROM messages m
       LEFT JOIN (
         -- One row per session. A session id can appear in more than one
         -- transcript file (resume, compaction), and joining transcript_files
         -- directly would multiply every session's message count by the number
         -- of files carrying it. The single MAX() makes SQLite take the bare
         -- columns from the most recently updated of them.
         SELECT session_id, MAX(updated_at) AS newest, cwd, title
           FROM transcript_files
          GROUP BY session_id
       ) tf ON tf.session_id = m.session_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY m.session_id
      ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
      ORDER BY last_ts DESC
      LIMIT $${binds.length}`,
    binds,
  );

  return rows.map(toPastSession);
}

function toPastSession(r: SessionRow): PastSession {
  return {
    sessionId: r.session_id,
    cwd: r.cwd,
    title: r.title,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    messageCount: r.message_count,
    // MAX() skips NULLs, so this is "some row of this session was adopted",
    // which is exactly the question the UI is asking.
    taskId: r.task_id,
    cwdExists: null,
  };
}

/**
 * Best-effort display label for a session that has no recorded title.
 *
 * Pure, and exported so the UI does not invent its own fallback: the first
 * user message, collapsed to one line. This is the thing `transcript_files.title`
 * exists to avoid needing, so it is only a last resort.
 */
export function fallbackSessionLabel(
  firstUserMessage: Pick<Message, 'body'> | null,
  maxChars = 60,
): string | null {
  const body = firstUserMessage?.body;
  if (typeof body !== 'string') return null;
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return null;
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1)}…`;
}

/** The distinct cwds that have captured sessions, newest activity first. */
export async function listSessionCwds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ cwd: string | null }[]>(
    `SELECT cwd, MAX(updated_at) AS newest
       FROM transcript_files
      WHERE cwd IS NOT NULL
      GROUP BY cwd
      ORDER BY newest DESC`,
  );
  return rows.map((r) => r.cwd).filter((c): c is string => c !== null);
}
