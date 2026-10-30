/**
 * src/db/subagents.ts — what a session has running in parallel.
 *
 * A session can fan out to several subagents at once, and until you can see
 * them the parent transcript just goes quiet: the `Task` chip sits pending and
 * nothing says whether three agents are working or one is stuck on a
 * permission prompt. That is the same "which one is waiting on me" question
 * the task list answers, one level down.
 *
 * ## This is only possible because of migration 5
 *
 * Subagent rows carry the PARENT's `session_id` (Claude Code writes them that
 * way) and a file-local `seq`, so before `agent_id` existed they collided with
 * the parent and with each other and 89% of them were dropped by
 * `INSERT OR IGNORE`. `agent_id` is what makes "group this session's rows by
 * the agent that wrote them" a query rather than a guess.
 *
 * ## Labels come from the transcript, not from `.meta.json`
 *
 * Claude Code writes an `agent-<id>.meta.json` beside each subagent transcript
 * carrying `agentType`, `description` and the `toolUseId` that spawned it, and
 * it is tempting. It is a second on-disk format, and CLAUDE.md keeps format
 * knowledge in one file -- adding a second owner to save a string is a bad
 * trade. The subagent's own first prompt is already captured, already behind
 * the adapter, and says what the agent was asked to do.
 */

import type { Message, TaskStatus } from '../types';
import { getDb } from './index';
import { deriveStatus, statusExpiresAt } from '../capture/status';
import { subagentMarkSqlPredicate, subagentMarksOf } from '../capture/adapter';

/** One subagent run under a parent session. */
export interface SubagentRun {
  /** The id `<agent-message from="...">` quotes in the parent transcript. */
  agentId: string;
  /** First line of its opening prompt. Null when it has not spoken yet. */
  label: string | null;
  /**
   * Derived the same way a task's is, from rows only -- never from the pty --
   * except that the parent's notification that the agent stopped settles it
   * (see `buildRuns`).
   */
  status: TaskStatus;
  /**
   * Stopped, with background work of its own still running: it may resume on
   * its own when that work reports (#139). `status` is `idle` then: not at
   * work, not live, and not counted as running anywhere.
   */
  waiting: boolean;
  firstTs: number;
  lastTs: number;
  /**
   * When the current run began: its first row, or the latest time it was
   * resumed -- by `SendMessage`, or on its own after it stopped. An agent
   * resumed for two weeks has been at it since the last resume, not since
   * day one.
   */
  runStartTs: number;
  messages: number;
  /**
   * When `status` would change with no new row (a recency window closing),
   * or null. Nothing else re-asks, so the strip re-reads then.
   */
  expiresAt: number | null;
}

/**
 * Rows to pull per session for status. `deriveStatus` only needs the tail --
 * an unanswered trailing `tool_use` and the last assistant line -- so this is
 * a window, not a full history, and it is ONE query for every agent rather
 * than one per agent.
 */
const TAIL_ROWS = 400;

/** Characters of the opening line kept as a label. See `buildRuns`. */
const LABEL_MAX = 280;

/**
 * Parent rows read for resumes and stops, newest first. Only rows naming one
 * of this session's agents are read, so shells' notifications do not crowd
 * them out; an agent whose marks fall past this is read from its own rows,
 * as before #139.
 */
const MARK_ROWS = 200;

interface AggRow {
  agent_id: string;
  n: number;
  first_ts: number;
  last_ts: number;
}

interface TailRow {
  agent_id: string;
  seq: number;
  role: string;
  raw_json: string;
  ts: number;
  body: string | null;
}

/** Aggregates per agent: one row each, cheap on a large session. */
export const SUBAGENT_AGG_SQL = `
  SELECT agent_id, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM messages
   WHERE session_id = $1 AND agent_id IS NOT NULL
   GROUP BY agent_id
   ORDER BY last_ts DESC`;

/**
 * The opening prompt of every agent, as its own query.
 *
 * NOT taken from the tail window. The tail is one capped, ts-DESC read shared
 * by every agent, so on a session that spawned 80 of them the opening prompts
 * fall outside it entirely and all but a couple of agents render unlabelled --
 * measured on the live database before this existed. A window function gets
 * the first row per agent directly, and it is one query regardless of how many
 * agents there are.
 */
export const SUBAGENT_OPENING_SQL = `
  SELECT agent_id, body FROM (
    SELECT agent_id, body,
           ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts, seq) AS rn
      FROM messages
     WHERE session_id = $1 AND agent_id IS NOT NULL AND role = 'user'
  ) WHERE rn = 1`;

