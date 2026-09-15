-- Albedo schema. Applied by tauri-plugin-sql migrations on startup.
-- raw_json is kept on every row: if the transcript adapter needs fixing later,
-- history is reprocessed rather than lost.

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,        -- idle | running | blocked | done | archived
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,          -- user | assistant | system | tool_use | tool_result
  tool_name TEXT,
  target_path TEXT,
  body TEXT,
  raw_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);

-- Capture runs for sessions started outside the app too, so a message may have
-- no task yet. session_id is the join key; task_id is backfilled on adoption.
CREATE UNIQUE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, seq);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);

-- Watcher bookkeeping: how far into each transcript file we have ingested.
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  cwd TEXT,
  bytes_ingested INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT -1,
  mtime INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(body, content=messages, content_rowid=id);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
