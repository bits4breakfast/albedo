-- v7: review comments -- notes left on a task's files, sent to Claude Code.
--
-- Decided by the owner (schema.sql and migrations are a shared contract).
-- A comment covers a range of lines in one file of the task's worktree, and
-- keeps a verbatim copy of those lines: when the agent edits the file the
-- comment is re-found by that text (src/lib/anchor.ts), and when the text is
-- gone it is shown as outdated rather than pinned to whatever now sits at the
-- old line numbers.
--
-- Nothing deletes a row except the person (Delete) and the task going away
-- (purgeTaskHistory: archive, delete, and the startup sweep of archived tasks).
-- Resolving only stamps resolved_at.
CREATE TABLE comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  -- Worktree-relative.
  path        TEXT    NOT NULL,
  -- 1-based, inclusive: where the comment was last found.
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL,
  -- The commented lines as they were, joined with \n.
  anchor_text TEXT    NOT NULL,
  -- What the person wrote. Any number of lines.
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- When it was sent to Claude Code; NULL until then.
  sent_at     INTEGER,
  -- When it was marked done; NULL while open.
  resolved_at INTEGER
);

CREATE INDEX comments_by_task ON comments(task_id, path);
