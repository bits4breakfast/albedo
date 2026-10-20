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
import { gitBranchSqlExpr, prosePromptSqlPredicate } from '../capture/adapter';
import { WRITING_TOOLS } from './touched';
import { getDb, toFtsQuery } from './index';

export interface PastSession {
  sessionId: string;
  cwd: string | null;
  /** From an `ai-title` / `custom-title` line, else null. 95/115 coverage. */
  title: string | null;
  /**
   * Git branch the session ENDED on, from the line envelope. A session can
   * switch branches mid-flight, so the latest non-null wins.
   *
   * The strongest single discriminator after the title: cwd separates the
   * user's 115 sessions into only 13 groups, branch into 50.
   */
  branch: string | null;
  /**
   * First prompt the human actually typed, one line, truncated.
   *
   * Skips Claude Code's injected openers (slash-command envelopes, system
   * reminders): 75 of 115 sessions begin with one, and taking the naive first
   * user row gives 43 distinct labels across 115 sessions. Skipping them gives
   * 79 distinct across 97 -- which is what makes the 18 sessions sharing the
   * branch `master` tellable apart.
   */
  firstPrompt: string | null;
  /**
   * Most-touched file BASENAMES, most-touched first.
   *
   * Basenames, not paths: full paths would reintroduce exactly the problem the
   * cwd column had, where 115 rows showed the same string. Narrow but sharp --
   * only 36 of the user's 115 sessions wrote a file at all (most are research
   * or MCP work), but among those 36 the top-3 signature is unique 36 times
   * out of 36. Empty array when the session wrote nothing.
   */
  topFiles: string[];
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
  branch: string | null;
  first_prompt: string | null;
  top_files: string | null;
  first_ts: number;
  last_ts: number;
  message_count: number;
  task_id: number | null;
}

const DEFAULT_LIMIT = 200;

/** Characters of opening prompt kept for the browser row. */
export const PROMPT_CHARS = 160;

/** How many distinct paths to pull before collapsing to basenames. */
const TOP_FILES_SCAN = 8;

/** How many basenames to show. */
export const TOP_FILES_SHOWN = 3;

/**
 * `count<TAB>path` lines into basenames, most-touched first.
 *
 * Distinct paths are counted separately in SQL (so `src/a.ts` and `test/a.ts`
 * are two files), then collapsed to basenames here, keeping the first
 * occurrence. That is why more paths are fetched than are shown.
 */
function parseTopFiles(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.length === 0) return [];
  const rows: { count: number; path: string }[] = [];
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const count = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (!Number.isFinite(count) || path.length === 0) continue;
    rows.push({ count, path });
  }
  rows.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const { path } of rows) {
    const base = path.slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1);
    if (base.length === 0 || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
    if (out.length === TOP_FILES_SHOWN) break;
  }
  return out;
}

/** Collapse runs of whitespace SUBSTR may have left, and drop empties. */
function normalisePrompt(raw: string | null | undefined): string | null {
  // Defensive against a missing column as well as a NULL one: a mapper that
  // throws on absent data turns a schema mismatch into an unhandled crash.
  if (raw === null || raw === undefined) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

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
            -- Latest non-null branch. The unique index on (session_id, seq)
            -- serves both the filter and the ordering, so this stops at the
            -- newest row rather than scanning the session.
            (SELECT ${gitBranchSqlExpr('x.raw_json')}
               FROM messages x
              WHERE x.session_id = m.session_id
                AND ${gitBranchSqlExpr('x.raw_json')} IS NOT NULL
              ORDER BY x.seq DESC LIMIT 1)  AS branch,
            (SELECT SUBSTR(REPLACE(REPLACE(y.body, char(10), ' '), char(9), ' '), 1, ${PROMPT_CHARS})
               FROM messages y
              WHERE y.session_id = m.session_id AND y.role = 'user'
                AND ${prosePromptSqlPredicate('y.body')}
              ORDER BY y.seq ASC LIMIT 1)   AS first_prompt,
            -- count and path per line, parsed and re-sorted in TypeScript so
            -- the result never depends on GROUP_CONCAT preserving subquery
            -- order, which SQLite does not guarantee.
            (SELECT GROUP_CONCAT(c || char(9) || p, char(10)) FROM (
               SELECT t.target_path AS p, COUNT(*) AS c
                 FROM messages t
                WHERE t.session_id = m.session_id
                  AND t.role = 'tool_use'
                  AND t.tool_name IN (${WRITING_TOOLS.map((t) => `'${t}'`).join(', ')})
                  AND t.target_path IS NOT NULL AND TRIM(t.target_path) != ''
                GROUP BY t.target_path
                ORDER BY c DESC, p ASC
                LIMIT ${TOP_FILES_SCAN}
             ))                           AS top_files,
            MIN(m.ts)                   AS first_ts,
            MAX(m.ts)                   AS last_ts,
            COUNT(*)                    AS message_count,
            MAX(live.id)                AS task_id
       FROM messages m
       -- An archived task is no task to open: its session resumes afresh.
       LEFT JOIN tasks live ON live.id = m.task_id AND live.status != 'archived'
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
    branch: r.branch ?? null,
    firstPrompt: normalisePrompt(r.first_prompt),
    topFiles: parseTopFiles(r.top_files),
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    messageCount: r.message_count,
    // MAX() skips NULLs, so this is "some row of this session is held by a
    // live task", which is exactly the question the UI is asking.
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
