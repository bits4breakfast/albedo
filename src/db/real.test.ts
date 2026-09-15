/**
 * Queries executed against a REAL SQLite, on the shipped schema.
 *
 * Structural tests assert on the SQL string. That caught nothing when
 * listPastSessions counted matching rows instead of whole sessions (37 sessions
 * reported ~3 messages each instead of ~559), and nothing when the usage window
 * summed cache_read across turns (5.9M reported as 227M). Both look like
 * plausible numbers in the UI. These tests run the queries and check the
 * arithmetic.
 *
 * Fixtures deliberately seed the SHAPE that breaks these aggregates: one JSONL
 * line expanding into several `messages` rows carrying identical raw_json, and
 * a session whose id appears in more than one transcript file.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, migrationsInOrder, seedTranscriptFile, seedTurn, toPositional, type TestDb } from './testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { getMessages, insertMessages, resetDb, searchMessages, createTask } from './index';
import { listPastSessions } from './sessions';
import { usageBreakdown, usageSummary, windowUsage } from '../capture/usage';
import { contextUsage } from '../capture/context';
import { touchedFiles } from './touched';
import { createProject } from './projects';

let db: TestDb;

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
});

// ---------------------------------------------------------------------------

describe('the harness itself', () => {
  it('applies the shipped schema and every real migration, in order', () => {
    const names = migrationsInOrder().map((m) => m.name);
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual(names); // filename order

    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const set = new Set(tables.map((t) => t.name));
    for (const t of ['messages', 'tasks', 'transcript_files', 'projects', 'messages_fts']) {
      expect(set.has(t), `missing table ${t}`).toBe(true);
    }
    // columns added by later migrations really are present
    const taskCols = (db.raw.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(taskCols).toContain('project_id');
    expect(taskCols).toContain('owns_worktree');
  });

  it('rewrites $n placeholders positionally, including reuse and reordering', () => {
    expect(toPositional('a=$1 AND b=$2', ['x', 'y'])).toEqual({ sql: 'a=? AND b=?', binds: ['x', 'y'] });
    expect(toPositional('a=$2 AND b=$1', ['x', 'y'])).toEqual({ sql: 'a=? AND b=?', binds: ['y', 'x'] });
    expect(toPositional('a=$1 OR b=$1', ['x'])).toEqual({ sql: 'a=? OR b=?', binds: ['x', 'x'] });
  });

  it('leaves JSON paths alone — `$.` is not a placeholder', () => {
    const out = toPositional(`json_extract(raw_json,'$.message.usage.input_tokens') > $1`, [5]);
    expect(out.sql).toContain("'$.message.usage.input_tokens'");
    expect(out.binds).toEqual([5]);
  });

  it('coerces booleans the way sqlx does', () => {
    expect(toPositional('a=$1 AND b=$2', [true, false]).binds).toEqual([1, 0]);
  });

  it('drives the messages_fts triggers for real', async () => {
    await insertMessages([
      {
        taskId: null, sessionId: 's', seq: 0, role: 'user',
        toolName: null, targetPath: null, body: 'retry the uploader',
        rawJson: '{}', ts: 1,
      },
    ]);
    const hits = db.raw.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all('"retry"');
    expect(hits).toHaveLength(1); // the AFTER INSERT trigger fired
  });
});

// ---------------------------------------------------------------------------

describe('listPastSessions — executed', () => {
  function seedSession(sessionId: string, turns: number, ts0: number): void {
    for (let i = 0; i < turns; i++) {
      seedTurn(db, {
        sessionId,
        line: i,
        ts: ts0 + i,
        blocks: [
          { role: 'assistant', body: `thinking ${i}`, toolName: 'thinking' },
          { role: 'assistant', body: `answer ${i} mentions widget` },
          { role: 'tool_use', body: `Bash: echo ${i}`, toolName: 'Bash' },
        ],
      });
    }
  }

  it('counts the WHOLE session, not the rows that matched the query', async () => {
    // The 168x bug, in miniature. 30 rows in the session; exactly one of them
    // contains "needle".
    seedSession('s1', 10, 1_000);
    seedTurn(db, {
      sessionId: 's1', line: 99, ts: 2_000,
      blocks: [{ role: 'user', body: 'the needle is here' }],
    });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w', title: 'Widgets' });

    const unfiltered = await listPastSessions();
    expect(unfiltered[0]?.messageCount).toBe(31);

    const filtered = await listPastSessions({ query: 'needle' });
    expect(filtered).toHaveLength(1);
    // The wrong implementation reports 1 here.
    expect(filtered[0]?.messageCount).toBe(31);
  });

  it('does NOT multiply counts when a session spans several transcript files', async () => {
    // Invisible until the first resume or compaction, and then it looks like
    // data corruption. No session is multi-file on the user's machine yet.
    seedSession('s1', 4, 1_000); // 12 rows
    seedTranscriptFile(db, { path: '/p/a.jsonl', sessionId: 's1', cwd: '/w', title: 'older', updatedAt: 1 });
    seedTranscriptFile(db, { path: '/p/b.jsonl', sessionId: 's1', cwd: '/w2', title: 'newer', updatedAt: 9 });
    seedTranscriptFile(db, { path: '/p/c.jsonl', sessionId: 's1', cwd: '/w3', title: 'newest', updatedAt: 99 });

    const [s] = await listPastSessions();
    expect(s?.messageCount).toBe(12); // not 36
    // and the bare columns come from the most recently updated file
    expect(s?.title).toBe('newest');
    expect(s?.cwd).toBe('/w3');
  });

  it('returns one row per session, newest activity first', async () => {
    seedSession('old', 2, 1_000);
    seedSession('new', 2, 50_000);
    seedSession('mid', 2, 20_000);
    for (const id of ['old', 'new', 'mid']) {
      seedTranscriptFile(db, { path: `/p/${id}.jsonl`, sessionId: id, cwd: '/w' });
    }
    expect((await listPastSessions()).map((s) => s.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('reports first and last timestamps across the whole session', async () => {
    seedSession('s1', 5, 1_000);
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1' });
    const [s] = await listPastSessions();
    expect(s?.firstTs).toBe(1_000);
    expect(s?.lastTs).toBe(1_004);
  });

  it('applies `since` to the session, not to its rows', async () => {
    seedSession('long', 3, 1_000); // starts old...
    seedTurn(db, { sessionId: 'long', line: 50, ts: 90_000 }); // ...but is still active
    seedSession('stale', 3, 1_000);
    for (const id of ['long', 'stale']) seedTranscriptFile(db, { path: `/p/${id}.jsonl`, sessionId: id });

    const recent = await listPastSessions({ since: 50_000 });
    expect(recent.map((s) => s.sessionId)).toEqual(['long']);
    // and its count is still the full session, not just its recent rows
    expect(recent[0]?.messageCount).toBe(10);
  });

  it('surfaces taskId when any row of the session was adopted', async () => {
    seedTurn(db, { sessionId: 's1', line: 0, ts: 1, taskId: null });
    seedTurn(db, { sessionId: 's1', line: 1, ts: 2, taskId: 42 });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1' });
    expect((await listPastSessions())[0]?.taskId).toBe(42);
  });

  it('survives punctuation in the query instead of raising an FTS5 syntax error', async () => {
    seedTurn(db, { sessionId: 's1', line: 0, ts: 1, blocks: [{ role: 'user', body: "it's broken" }] });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1' });
    await expect(listPastSessions({ query: `it's` })).resolves.toHaveLength(1);
    await expect(listPastSessions({ query: 'NEAR(a b) OR -x:' })).resolves.toEqual([]);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) {
      seedTurn(db, { sessionId: `s${i}`, line: 0, ts: 1_000 + i });
      seedTranscriptFile(db, { path: `/p/s${i}.jsonl`, sessionId: `s${i}` });
    }
    expect(await listPastSessions({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('usage and context aggregates — executed', () => {
  const NOW = 10_000_000;
  const CACHE = 186_000;

  /** N turns of one long session, each re-reading the same cached context. */
  function seedRepeatedTurns(n: number, sessionId = 's1'): void {
    for (let i = 0; i < n; i++) {
      seedTurn(db, {
        sessionId,
        line: i,
        ts: NOW - 3_600_000 + i,
        // three rows per line, all sharing raw_json — the shape that made the
        // naive per-row sum triple every figure
        blocks: [
          { role: 'assistant', body: 't', toolName: 'thinking' },
          { role: 'assistant', body: 'a' },
          { role: 'tool_use', body: 'Bash: x', toolName: 'Bash' },
        ],
        usage: { input: 10, output: 50, cacheCreation: 100, cacheRead: CACHE },
      });
    }
  }

  it('does not let cache_read grow the window total with turn count', async () => {
    seedRepeatedTurns(50);
    const a = await usageSummary(NOW);
    expect(a.inputTokens).toBe(50 * 110); // input + cache_creation only
    expect(a.outputTokens).toBe(50 * 50);
    expect(a.cacheReadTokens).toBe(50 * CACHE);
    // the bug: 50 * 186,000 folded into the headline
    expect(a.inputTokens).toBeLessThan(CACHE);
  });

  it('scales spend with turns while cache_read stays out of it', async () => {
    seedRepeatedTurns(10, 'a');
    seedRepeatedTurns(40, 'b');
    const all = await usageSummary(NOW);
    expect(all.inputTokens).toBe(50 * 110); // counted across sessions
    expect(all.cacheReadTokens).toBe(50 * CACHE);
  });

  it('de-duplicates the three rows each turn expanded into', async () => {
    seedRepeatedTurns(7);
    const b = await usageBreakdown(NOW);
    expect(b.lineCount).toBe(7); // not 21
    expect(b.inputTokens).toBe(70);
    expect(b.cacheCreationInputTokens).toBe(700);
    expect(b.cacheReadInputTokens).toBe(7 * CACHE);
  });

  it('keeps the burn rate free of the same inflation', async () => {
    seedRepeatedTurns(50);
    const w = await windowUsage('5h', NOW);
    expect(w.cacheReadTokens).toBe(50 * CACHE);
    // (5500 + 2500) spent over ~1h
    expect(w.burnRate).toBeLessThan(20_000);
  });

  it('excludes turns outside the window', async () => {
    seedTurn(db, { sessionId: 's1', line: 0, ts: NOW - 6 * 3_600_000, usage: { input: 999_999 } });
    seedTurn(db, { sessionId: 's1', line: 1, ts: NOW - 60_000, usage: { input: 7 } });
    expect((await usageSummary(NOW)).inputTokens).toBe(7);
  });

  it('contextUsage sums ALL THREE counters — the opposite rule, on one turn', async () => {
    seedTurn(db, {
      sessionId: 's1', line: 0, ts: NOW - 1_000,
      usage: { input: 2, cacheCreation: 10_889, cacheRead: 186_919 },
    });
    const u = await contextUsage('s1');
    expect(u?.used).toBe(197_810); // occupancy, not consumption
    expect(u?.limit).toBe(200_000);
    expect(u?.limitBasis).toBe('inferred');
  });

  it('contextUsage takes the LATEST turn and the session PEAK', async () => {
    seedTurn(db, { sessionId: 's1', line: 0, ts: 1, usage: { cacheRead: 250_000 } });
    seedTurn(db, { sessionId: 's1', line: 1, ts: 2, usage: { cacheRead: 50_000 } }); // compacted
    const u = await contextUsage('s1');
    expect(u?.used).toBe(50_000); // latest turn
    expect(u?.limit).toBe(1_000_000); // peak proves it is not a 200k session
    expect(u?.limitBasis).toBe('known');
  });

  it('returns null for a session with no usage record', async () => {
    expect(await contextUsage('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('getMessages paging — executed', () => {
  beforeEach(async () => {
    await insertMessages(
      Array.from({ length: 50 }, (_, i) => ({
        taskId: 1, sessionId: 's1', seq: i * 100, role: 'assistant' as const,
        toolName: null, targetPath: null, body: `row ${i}`,
        rawJson: '{}', ts: 1_000 + i,
      })),
    );
  });

  it('keeps the TAIL when no afterSeq is given', async () => {
    const page = await getMessages({ sessionId: 's1', limit: 5 });
    expect(page.map((m) => m.seq)).toEqual([4500, 4600, 4700, 4800, 4900]);
  });

  it('keeps the HEAD after afterSeq, so forward pages cannot leave a hole', async () => {
    const page = await getMessages({ sessionId: 's1', afterSeq: 1000, limit: 5 });
    expect(page.map((m) => m.seq)).toEqual([1100, 1200, 1300, 1400, 1500]);
  });

  it('pages forward contiguously at any limit', async () => {
    for (const limit of [1, 7, 49]) {
      const seen: number[] = [];
      let cursor = -1;
      for (;;) {
        const page = await getMessages({ sessionId: 's1', afterSeq: cursor, limit });
        if (page.length === 0) break;
        seen.push(...page.map((m) => m.seq));
        cursor = page[page.length - 1]?.seq ?? cursor;
      }
      expect(seen, `limit ${limit}`).toEqual(Array.from({ length: 50 }, (_, i) => i * 100));
    }
  });

  it('orders a task-scoped read by ts, so a resumed session follows the first', async () => {
    await insertMessages([
      { taskId: 1, sessionId: 's2', seq: 0, role: 'assistant', toolName: null,
        targetPath: null, body: 'resumed', rawJson: '{}', ts: 99_999 },
    ]);
    const rows = await getMessages({ taskId: 1 });
    // s2 restarts seq at 0 but is newest; seq-led ordering would put it first
    expect(rows[rows.length - 1]?.sessionId).toBe('s2');
  });
});

// ---------------------------------------------------------------------------

describe('searchMessages — executed', () => {
  beforeEach(async () => {
    await insertMessages([
      { taskId: null, sessionId: 's1', seq: 0, role: 'user', toolName: null, targetPath: null,
        body: 'please fix the uploader retry logic', rawJson: '{}', ts: 1 },
      { taskId: null, sessionId: 's1', seq: 100, role: 'tool_use', toolName: 'Edit',
        targetPath: '/repo/src/uploader.ts', body: 'Edit: /repo/src/uploader.ts', rawJson: '{}', ts: 2 },
    ]);
  });

  it('returns a highlighted snippet from the real FTS index', async () => {
    const hits = await searchMessages('uploader');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('<mark>');
    expect(hits[0]?.snippet.toLowerCase()).toContain('uploader');
  });

  it('filters by tool name', async () => {
    expect(await searchMessages('uploader', { toolName: 'Edit' })).toHaveLength(1);
    expect(await searchMessages('uploader', { toolName: 'Bash' })).toHaveLength(0);
  });

  it('does not raise a syntax error on punctuation', async () => {
    await expect(searchMessages(`it's: "quoted" -x NEAR(a b)`)).resolves.toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------

describe('touchedFiles — executed', () => {
  it('merges transcript touches per worktree-relative path without duplicating', async () => {
    const project = await createProject({
      name: 'p', repoPath: '/repo', worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    const task = await createTask({
      title: 't', projectId: project.id, repoPath: '/repo', baseBranch: 'main',
      branch: 'b', worktreePath: '/wt/slug', ownsWorktree: true,
    });

    // The same file, written three times, named absolutely and relatively.
    await insertMessages([
      { taskId: task.id, sessionId: 's1', seq: 0, role: 'tool_use', toolName: 'Edit',
        targetPath: '/wt/slug/src/a.ts', body: 'Edit', rawJson: '{}', ts: 10 },
      { taskId: task.id, sessionId: 's1', seq: 100, role: 'tool_use', toolName: 'Write',
        targetPath: '/wt/slug/src/a.ts', body: 'Write', rawJson: '{}', ts: 20 },
      { taskId: task.id, sessionId: 's1', seq: 200, role: 'tool_use', toolName: 'Edit',
        targetPath: 'src/a.ts', body: 'Edit', rawJson: '{}', ts: 30 },
      { taskId: task.id, sessionId: 's1', seq: 300, role: 'tool_use', toolName: 'Edit',
        targetPath: '/wt/slug/src/b.ts', body: 'Edit', rawJson: '{}', ts: 40 },
      // a read must not count as a touch
      { taskId: task.id, sessionId: 's1', seq: 400, role: 'tool_use', toolName: 'Read',
        targetPath: '/wt/slug/src/c.ts', body: 'Read', rawJson: '{}', ts: 50 },
    ]);

    const files = await touchedFiles(task.id);
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size, `duplicate rows: ${paths.join(', ')}`).toBe(paths.length);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
    expect(paths).not.toContain('src/c.ts');
  });
});
