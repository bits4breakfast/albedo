-- v18: previews -- HTML mockups a session showed the user for approval (#348).
--
-- Decided by the owner (schema.sql and migrations are a shared contract;
-- issue #348, 2026-11-11). A session calls Albedo's `show_preview` with the
-- path of an HTML file it wrote; Albedo's MCP server copies the file at that
-- moment, and the app keeps the copy here. Each call is one frozen version,
-- numbered per task and title (v1, v2, ...), so the version the user
-- reviews never changes under them, and the transcript's chip can open any
-- version afterwards.
--
-- The HTML is not `raw_json`: it is a copy of a file the session wrote, kept
-- for viewing, and it goes with the task's history (purgeTaskHistory: archive
-- and delete).
--
-- request_id   the server's id for the call; names its answer file
--              (`~/.albedo/previews/answer-<task>-<request_id>.json`).
-- tool_use_id  Claude Code's id for the call in the transcript, when it gave
--              one: how the chip finds its version, and how the card retires
--              when the transcript records the call's result.
-- outcome      'pending' while the call waits, then 'approved', 'changes'
--              (changes requested), or 'cancelled' (Esc, Claude Code's own
--              timeout, or the session ending).
-- answer       the text sent as the call's result, NULL until answered.
CREATE TABLE previews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id),
  request_id   TEXT    NOT NULL UNIQUE,
  tool_use_id  TEXT,
  title        TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  html         TEXT    NOT NULL,
  question     TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  outcome      TEXT    NOT NULL,
  answer       TEXT,
  answered_at  INTEGER
);

-- A task's versions of one title, newest last; and the chip's lookup.
CREATE INDEX previews_by_task ON previews(task_id, title, version);
CREATE INDEX previews_by_tool_use ON previews(tool_use_id);
