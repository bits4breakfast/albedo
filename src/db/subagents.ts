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
import { deriveStatus } from '../capture/status';

/** One subagent run under a parent session. */
export interface SubagentRun {
  /** The id `<agent-message from="...">` quotes in the parent transcript. */
  agentId: string;
  /** First line of its opening prompt. Null when it has not spoken yet. */
  label: string | null;
  /** Derived the same way a task's is, from rows only -- never from the pty. */
  status: TaskStatus;
  firstTs: number;
  lastTs: number;
  messages: number;
}

/**
 * Rows to pull per session for status. `deriveStatus` only needs the tail --
 * an unanswered trailing `tool_use` and the last assistant line -- so this is
 * a window, not a full history, and it is ONE query for every agent rather
 * than one per agent.
 */
const TAIL_ROWS = 400;

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
): SubagentRun[] {
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
    return {
      agentId: a.agent_id,
      label: labelFrom(opening ?? null),
      // A subagent's tool call with no result yet is work in progress, not a
      // prompt: its permission requests reach the user through the parent
      // task, which is where "waiting on you" is reported.
      status: deriveStatus(rows, Date.now(), { unansweredToolUseBlocks: false }),
      firstTs: a.first_ts,
      lastTs: a.last_ts,
      messages: a.n,
    };
  });
}

/** Every subagent this session has spawned, newest activity first. */
export async function listSubagents(sessionId: string): Promise<SubagentRun[]> {
  if (!sessionId) return [];
  const db = await getDb();
  const [agg, tail, openings] = await Promise.all([
    db.select<AggRow[]>(SUBAGENT_AGG_SQL, [sessionId]),
    db.select<TailRow[]>(SUBAGENT_TAIL_SQL, [sessionId, TAIL_ROWS]),
    db.select<{ agent_id: string; body: string | null }[]>(SUBAGENT_OPENING_SQL, [sessionId]),
  ]);
  return buildRuns(agg ?? [], tail ?? [], openings ?? []);
}

/** Those still working or waiting -- what "running in parallel" means. */
export function liveRuns(runs: readonly SubagentRun[]): SubagentRun[] {
  return runs.filter((r) => r.status === 'running' || r.status === 'blocked');
}