/**
 * The newest rows across every agent of a session, for status derivation.
 *
 * Ordered by ts DESC and capped: a session with a dozen agents and 50k rows
 * must not read them all to answer "is anything blocked".
 */
export const SUBAGENT_TAIL_SQL = `
  SELECT agent_id, seq, role, raw_json, ts, body
    FROM messages
   WHERE session_id = $1 AND agent_id IS NOT NULL
   ORDER BY ts DESC
   LIMIT $2`;

/**
 * Rows that may resume or stop one of this session's agents (`SendMessage`
 * results, `<task-notification>`s), newest first. What they say is read by
 * the adapter (`subagentMarksOf`); this only narrows them to rows mentioning
 * an agent id this session has. `$3` is the session id again: each
 * parameter is bound once, so nothing depends on how a driver treats a
 * repeated one.
 */
export const SUBAGENT_MARKS_SQL = `
  SELECT m.ts, m.seq, m.role, m.raw_json
    FROM messages m
   WHERE m.session_id = $1
     AND ${subagentMarkSqlPredicate()}
     AND EXISTS (
       SELECT 1 FROM (SELECT DISTINCT agent_id FROM messages WHERE session_id = $3 AND agent_id IS NOT NULL) a
        WHERE instr(m.raw_json, a.agent_id) > 0)
   ORDER BY m.ts DESC
   LIMIT $2`;

/** The first row an agent wrote after a moment: where a run it began on its own starts. */
export const SUBAGENT_FIRST_AFTER_SQL = `
  SELECT MIN(ts) AS ts FROM messages
   WHERE session_id = $1 AND agent_id = $2 AND ts > $3`;

interface MarkRow {
  ts: number;
  seq: number;
  role: string;
  raw_json: string;
}

/** What the parent's rows say about one agent's runs. */
export interface AgentMarks {
  /** The latest `SendMessage` that resumed it. */
  resumedAt: number | null;
  /** Each notification that it stopped, oldest first. */
  stops: { ts: number; waiting: boolean }[];
}

/** Resumes and stops per agent id, from {@link SUBAGENT_MARKS_SQL}'s rows. */
export function marksByAgent(rows: readonly MarkRow[]): Map<string, AgentMarks> {
  const out = new Map<string, AgentMarks>();
  const sorted = [...rows].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  for (const r of sorted) {
    for (const mark of subagentMarksOf({ role: r.role as Message['role'], rawJson: r.raw_json })) {
      const m = out.get(mark.agentId) ?? { resumedAt: null, stops: [] };
      if (mark.mark === 'resumed') m.resumedAt = Math.max(m.resumedAt ?? r.ts, r.ts);
      else m.stops.push({ ts: r.ts, waiting: mark.waiting });
      out.set(mark.agentId, m);
    }
  }
  return out;
}

/**
 * The stop after which the agent went on by itself, with no `SendMessage`:
 * the latest stop older than its newest row, unless a resume came after it.
 * Its current run starts at its first row after that stop
 * ({@link SUBAGENT_FIRST_AFTER_SQL}). Null when there is nothing to look up.
 */
export function selfResumeAfter(marks: AgentMarks | undefined, lastTs: number): number | null {
  if (marks === undefined) return null;
  let cut: number | null = null;
  for (const s of marks.stops) if (s.ts < lastTs && (cut === null || s.ts > cut)) cut = s.ts;
  if (cut === null || (marks.resumedAt !== null && marks.resumedAt >= cut)) return null;
  return cut;
}

