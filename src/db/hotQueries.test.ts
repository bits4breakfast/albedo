/**
 * The hot queries of #361, on a real SQLite: the status read, the context
 * meter's read, the subagent listing, and the search index's update trigger.
 *
 * Each faster query is pinned against the query it replaced, copied here
 * verbatim from main at 916a08e, over varied synthetic data: the rows must be
 * the same rows in the same order. The one intended difference -- a subagent's
 * rows no longer feed the parent's context meter -- is pinned on its own, and
 * the equivalence for it compares against the old query restricted to the
 * parent's rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import {
  adoptSessionIntoTask,
  forgetContextPeaks,
  getMessages,
  getSessionContextRows,
  getSessionUsageRows,
  purgeTaskHistory,
  resetDb,
  searchMessages,
} from './index';
import { listSubagents } from './subagents';
import { contextUsage } from '../capture/context';
import { lastModelOf } from '../capture/sessionLink';
import { contextUsedSqlExpr, USAGE_PRESENCE_JSON_PATH } from '../capture/adapter';

let db: TestDb;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

// ---------------------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  taskId: number | null;
  sessionId: string;
  seq: number;
  role: string;
  rawJson: string;
  agentId: string | null;
  ts: number;
}

function assistantRaw(model: string, used: number | null, extra: Record<string, unknown> = {}): string {
  const message: Record<string, unknown> = { model, role: 'assistant', content: [{ type: 'text', text: 'x' }] };
  if (used !== null) {
    message['usage'] = {
      input_tokens: used % 1000,
      cache_read_input_tokens: Math.floor(used / 1000) * 1000,
      cache_creation_input_tokens: 0,
      output_tokens: 7,
    };
  }
  return JSON.stringify({ type: 'assistant', message, ...extra });
}

function insertRows(rows: Row[]): void {
  const st = db.raw.prepare(
    `INSERT OR IGNORE INTO messages (task_id, session_id, seq, role, body, raw_json, agent_id, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) st.run(r.taskId, r.sessionId, r.seq, r.role, `body ${r.seq}`, r.rawJson, r.agentId, r.ts);
}

/**
 * Rows for several sessions, shuffled so ids interleave across sessions as
 * they do when transcripts are tailed together. Within a file seqs are unique
 * and rise with the line; ts often ties and sometimes runs backwards, so any
 * difference between "by seq" and "by seq, ts, id" would show. Subagents
 * (and, as the old filter excluded them too, a few `''` agent ids) carry
 * their own seq numbering, higher than the parent's and with larger usage.
 */
function synthetic(seed: number, opts: { subagents: boolean; lineFrom?: number; lines?: number }): Row[] {
  const rand = rng(seed);
  const rows: Row[] = [];
  const from = opts.lineFrom ?? 0;
  const lines = opts.lines ?? 60;
  for (let s = 0; s < 4; s++) {
    const sessionId = `s${s}`;
    const files: (string | null)[] = [null];
    if (opts.subagents) files.push('agent-a', 'agent-b', '');
    for (const agentId of files) {
      const n = agentId === null ? lines : Math.floor(lines * 1.5);
      for (let line = from; line < from + n; line++) {
        const blocks = 1 + Math.floor(rand() * 3);
        const ts = 1_000_000 + Math.floor(line / 2) * 1000 - (rand() < 0.1 ? 5000 : 0);
        const roll = rand();
        const kind = roll < 0.4 ? 'assistant' : roll < 0.6 ? 'user' : 'tool';
        const used = agentId === null ? Math.floor(rand() * 150_000) : 400_000 + Math.floor(rand() * 400_000);
        const withUsage = rand() < 0.8;
        const model = agentId === null ? 'claude-parent-1' : 'claude-agent-9';
        const raw = kind === 'user' ? '{"type":"user"}' : assistantRaw(model, withUsage ? used : null);
        for (let b = 0; b < blocks; b++) {
          const role = kind === 'user' ? 'user' : kind === 'tool' ? (b === 0 ? 'tool_use' : 'tool_result') : 'assistant';
          rows.push({
            taskId: s < 2 ? s + 1 : null,
            sessionId,
            seq: line * 100 + b,
            role,
            rawJson: role === 'tool_result' ? '{"type":"user"}' : raw,
            agentId,
            ts,
          });
        }
      }
    }
  }
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j] as Row, rows[i] as Row];
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The status read
// ---------------------------------------------------------------------------

