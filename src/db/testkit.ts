/**
 * src/db/testkit.ts
 *
 * A REAL SQLite database for tests, standing in for tauri-plugin-sql.
 *
 * ### Why this exists
 *
 * Every query in this layer used to be covered structurally -- tests asserted
 * on the SQL string, not on what it returned. That is not the same thing. A
 * session-browser query that filtered which ROWS were counted instead of which
 * SESSIONS were listed passed every structural assertion and, run against real
 * data, reported 37 sessions as having ~3 messages each when they had ~559. A
 * 168x error that would have rendered as small, plausible numbers in the UI.
 * The same class of bug produced the cache_read overcount.
 *
 * So: GROUP BY, LEFT JOIN, HAVING, FTS5 and the messages_fts triggers all get
 * executed here rather than pattern-matched.
 *
 * ### TEST-ONLY. Never import this from application code.
 *
 * `better-sqlite3` is a devDependency and a native module. The app talks to
 * SQLite exclusively through tauri-plugin-sql; a second SQLite engine in the
 * bundle would be real cost for no user benefit. Importing this file from
 * anything under src/ that ships will fail the production build loudly, which
 * is the intended guard.
 *
 * ### The schema is the SHIPPED schema
 *
 * Applied from src/db/schema.sql (migration v1) followed by every file in
 * src/db/migrations/ in filename order, picked up by glob. A new migration is
 * therefore exercised by these tests the moment it is added, and a
 * hand-maintained test schema cannot drift away from the real one -- a drifted
 * copy would be worse than no test at all.
 */

import BetterSqlite3 from 'better-sqlite3';

import schemaSql from './schema.sql?raw';

const migrationSources = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Migration files in application order, newest last. */
export function migrationsInOrder(): { name: string; sql: string }[] {
  return Object.keys(migrationSources)
    .sort()
    .map((name) => ({ name, sql: migrationSources[name] as string }));
}

/**
 * The subset of tauri-plugin-sql's `Database` the app actually calls.
 * Structural, so the shim can be handed straight to a `Database.load` mock.
 */
export interface SqlDriver {
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  close(): Promise<boolean>;
}

export interface TestDb extends SqlDriver {
  /** Escape hatch for seeding and for assertions the app layer cannot make. */
  raw: BetterSqlite3.Database;
  /** Every statement the app layer issued, for the rare structural assertion. */
  log: { sql: string; binds: unknown[] }[];
}

/**
 * Rewrite tauri-plugin-sql's `$1, $2, ...` placeholders to positional `?`.
 *
 * Occurrence order drives the bind order, so a query that binds the same value
 * twice (`$1 ... $1`) or references them out of order still works. JSON paths
 * such as `'$.message.usage.input_tokens'` are untouched: `$` there is followed
 * by `.`, not a digit.
 */
export function toPositional(
  sql: string,
  binds: unknown[],
): { sql: string; binds: unknown[] } {
  const ordered: unknown[] = [];
  const rewritten = sql.replace(/\$(\d+)/g, (_m, digits: string) => {
    ordered.push(binds[Number(digits) - 1]);
    return '?';
  });
  return { sql: rewritten, binds: ordered.map(coerceBind) };
}

/**
 * sqlx maps JS booleans to 0/1 and `undefined` to NULL on its way through the
 * IPC bridge; better-sqlite3 rejects both outright. Match sqlx so a test does
 * not fail on a value the real driver would have accepted.
 */