/** First non-empty line of the opening prompt, trimmed for a chip. */
export function labelFrom(body: string | null, max = 60): string | null {
  if (typeof body !== 'string') return null;
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Pure, and exported, so the grouping and status derivation are testable
 * without a database -- the same split `touched.ts` uses.
 */
export function buildRuns(
  agg: AggRow[],
  tail: TailRow[],
  openings: { agent_id: string; body: string | null }[] = [],
  runs: {
    /** From {@link marksByAgent}. */
    marks?: ReadonlyMap<string, AgentMarks>;
    /** Per agent, its first row after {@link selfResumeAfter}'s stop. */
    selfResumedAt?: ReadonlyMap<string, number>;
    now?: number;
  } = {},
): SubagentRun[] {
  const now = runs.now ?? Date.now();
  const openingBy = new Map(openings.map((o) => [o.agent_id, o.body]));
  const byAgent = new Map<string, Message[]>();
  for (const r of tail) {
    const rows = byAgent.get(r.agent_id) ?? [];
    rows.push({
      id: 0,
      taskId: null,
      sessionId: '',
      seq: r.seq,
      role: r.role as Message['role'],
      toolName: null,
      targetPath: null,
      body: r.body,
      rawJson: r.raw_json,
      agentId: r.agent_id,
      ts: r.ts,
    });
    byAgent.set(r.agent_id, rows);
  }

  return agg.map((a) => {
    const rows = byAgent.get(a.agent_id) ?? [];
    /*
     * Prefer the dedicated opening query; fall back to the oldest row we
     * happen to hold. The fallback is what the tests pin for a caller that
     * passes no openings, and it is never worse than nothing.
     */
    const fallback = rows.reduce<Message | null>(
      (best, r) => (best === null || r.ts < best.ts || (r.ts === best.ts && r.seq < best.seq) ? r : best),
      null,
    );
    const opening = openingBy.get(a.agent_id) ?? (fallback?.role === 'user' ? fallback.body : null);

    const marks = runs.marks?.get(a.agent_id);
    const resumedAt = marks?.resumedAt ?? null;
    const lastStop = marks?.stops[marks.stops.length - 1] ?? null;
    // A stop stands until something resumes the agent: SendMessage after it,
    // or the agent's own rows after it (it went on by itself).
    const stop = lastStop !== null && (resumedAt === null || resumedAt <= lastStop.ts) ? lastStop : null;
    let status: TaskStatus;
    let waiting = false;
    let expiresAt: number | null = null;
    if (stop !== null && stop.ts >= a.last_ts) {
      // The parent was told it stopped, and it has written nothing since.
      // Its own rows may still look busy -- a hand-back is a tool result,
      // which reads as activity for RUNNING_WINDOW_MS -- but the notification
      // says outright that it is not.
      status = 'idle';
      waiting = stop.waiting;
    } else {
      // A subagent's tool call with no result yet is work in progress, not a
      // prompt: its permission requests reach the user through the parent
      // task, which is where "waiting on you" is reported.
      const opts = { unansweredToolUseBlocks: false };
      status = deriveStatus(rows, now, opts);
      expiresAt = statusExpiresAt(rows, now, opts);
      // Went on by itself after "waiting", and is quiet again before the
      // next notification: still only waiting, as far as anything says.
      waiting = status === 'idle' && stop !== null && stop.waiting;
    }

    const runStartTs = Math.max(a.first_ts, resumedAt ?? -Infinity, runs.selfResumedAt?.get(a.agent_id) ?? -Infinity);
    return {
      agentId: a.agent_id,
      // Long enough to say what the agent was asked to do; the strip wraps it
      // to two lines and clamps there, so the cap is a sanity bound, not a
      // layout decision.
      label: labelFrom(opening ?? null, LABEL_MAX),
      status,
      waiting,
      firstTs: a.first_ts,
      lastTs: a.last_ts,
      runStartTs,
      messages: a.n,
      expiresAt,
    };
  });
}

/** Every subagent this session has spawned, newest activity first. */
export async function listSubagents(sessionId: string): Promise<SubagentRun[]> {
  if (!sessionId) return [];
  const db = await getDb();
  const [agg, tail, openings, markRows] = await Promise.all([
    db.select<AggRow[]>(SUBAGENT_AGG_SQL, [sessionId]),
    db.select<TailRow[]>(SUBAGENT_TAIL_SQL, [sessionId, TAIL_ROWS]),
    db.select<{ agent_id: string; body: string | null }[]>(SUBAGENT_OPENING_SQL, [sessionId]),
    db.select<MarkRow[]>(SUBAGENT_MARKS_SQL, [sessionId, MARK_ROWS, sessionId]),
  ]);
  const marks = marksByAgent(markRows ?? []);
  // Only an agent that went on by itself after a stop needs this; rare, and
  // one cheap lookup each.
  const selfResumedAt = new Map<string, number>();
  await Promise.all(
    (agg ?? []).map(async (a) => {
      const after = selfResumeAfter(marks.get(a.agent_id), a.last_ts);
      if (after === null) return;
      const found = await db.select<{ ts: number | null }[]>(SUBAGENT_FIRST_AFTER_SQL, [sessionId, a.agent_id, after]);
      const ts = found?.[0]?.ts;
      if (typeof ts === 'number') selfResumedAt.set(a.agent_id, ts);
    }),
  );
  return buildRuns(agg ?? [], tail ?? [], openings ?? [], { marks, selfResumedAt });
}

/**
 * Those still working, or blocked -- what "running in parallel" means. An
 * agent waiting on its own background work is not: it is `idle` until it
 * resumes.
 */
export function liveRuns(runs: readonly SubagentRun[]): SubagentRun[] {
  return runs.filter((r) => r.status === 'running' || r.status === 'blocked');
}