/** getMessages' parent-only SQL as main built it, ids only. */
function oldParentOnlyIds(o: { sessionId: string; taskId?: number; afterSeq?: number; limit: number }): number[] {
  const where = ['+agent_id IS NULL'];
  const binds: unknown[] = [];
  if (o.taskId !== undefined) {
    where.unshift('task_id = ?');
    binds.push(o.taskId);
  }
  where.splice(o.taskId !== undefined ? 1 : 0, 0, 'session_id = ?');
  binds.splice(o.taskId !== undefined ? 1 : 0, 0, o.sessionId);
  if (o.afterSeq !== undefined) {
    where.push('seq > ?');
    binds.push(o.afterSeq);
  }
  binds.push(o.limit);
  const keys = o.taskId === undefined ? ['seq', 'ts', 'id'] : ['ts', 'seq', 'id'];
  const asc = keys.map((k) => `${k} ASC`).join(', ');
  const desc = keys.map((k) => `${k} DESC`).join(', ');
  const w = `WHERE ${where.join(' AND ')}`;
  const sql =
    o.afterSeq === undefined
      ? `SELECT * FROM (SELECT id, seq, ts FROM messages ${w} ORDER BY ${desc} LIMIT ?) ORDER BY ${asc}`
      : `SELECT id FROM messages ${w} ORDER BY ${asc} LIMIT ?`;
  return (db.raw.prepare(sql).all(...(binds as never[])) as { id: number }[]).map((r) => r.id);
}