function coerceBind(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

/**
 * Fresh in-memory database with the shipped schema applied.
 *
 * In-memory keeps each test isolated and costs nothing to tear down; no test
 * ever touches the user's real database.
 */
export function createTestDb(): TestDb {
  const db = new BetterSqlite3(':memory:');

  // MATCH THE SHIPPED DRIVER, not better-sqlite3's own preference.
  //
  // better-sqlite3 turns foreign keys ON by default; tauri-plugin-sql never
  // issues `PRAGMA foreign_keys = ON`, so in the real app the REFERENCES
  // clauses in schema.sql are documentation, not enforcement. Leaving them on
  // here would make tests fail on inserts production accepts (and, worse, pass
  // on orderings production would reject), which is the same drift the
  // "schema must come from the real migration files" rule exists to prevent.
  //
  // If we ever enable foreign keys in the app, flip this and expect fallout:
  // messages.task_id and tasks.project_id are both nullable references that
  // the capture path writes before the referent necessarily exists.
  db.pragma('foreign_keys = OFF');

  db.exec(schemaSql);
  for (const { name, sql } of migrationsInOrder()) {
    try {
      db.exec(sql);
    } catch (err) {
      throw new Error(`migration ${name} failed to apply: ${(err as Error).message}`);
    }
  }

  const log: { sql: string; binds: unknown[] }[] = [];

  return {
    raw: db,
    log,
    async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
      log.push({ sql: query, binds: bindValues });
      const p = toPositional(query, bindValues);
      return db.prepare(p.sql).all(...(p.binds as never[])) as T;
    },
    async execute(query: string, bindValues: unknown[] = []) {
      log.push({ sql: query, binds: bindValues });
      const p = toPositional(query, bindValues);
      const info = db.prepare(p.sql).run(...(p.binds as never[]));
      return {
        rowsAffected: info.changes,
        lastInsertId: Number(info.lastInsertRowid),
      };
    },
    async close() {
      db.close();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedTurn {
  sessionId: string;
  /** JSONL line index; seq is derived as lineIndex * 100 + blockIndex. */
  line: number;
  blocks?: { role: string; body: string | null; toolName?: string; targetPath?: string }[];
  ts: number;
  taskId?: number | null;
  usage?: {
    input?: number;
    output?: number;
    cacheCreation?: number;
    cacheRead?: number;
  };
}

/**
 * Insert one assistant TURN as the adapter would: several `messages` rows that
 * all carry the same verbatim raw_json. That duplication is the shape every
 * per-line aggregate has to de-duplicate, so seeding it faithfully is the
 * whole point of these fixtures.
 */
export function seedTurn(db: TestDb, turn: SeedTurn): void {
  const raw = JSON.stringify({
    type: 'assistant',
    sessionId: turn.sessionId,
    timestamp: new Date(turn.ts).toISOString(),
    cwd: '/seed/cwd',
    message: {
      model: 'claude-test',
      role: 'assistant',
      content: [{ type: 'text', text: 'seeded' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: turn.usage?.input ?? 0,
        output_tokens: turn.usage?.output ?? 0,
        cache_creation_input_tokens: turn.usage?.cacheCreation ?? 0,
        cache_read_input_tokens: turn.usage?.cacheRead ?? 0,
      },
    },
  });

  const blocks = turn.blocks ?? [{ role: 'assistant', body: 'seeded' }];
  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO messages
       (task_id, session_id, seq, role, tool_name, target_path, body, raw_json, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  blocks.forEach((b, i) => {
    stmt.run(
      turn.taskId ?? null,
      turn.sessionId,
      turn.line * 100 + i,
      b.role,
      b.toolName ?? null,
      b.targetPath ?? null,
      b.body,
      raw,
      turn.ts,
    );
  });
}

/** Register a transcript file row, which is where cwd and title come from. */
export function seedTranscriptFile(
  db: TestDb,
  rec: { path: string; sessionId: string; cwd?: string | null; title?: string | null; updatedAt?: number },
): void {
  db.raw
    .prepare(
      `INSERT INTO transcript_files
         (path, session_id, project_dir, cwd, title, bytes_ingested, last_seq, mtime, updated_at)
       VALUES (?, ?, 'seed', ?, ?, 0, -1, NULL, ?)`,
    )
    .run(
      rec.path,
      rec.sessionId,
      rec.cwd ?? null,
      rec.title ?? null,
      rec.updatedAt ?? 0,
    );
}
