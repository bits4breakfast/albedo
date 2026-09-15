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

import {
  createTask,
  insertMessages,
  listTranscriptFiles,
  listTranscriptFilesNeedingTitle,
  resetDb,
  searchMessages,
  setTranscriptTitle,
} from './index';
import { listPastSessions } from './sessions';
import { usageBreakdown, usageSummary, windowUsage } from '../capture/usage';
import { contextUsage } from '../capture/context';
import { touchedFiles } from './touched';
import {
  backfillProjectsFromTasks,
  createProject,
  findWorktreeProjects,
  listUnclaimedRepos,
} from './projects';

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


// ---------------------------------------------------------------------------

describe('branch and first prompt — the discriminators', () => {
  /** Seed a line with a git branch on the envelope, as the adapter would. */
  function seedBranchedTurn(
    sessionId: string,
    line: number,
    ts: number,
    branch: string | null,
    body: string,
    role = 'user',
  ): void {
    const raw = JSON.stringify({
      type: role === 'user' ? 'user' : 'assistant',
      sessionId, timestamp: new Date(ts).toISOString(), cwd: '/w',
      ...(branch === null ? {} : { gitBranch: branch }),
      message: { role, content: body },
    });
    db.raw
      .prepare(
        `INSERT INTO messages (task_id, session_id, seq, role, tool_name, target_path, body, raw_json, ts)
         VALUES (NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(sessionId, line * 100, role, body, raw, ts);
  }

  it('reports the branch the session ENDED on', async () => {
    seedBranchedTurn('s1', 0, 1, 'master', 'start here');
    seedBranchedTurn('s1', 1, 2, 'ACME-2346', 'switched');
    seedBranchedTurn('s1', 2, 3, 'PLATFORM-1NF', 'switched again');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.branch).toBe('PLATFORM-1NF');
  });

  it('skips rows with no branch rather than reporting null', async () => {
    seedBranchedTurn('s1', 0, 1, 'ACME-2346', 'real work');
    seedBranchedTurn('s1', 1, 2, null, 'a line with no envelope branch');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.branch).toBe('ACME-2346');
  });

  it('is null when the session never recorded one', async () => {
    seedBranchedTurn('s1', 0, 1, null, 'no branch anywhere');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.branch).toBeNull();
  });

  it('SKIPS injected openers and takes the first prompt the human typed', async () => {
    // 75 of the user's 115 sessions open with one of these. Taking the naive
    // first user row collapses 115 sessions onto 43 distinct labels.
    seedBranchedTurn('s1', 0, 1, 'master', '<command-name>/resume</command-name>');
    seedBranchedTurn('s1', 1, 2, 'master', '[Request interrupted by user]');
    seedBranchedTurn('s1', 2, 3, 'master', 'fix the uploader retry logic');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.firstPrompt).toBe('fix the uploader retry logic');
  });

  it('differentiates sessions that share a branch and a cwd', async () => {
    // The actual complaint: 18 sessions on `master`, all in the same checkout.
    for (const [i, prompt] of ['add retry to uploader', 'investigate the slow query', 'rename the config keys'].entries()) {
      seedBranchedTurn(`s${i}`, 0, 100 + i, 'master', '<command-name>/clear</command-name>');
      seedBranchedTurn(`s${i}`, 1, 200 + i, 'master', prompt);
      seedTranscriptFile(db, { path: `/p/s${i}.jsonl`, sessionId: `s${i}`, cwd: '/Users/x/www/acme' });
    }
    const rows = await listPastSessions();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.cwd)).size).toBe(1); // cwd tells them apart: no
    expect(new Set(rows.map((r) => r.branch)).size).toBe(1); // branch: also no
    expect(new Set(rows.map((r) => r.firstPrompt)).size).toBe(3); // prompt: yes
  });

  it('collapses newlines and truncates a long opening prompt', async () => {
    seedBranchedTurn('s1', 0, 1, 'master', `first line\n\n\tsecond   line ${'x'.repeat(300)}`);
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    const p = (await listPastSessions())[0]?.firstPrompt ?? '';
    expect(p).not.toContain('\n');
    expect(p).not.toContain('  ');
    expect(p.length).toBeLessThanOrEqual(160);
    expect(p.startsWith('first line second line')).toBe(true);
  });

  it('is null when a session has only injected openers', async () => {
    seedBranchedTurn('s1', 0, 1, 'master', '<command-name>/status</command-name>');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.firstPrompt).toBeNull();
  });

  it('ignores assistant rows when looking for the opening prompt', async () => {
    seedBranchedTurn('s1', 0, 1, 'master', 'I will start now', 'assistant');
    seedBranchedTurn('s1', 1, 2, 'master', 'the human question', 'user');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.firstPrompt).toBe('the human question');
  });
});

// ---------------------------------------------------------------------------

describe('transcript title sentinel', () => {
  it("distinguishes 'not scanned' from 'scanned, no title'", async () => {
    seedTranscriptFile(db, { path: '/p/a.jsonl', sessionId: 'a', title: null });
    seedTranscriptFile(db, { path: '/p/b.jsonl', sessionId: 'b', title: '' });
    seedTranscriptFile(db, { path: '/p/c.jsonl', sessionId: 'c', title: 'Real Title' });

    // only the unscanned file is offered to the backfill
    expect((await listTranscriptFilesNeedingTitle()).map((f) => f.path)).toEqual(['/p/a.jsonl']);

    // and the sentinel never leaks out as a title
    const files = await listTranscriptFiles();
    const byPath = new Map(files.map((f) => [f.path, f.title]));
    expect(byPath.get('/p/a.jsonl')).toBeNull();
    expect(byPath.get('/p/b.jsonl')).toBeNull();
    expect(byPath.get('/p/c.jsonl')).toBe('Real Title');
  });

  it('marks a titleless file so it is never re-read', async () => {
    seedTranscriptFile(db, { path: '/p/a.jsonl', sessionId: 'a', title: null });
    await setTranscriptTitle('/p/a.jsonl', null);
    expect(await listTranscriptFilesNeedingTitle()).toEqual([]);
  });

  it('records a found title and surfaces it in the session browser', async () => {
    seedTurn(db, { sessionId: 'a', line: 0, ts: 1 });
    seedTranscriptFile(db, { path: '/p/a.jsonl', sessionId: 'a', cwd: '/w', title: null });
    await setTranscriptTitle('/p/a.jsonl', 'Refactor the uploader');
    expect((await listPastSessions())[0]?.title).toBe('Refactor the uploader');
    expect(await listTranscriptFilesNeedingTitle()).toEqual([]);
  });
});


describe('topFiles', () => {
  function seedWrite(sessionId: string, seq: number, tool: string, path: string | null): void {
    db.raw
      .prepare(
        `INSERT INTO messages (task_id, session_id, seq, role, tool_name, target_path, body, raw_json, ts)
         VALUES (NULL, ?, ?, 'tool_use', ?, ?, 'x', '{}', ?)`,
      )
      .run(sessionId, seq, tool, path, 1000 + seq);
  }

  it('returns BASENAMES, most-touched first', async () => {
    seedWrite('s1', 0, 'Edit', '/wt/slug/src/uploader.ts');
    seedWrite('s1', 100, 'Edit', '/wt/slug/src/uploader.ts');
    seedWrite('s1', 200, 'Write', '/wt/slug/src/uploader.ts');
    seedWrite('s1', 300, 'Edit', '/wt/slug/src/config.ts');
    seedWrite('s1', 400, 'Edit', '/wt/slug/src/config.ts');
    seedWrite('s1', 500, 'Edit', '/wt/slug/README.md');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });

    const [s] = await listPastSessions();
    // basenames, never full paths — full paths were the cwd problem again
    expect(s?.topFiles).toEqual(['uploader.ts', 'config.ts', 'README.md']);
    for (const f of s?.topFiles ?? []) expect(f).not.toContain('/');
  });

  it('shows at most three', async () => {
    for (let i = 0; i < 9; i++) seedWrite('s1', i * 100, 'Edit', `/wt/f${i}.ts`);
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.topFiles).toHaveLength(3);
  });

  it('is an empty array for a session that wrote nothing', async () => {
    seedTurn(db, { sessionId: 's1', line: 0, ts: 1 });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.topFiles).toEqual([]);
  });

  it('counts only writing tools — reading a file is not touching it', async () => {
    seedWrite('s1', 0, 'Read', '/wt/read-only.ts');
    seedWrite('s1', 100, 'Grep', '/wt/searched.ts');
    seedWrite('s1', 200, 'Edit', '/wt/written.ts');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.topFiles).toEqual(['written.ts']);
  });

  it('de-duplicates basenames that collide across directories', async () => {
    seedWrite('s1', 0, 'Edit', '/wt/src/index.ts');
    seedWrite('s1', 100, 'Edit', '/wt/src/index.ts');
    seedWrite('s1', 200, 'Edit', '/wt/test/index.ts');
    seedWrite('s1', 300, 'Edit', '/wt/src/other.ts');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    const files = (await listPastSessions())[0]?.topFiles ?? [];
    expect(files).toEqual(['index.ts', 'other.ts']);
    expect(new Set(files).size).toBe(files.length);
  });

  it('ignores null and blank target paths', async () => {
    seedWrite('s1', 0, 'Edit', null);
    seedWrite('s1', 100, 'Edit', '   ');
    seedWrite('s1', 200, 'Edit', '/wt/real.ts');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    expect((await listPastSessions())[0]?.topFiles).toEqual(['real.ts']);
  });

  it('keeps sessions separate', async () => {
    seedWrite('s1', 0, 'Edit', '/wt/a.ts');
    seedWrite('s2', 0, 'Edit', '/wt/b.ts');
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w' });
    seedTranscriptFile(db, { path: '/p/s2.jsonl', sessionId: 's2', cwd: '/w' });
    const rows = await listPastSessions();
    const byId = new Map(rows.map((r) => [r.sessionId, r.topFiles]));
    expect(byId.get('s1')).toEqual(['a.ts']);
    expect(byId.get('s2')).toEqual(['b.ts']);
  });
});


// ---------------------------------------------------------------------------

describe('backfillProjectsFromTasks — worktree resolution, and never creating', () => {
  /** git's answer: every `<repo>-<SUFFIX>` directory is a worktree of `<repo>`. */
  const resolveWorktrees = async (path: string): Promise<string> => {
    const m = /^(.*\/acme)-[A-Z0-9-]+$/.exec(path);
    return m ? (m[1] as string) : path;
  };

  async function seedTask(repoPath: string, projectId: number | null = null): Promise<number> {
    const res = await db.execute(
      `INSERT INTO tasks (title, project_id, repo_path, base_branch, branch, worktree_path,
                          session_id, owns_worktree, status, created_at, last_activity_at)
       VALUES ('t', $1, $2, 'main', 'b', $2, NULL, 1, 'idle', 1, NULL)`,
      [projectId, repoPath],
    );
    return res.lastInsertId as number;
  }

  it('links a task in a WORKTREE to the existing project, creating nothing', async () => {
    // Exactly the user's database: a task in /Users/dev/www/acme-ACME-2368
    // used to produce a second project named after the worktree folder.
    const real = await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/Users/dev/www/worktrees', defaultBaseBranch: null,
    });
    const taskId = await seedTask('/Users/dev/www/acme-ACME-2368');

    const result = await backfillProjectsFromTasks(resolveWorktrees);

    const projects = await listProjectsRaw();
    expect(projects).toHaveLength(1); // not 2
    expect(projects[0]?.name).toBe('acme');
    expect(await projectIdOf(taskId)).toBe(real.id);
    expect(result.relinked).toBe(1);
  });

  it('CREATES NO PROJECTS, whatever the input — the invariant', async () => {
    await seedTask('/Users/dev/www/never-seen-before');
    await seedTask('/Users/dev/www/acme-ACME-9999');
    await seedTask('/some/other/repo');
    await seedTask('   ');

    const result = await backfillProjectsFromTasks(resolveWorktrees);

    expect(await listProjectsRaw()).toHaveLength(0);
    expect(result.relinked).toBe(0);
    expect(result).not.toHaveProperty('created');
  });

  it('leaves an unmatched task in "Other" rather than inventing a home', async () => {
    const taskId = await seedTask('/Users/dev/www/unknown-repo');
    await backfillProjectsFromTasks(resolveWorktrees);
    expect(await projectIdOf(taskId)).toBeNull();
    expect(await listProjectsRaw()).toHaveLength(0);
  });

  it('collapses several worktrees of one repo onto that one project', async () => {
    const real = await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    const a = await seedTask('/Users/dev/www/acme-ACME-2368');
    const b = await seedTask('/Users/dev/www/acme-PLATFORM-1NF');
    const c = await seedTask('/Users/dev/www/acme');

    await backfillProjectsFromTasks(resolveWorktrees);

    expect(await listProjectsRaw()).toHaveLength(1);
    for (const id of [a, b, c]) expect(await projectIdOf(id)).toBe(real.id);
  });

  it('repairs a task already linked to a bogus worktree project', async () => {
    // The state the user is actually in right now.
    const real = await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    const bogus = await createProject({
      name: 'acme-ACME-2368', repoPath: '/Users/dev/www/acme-ACME-2368',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    const taskId = await seedTask('/Users/dev/www/acme-ACME-2368', bogus.id);

    const result = await backfillProjectsFromTasks(resolveWorktrees);

    expect(await projectIdOf(taskId)).toBe(real.id);
    // the bogus project is REPORTED, never deleted or merged
    expect(result.worktreeProjects.map((w) => w.project.name)).toEqual(['acme-ACME-2368']);
    expect(result.worktreeProjects[0]?.parent.name).toBe('acme');
    expect(await listProjectsRaw()).toHaveLength(2);
  });

  it('is idempotent across launches', async () => {
    await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    await seedTask('/Users/dev/www/acme-ACME-2368');

    const first = await backfillProjectsFromTasks(resolveWorktrees);
    const second = await backfillProjectsFromTasks(resolveWorktrees);
    const third = await backfillProjectsFromTasks(resolveWorktrees);

    expect(first.relinked).toBe(1);
    expect(second.relinked).toBe(0); // nothing left to do
    expect(third.relinked).toBe(0);
    expect(await listProjectsRaw()).toHaveLength(1);
  });

  it('survives a resolver that throws, falling back to the raw path', async () => {
    const real = await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    const taskId = await seedTask('/Users/dev/www/acme');
    const angry = async (): Promise<string> => {
      throw new Error('not a git repository');
    };
    await expect(backfillProjectsFromTasks(angry)).resolves.toBeDefined();
    // the raw path still matched a project, so the link still happened
    expect(await projectIdOf(taskId)).toBe(real.id);
  });

  it('detects a worktree project without touching it', async () => {
    await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    await createProject({
      name: 'acme-ACME-2368', repoPath: '/Users/dev/www/acme-ACME-2368',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    const found = await findWorktreeProjects(resolveWorktrees);
    expect(found).toHaveLength(1);
    expect(found[0]?.project.repoPath).toBe('/Users/dev/www/acme-ACME-2368');
    expect(found[0]?.parent.repoPath).toBe('/Users/dev/www/acme');
    expect(await listProjectsRaw()).toHaveLength(2); // nothing merged or deleted
  });

  it('does not flag unrelated projects as worktrees of one another', async () => {
    await createProject({ name: 'a', repoPath: '/w/a', worktreeRoot: '/wt', defaultBaseBranch: null });
    await createProject({ name: 'b', repoPath: '/w/b', worktreeRoot: '/wt', defaultBaseBranch: null });
    expect(await findWorktreeProjects(resolveWorktrees)).toEqual([]);
  });

  async function listProjectsRaw() {
    return db.raw.prepare('SELECT id, name, repo_path FROM projects ORDER BY id').all() as {
      id: number; name: string; repo_path: string;
    }[];
  }
  async function projectIdOf(taskId: number): Promise<number | null> {
    const row = db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as
      | { project_id: number | null }
      | undefined;
    return row?.project_id ?? null;
  }
});

describe('listUnclaimedRepos — the import candidates', () => {
  const resolveWorktrees = async (path: string): Promise<string> => {
    const m = /^(.*\/acme)-[A-Z0-9-]+$/.exec(path);
    return m ? (m[1] as string) : path;
  };

  it('offers a repo with captured history that no project claims', async () => {
    seedTurn(db, { sessionId: 's1', line: 0, ts: 5_000 });
    seedTurn(db, { sessionId: 's1', line: 1, ts: 6_000 });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/Users/dev/www/acme' });

    const [repo] = await listUnclaimedRepos(resolveWorktrees);
    expect(repo?.repoRoot).toBe('/Users/dev/www/acme');
    expect(repo?.suggestedName).toBe('acme');
    expect(repo?.sessionCount).toBe(1);
    expect(repo?.messageCount).toBe(2);
    expect(repo?.lastActivityAt).toBe(6_000);
  });

  it('collapses worktree directories onto the repository, listing both', async () => {
    seedTurn(db, { sessionId: 'a', line: 0, ts: 1_000 });
    seedTurn(db, { sessionId: 'b', line: 0, ts: 9_000 });
    seedTranscriptFile(db, { path: '/p/a.jsonl', sessionId: 'a', cwd: '/Users/dev/www/acme' });
    seedTranscriptFile(db, { path: '/p/b.jsonl', sessionId: 'b', cwd: '/Users/dev/www/acme-ACME-2368' });

    const repos = await listUnclaimedRepos(resolveWorktrees);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.sessionCount).toBe(2);
    expect(repos[0]?.lastActivityAt).toBe(9_000);
    expect(repos[0]?.directories.sort()).toEqual([
      '/Users/dev/www/acme',
      '/Users/dev/www/acme-ACME-2368',
    ]);
  });

  it('does not offer a repo a project already claims', async () => {
    await createProject({
      name: 'acme', repoPath: '/Users/dev/www/acme',
      worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    seedTurn(db, { sessionId: 's1', line: 0, ts: 1 });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/Users/dev/www/acme-ACME-2368' });
    expect(await listUnclaimedRepos(resolveWorktrees)).toEqual([]);
  });

  it('treats an ARCHIVED project as claimed — re-offering it would be nagging', async () => {
    const p = await createProject({
      name: 'gone', repoPath: '/w/gone', worktreeRoot: '/wt', defaultBaseBranch: null,
    });
    await archiveProjectRaw(p.id);
    seedTurn(db, { sessionId: 's1', line: 0, ts: 1 });
    seedTranscriptFile(db, { path: '/p/s1.jsonl', sessionId: 's1', cwd: '/w/gone' });
    expect(await listUnclaimedRepos(resolveWorktrees)).toEqual([]);
  });

  it('counts tasks with no project', async () => {
    await db.execute(
      `INSERT INTO tasks (title, project_id, repo_path, base_branch, branch, worktree_path,
                          session_id, owns_worktree, status, created_at, last_activity_at)
       VALUES ('t', NULL, '/w/solo', 'main', 'b', '/w/solo', NULL, 1, 'idle', 1, NULL)`,
    );
    const [repo] = await listUnclaimedRepos(resolveWorktrees);
    expect(repo?.repoRoot).toBe('/w/solo');
    expect(repo?.taskCount).toBe(1);
    expect(repo?.sessionCount).toBe(0);
  });

  it('orders by most recent activity', async () => {
    for (const [id, ts] of [['old', 1_000], ['new', 9_000], ['mid', 5_000]] as const) {
      seedTurn(db, { sessionId: id, line: 0, ts });
      seedTranscriptFile(db, { path: `/p/${id}.jsonl`, sessionId: id, cwd: `/w/${id}` });
    }
    expect((await listUnclaimedRepos(resolveWorktrees)).map((r) => r.repoRoot)).toEqual([
      '/w/new', '/w/mid', '/w/old',
    ]);
  });

  async function archiveProjectRaw(id: number): Promise<void> {
    db.raw.prepare('UPDATE projects SET archived_at = 1 WHERE id = ?').run(id);
  }
});
