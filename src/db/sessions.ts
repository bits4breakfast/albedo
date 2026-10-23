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
   * First prompt the human actually typed, one line, truncated. Main thread
   * only: a subagent's task prompt is typed by Claude, not the human (#74).
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
  /** Across the whole session, subagents included: their activity is its activity. */
  firstTs: number;
  lastTs: number;
  /** Main-thread rows only: the length of the conversation a resume reopens. */
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
 * A `messages` row from the main thread, not from one of its subagents.
 *
 * Subagent rows carry the PARENT's session_id (migration 5) and restart `seq`
 * at 0 in each subagent file, so "first" or "latest by seq" across a whole
 * session can land on a subagent's row: a review subagent's `seq 0` prompt
 * outranked the conversation's real opener at `seq 400` (#74).
 *
 * Written as COALESCE rather than `agent_id IS NULL` so it matches the unique
 * index `(session_id, COALESCE(agent_id, ''), seq)` exactly: SQLite then walks
 * one session's main thread in seq order and stops at the first hit. The
 * `IS NULL` form picks `messages_agent` instead and sorts every candidate row.
 */
function mainThreadSql(alias: string): string {
  return `COALESCE(${alias}.agent_id, '') = ''`;
}

/**
 * A `transcript_files` row for the main transcript, not a subagent file.
 *
 * Subagent files (`<projectDir>/<session>/subagents/<agent>.jsonl`) are
 * registered under the parent's session id too and never carry a title (27
 * of 27 on the live database: the ai-title is written to the main file). Their
 * cwd is the subagent's own, which may be a worktree the session never ran in.
 */
const MAIN_TRANSCRIPT_SQL = `path NOT LIKE '%/' || session_id || '/subagents/%'`;

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
  // Which columns see subagent rows is decided per column:
  //   main thread only -- branch, first_prompt, message_count, and cwd/title
  //     through tf: they describe the conversation `--resume` reopens, and a
  //     subagent's seq, branch, prompt and transcript file are not part of it.
  //   whole session -- top_files, first_ts/last_ts, task_id and the search
  //     filter: a subagent's edits are the session's work (an orchestrating
  //     session may write nothing itself), its activity is the session's
  //     activity, and a match inside it is a match in the session.
  const rows = await db.select<SessionRow[]>(
    `SELECT m.session_id                AS session_id,
            tf.cwd                      AS cwd,
            -- '' is the "scanned, no title" sentinel, never a title.
            NULLIF(tf.title, '')        AS title,
            -- Latest non-null branch on the main thread: the branch the
            -- session ENDED on. A subagent run in a worktree records that
            -- worktree's branch, and its restarted seq makes "latest" meaningless.
            (SELECT ${gitBranchSqlExpr('x.raw_json')}
               FROM messages x
              WHERE x.session_id = m.session_id AND ${mainThreadSql('x')}
                AND ${gitBranchSqlExpr('x.raw_json')} IS NOT NULL
              ORDER BY x.seq DESC LIMIT 1)  AS branch,
            (SELECT SUBSTR(REPLACE(REPLACE(y.body, char(10), ' '), char(9), ' '), 1, ${PROMPT_CHARS})
               FROM messages y
              WHERE y.session_id = m.session_id AND ${mainThreadSql('y')}
                AND y.role = 'user'
                AND ${prosePromptSqlPredicate('y.body')}
              ORDER BY y.seq ASC LIMIT 1)   AS first_prompt,
            -- count and path per line, parsed and re-sorted in TypeScript so
            -- the result never depends on GROUP_CONCAT preserving subquery
            -- order, which SQLite does not guarantee. Subagents included.
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
            -- The resumed conversation's length. Subagent transcripts are
            -- often longer than the conversation that started them.
            COUNT(*) FILTER (WHERE ${mainThreadSql('m')}) AS message_count,
            MAX(live.id)                AS task_id
       FROM messages m
       -- An archived task is no task to open: its session resumes afresh.
       LEFT JOIN tasks live ON live.id = m.task_id AND live.status != 'archived'
       LEFT JOIN (
         -- One row per session. A session id can appear in more than one
         -- transcript file (resume, compaction), and joining transcript_files
         -- directly would multiply every session's message count by the number
         -- of files carrying it. The single MAX() makes SQLite take the bare
         -- columns from the most recently updated of them -- among the main
         -- transcripts only, or a subagent file written last supplied its
         -- empty title and its own cwd.
         SELECT session_id, MAX(updated_at) AS newest, cwd, title
           FROM transcript_files
          WHERE ${MAIN_TRANSCRIPT_SQL}
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

/**
 * The distinct cwds that have captured sessions, newest activity first.
 *
 * Main transcripts only, matching the cwd `listPastSessions` reports: a cwd
 * only a subagent ran in would be offered as a filter that lists nothing.
 */
export async function listSessionCwds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ cwd: string | null }[]>(
    `SELECT cwd, MAX(updated_at) AS newest
       FROM transcript_files
      WHERE cwd IS NOT NULL AND ${MAIN_TRANSCRIPT_SQL}
      GROUP BY cwd
      ORDER BY newest DESC`,
  );
  return rows.map((r) => r.cwd).filter((c): c is string => c !== null);
}