describe('status read: parent-only rows of one session (#361)', () => {
  it('returns the same rows in the same order as the query it replaced', async () => {
    for (const seed of [1, 2, 3]) {
      resetDb();
      db = createTestDb();
      harness.db = db;
      insertRows(synthetic(seed, { subagents: true }));
      let compared = 0;
      for (const sessionId of ['s0', 's1', 's2', 's3', 'missing']) {
        for (const limit of [1, 7, 60, 400, 5000]) {
          for (const afterSeq of [undefined, -1, 1500, 3001]) {
            for (const taskId of [undefined, 1]) {
              const got = await getMessages({ sessionId, taskId, afterSeq, limit, parentOnly: true });
              const want = oldParentOnlyIds({ sessionId, taskId, afterSeq, limit });
              expect(got.map((m) => m.id)).toEqual(want);
              expect(got.every((m) => m.agentId === null)).toBe(true);
              compared += want.length;
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(1000);
    }
  });

  it('reads the index in seq order instead of sorting the session', async () => {
    insertRows(synthetic(4, { subagents: true }));
    for (const afterSeq of [undefined, 500]) {
      db.log.length = 0;
      await getMessages({ sessionId: 's0', afterSeq, limit: 400, parentOnly: true });
      const { sql, binds } = db.log[0] as { sql: string; binds: unknown[] };
      const positional = sql.replace(/\$\d+/g, '?');
      const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${positional}`).all(...(binds as never[])) as { detail: string }[]).map(
        (p) => p.detail,
      );
      expect(plan.join(' | ')).toContain('messages_session_seq (session_id=? AND <expr>=?');
      // The tail read re-sorts its 400 rows ascending; nothing sorts the session.
      const sorts = plan.filter((d) => d.includes('TEMP B-TREE')).length;
      expect(sorts).toBe(afterSeq === undefined ? 1 : 0);
    }
  });

  it('leaves a read with subagents included, or one agent, ordered as before', async () => {
    insertRows(synthetic(5, { subagents: true }));
    db.log.length = 0;
    await getMessages({ sessionId: 's0', limit: 50 });
    await getMessages({ sessionId: 's0', agentId: 'agent-a', limit: 50 });
    for (const { sql } of db.log) expect(sql).toContain('seq DESC, ts DESC, id DESC');
  });
});

// ---------------------------------------------------------------------------
// The context meter's read
// ---------------------------------------------------------------------------

/**
 * getSessionContextRows' SQL as main had it, with `parentClause` added to
 * both scans ('' reproduces main exactly).
 */
function oldContextRows(sessionIds: string[], parentClause: string) {
  const expr = contextUsedSqlExpr('raw_json');
  const slots = sessionIds.map(() => '?').join(', ');
  const rows = db.raw
    .prepare(
      `SELECT m.session_id AS session_id, MAX(m.seq) AS latest_seq, m.ts AS latest_ts,
              m.raw_json AS latest_raw, p.peak_used AS peak_used
         FROM messages m
         JOIN (SELECT session_id, MAX(${expr}) AS peak_used FROM messages
                WHERE session_id IN (${slots}) AND role IN ('assistant', 'tool_use') ${parentClause}
                GROUP BY session_id) p ON p.session_id = m.session_id
        WHERE m.session_id IN (${slots}) AND m.role IN ('assistant', 'tool_use') ${parentClause.replace('agent_id', 'm.agent_id')}
          AND json_extract(m.raw_json, '${USAGE_PRESENCE_JSON_PATH}') IS NOT NULL
        GROUP BY m.session_id`,
    )
    .all(...sessionIds, ...sessionIds) as {
    session_id: string;
    latest_ts: number;
    latest_raw: string;
    peak_used: number | null;
  }[];
  return rows
    .map((r) => ({ sessionId: r.session_id, peakUsed: r.peak_used ?? 0, latestRawJson: r.latest_raw, latestTs: r.latest_ts }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

async function newContextRows(sessionIds: string[]) {
  return (await getSessionContextRows(sessionIds)).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

const ALL = ['s0', 's1', 's2', 's3', 'missing'];

describe('context read (#361)', () => {
  it('without subagents, matches the query it replaced, read after read as rows arrive and go', async () => {
    for (const seed of [11, 12, 13]) {
      resetDb();
      db = createTestDb();
      harness.db = db;
      insertRows(synthetic(seed, { subagents: false, lines: 30 }));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
      // More lines: some raise the peak, some do not.
      insertRows(synthetic(seed + 100, { subagents: false, lineFrom: 30, lines: 30 }));
      expect(await newContextRows(['s1'])).toEqual(oldContextRows(['s1'], ''));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
      // A burst into one session only, read again, and again with nothing new.
      insertRows(synthetic(seed + 200, { subagents: false, lineFrom: 60, lines: 5 }).filter((r) => r.sessionId === 's2'));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
      // Deleting a task's history is the one thing that lowers a peak.
      await purgeTaskHistory(1);
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
      // And the session comes back (History re-reads it), under reused ids.
      insertRows(synthetic(seed + 300, { subagents: false, lines: 10 }).filter((r) => r.sessionId === 's0'));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
    }
  });

  it('with subagents, matches the query it replaced restricted to the parent rows', async () => {
    for (const seed of [21, 22, 23]) {
      resetDb();
      db = createTestDb();
      harness.db = db;
      const parent = 'AND agent_id IS NULL';
      insertRows(synthetic(seed, { subagents: true, lines: 30 }));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, parent));
      insertRows(synthetic(seed + 100, { subagents: true, lineFrom: 30, lines: 30 }));
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, parent));
      await purgeTaskHistory(2);
      expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, parent));
      // The bug, for the record: unfiltered, the subagents win.
      expect(oldContextRows(['s0'], '')[0]?.latestRawJson).toContain('claude-agent-9');
    }
  });

  it('chunks a long list of sessions and lists each once', async () => {
    insertRows(synthetic(31, { subagents: true, lines: 5 }));
    const ids = [...Array.from({ length: 900 }, (_, i) => `none-${i}`), ...ALL, 's0'];
    expect(await newContextRows(ids)).toEqual(oldContextRows(ALL, 'AND agent_id IS NULL'));
  });

  it('does not let a long subagent supply the meter, its model, or the peak', async () => {
    insertRows([
      { taskId: 1, sessionId: 's1', seq: 100, role: 'assistant', rawJson: assistantRaw('claude-opus-4-1', 20_000), agentId: null, ts: 1 },
      { taskId: 1, sessionId: 's1', seq: 300, role: 'tool_use', rawJson: assistantRaw('claude-opus-4-1', 30_000), agentId: null, ts: 3 },
      // A long Explore agent: higher seq (its own file), more context, another model.
      ...Array.from({ length: 50 }, (_, i) => ({
        taskId: 1,
        sessionId: 's1',
        seq: 1000 + i * 100,
        role: 'assistant',
        rawJson: assistantRaw('claude-haiku-4-5', 600_000 + i),
        agentId: 'explore-1',
        ts: 2,
      })),
    ]);
    const usage = await contextUsage('s1');
    expect(usage?.used).toBe(30_000);
    expect(usage?.model).toBe('claude-opus-4-1');
    expect(usage?.limit).toBe(200_000); // inferred from the parent's peak, not 600k
    const [row] = await getSessionContextRows(['s1']);
    expect(row?.peakUsed).toBe(30_000);
    // What a resume with no stored model starts on.
    expect(await lastModelOf('s1')).toBe('claude-opus-4-1');
  });

  it('has no reading for a session whose only usage is a subagent\'s', async () => {
    insertRows([
      { taskId: 1, sessionId: 's1', seq: 0, role: 'user', rawJson: '{"type":"user"}', agentId: null, ts: 1 },
      { taskId: 1, sessionId: 's1', seq: 100, role: 'assistant', rawJson: assistantRaw('claude-haiku-4-5', 50_000), agentId: 'a1', ts: 2 },
    ]);
    expect(await getSessionContextRows(['s1'])).toEqual([]);
    expect(await contextUsage('s1')).toBeNull();
  });

  it('the fallback reads the parent rows only', async () => {
    insertRows(synthetic(41, { subagents: true, lines: 10 }));
    const rows = await getSessionUsageRows(['s0']);
    const want = db.raw
      .prepare(
        `SELECT seq FROM messages WHERE session_id = 's0' AND agent_id IS NULL
            AND role IN ('assistant', 'tool_use') ORDER BY seq`,
      )
      .all() as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual(want.map((r) => r.seq));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.rawJson.includes('claude-agent-9'))).toBe(false);
  });

  it('reads again when the cache is forgotten while a read is in flight', async () => {
    insertRows(synthetic(52, { subagents: false, lines: 30 }));
    await getSessionContextRows(ALL);
    // New rows whose peak is below the session's: folded into an emptied
    // cache, they alone would set the peak.
    insertRows([
      { taskId: 1, sessionId: 's0', seq: 900_000, role: 'assistant', rawJson: assistantRaw('claude-parent-1', 5), agentId: null, ts: 9e9 },
    ]);
    const select = db.select.bind(db);
    let forgets = 0;
    db.select = async <T,>(sql: string, binds?: unknown[]): Promise<T> => {
      const out = await select<T>(sql, binds);
      if (sql.includes('cursor_id') && forgets++ === 0) forgetContextPeaks();
      return out;
    };
    expect(await newContextRows(ALL)).toEqual(oldContextRows(ALL, ''));
    expect(forgets).toBe(2);
  });

  it('scans only the rows added since the last read', async () => {
    insertRows(synthetic(51, { subagents: false, lines: 20 }));
    await getSessionContextRows(['s0']);
    const maxId = (db.raw.prepare(`SELECT MAX(id) AS m FROM messages WHERE session_id = 's0'`).get() as { m: number }).m;
    db.log.length = 0;
    await getSessionContextRows(['s0']);
    expect(db.log[0]?.binds).toEqual(['s0', maxId]);
    // Within the session's own index range, and no sort of raw_json rows.
    const { sql, binds } = db.log[0] as { sql: string; binds: unknown[] };
    const plan = (
      db.raw.prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\$\d+/g, '?')}`).all(...(binds as never[])) as { detail: string }[]
    ).map((p) => p.detail);
    expect(plan.filter((d) => d.includes('messages')).every((d) => d.includes('messages_session_seq') || d.includes('PRIMARY KEY'))).toBe(true);
    expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subagent listing
// ---------------------------------------------------------------------------

describe('listSubagents (#361)', () => {
  it('asks one cheap question of a session with no subagents', async () => {
    insertRows(synthetic(61, { subagents: false, lines: 20 }));
    db.log.length = 0;
    expect(await listSubagents('s0')).toEqual([]);
    expect(db.log).toHaveLength(1);
    expect(db.log[0]?.sql).not.toContain('raw_json');
  });

  it('still lists the agents of a session that has them', async () => {
    insertRows(synthetic(62, { subagents: true, lines: 10 }));
    const runs = await listSubagents('s0');
    expect(runs.map((r) => r.agentId).sort()).toEqual(['', 'agent-a', 'agent-b']);
  });
});

// ---------------------------------------------------------------------------
// Search index trigger
// ---------------------------------------------------------------------------

describe('messages_au (#361)', () => {
  function ftsChanges(run: () => void): number {
    // Every trigger write to messages_fts counts in total_changes().
    const before = (db.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    run();
    return (db.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before;
  }

  it('leaves the index alone when an update does not touch the body', async () => {
    insertRows(synthetic(71, { subagents: false, lines: 10 }));
    const n = (db.raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = 's3'`).get() as { n: number }).n;
    const changes = ftsChanges(() => db.raw.prepare(`UPDATE messages SET task_id = 9 WHERE session_id = 's3'`).run());
    expect(changes).toBe(n); // the rows themselves, nothing in messages_fts
  });

  it('still finds a body after its row is adopted into a task', async () => {
    insertRows([
      { taskId: null, sessionId: 'sx', seq: 0, role: 'user', rawJson: '{"type":"user"}', agentId: null, ts: 1 },
    ]);
    db.raw.prepare(`UPDATE messages SET body = 'quokka sightings' WHERE session_id = 'sx'`).run();
    db.raw.prepare(`INSERT INTO tasks (id, title, repo_path, base_branch, branch, worktree_path, status, created_at)
                    VALUES (5, 't', '/r', 'main', 'b', '/w', 'idle', 0)`).run();
    await adoptSessionIntoTask('sx', 5);
    const hits = await searchMessages('quokka');
    expect(hits.map((h) => h.message.taskId)).toEqual([5]);
  });

  it('re-indexes a body that is written', async () => {
    insertRows([
      { taskId: null, sessionId: 'sy', seq: 0, role: 'user', rawJson: '{"type":"user"}', agentId: null, ts: 1 },
    ]);
    db.raw.prepare(`UPDATE messages SET body = 'platypus' WHERE session_id = 'sy'`).run();
    expect((await searchMessages('platypus')).length).toBe(1);
    db.raw.prepare(`UPDATE messages SET body = 'wombat' WHERE session_id = 'sy'`).run();
    expect((await searchMessages('platypus')).length).toBe(0);
    expect((await searchMessages('wombat')).length).toBe(1);
    // Same text written again: still indexed once.
    db.raw.prepare(`UPDATE messages SET body = 'wombat' WHERE session_id = 'sy'`).run();
    expect((await searchMessages('wombat')).length).toBe(1);
  });

  it('re-files a row whose id changes', async () => {
    insertRows([
      { taskId: null, sessionId: 'sz', seq: 0, role: 'user', rawJson: '{"type":"user"}', agentId: null, ts: 1 },
    ]);
    db.raw.prepare(`UPDATE messages SET body = 'echidna' WHERE session_id = 'sz'`).run();
    db.raw.prepare(`UPDATE messages SET id = 999999 WHERE session_id = 'sz'`).run();
    const hits = await searchMessages('echidna');
    expect(hits.map((h) => h.message.id)).toEqual([999999]);
  });
});
