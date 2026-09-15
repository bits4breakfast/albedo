-- v5: stop discarding subagent transcripts.
--
-- ## The bug
--
-- Claude Code writes a subagent's transcript to
--   <projectDir>/<parent-session-uuid>/subagents/agent-<agentId>.jsonl
-- and every line in it carries the PARENT's `sessionId`, not one of its own.
--
-- `seq` is file-local by construction (`lineIndex * SEQ_STRIDE + blockIndex`),
-- so a subagent's first line claims seq 0 -- the same seq the parent's first
-- line already claimed under the same session_id. The unique index
-- messages(session_id, seq) then made `INSERT OR IGNORE` do exactly what it
-- says: ignore them. Silently, with no error anywhere, for the whole build.
--
-- Measured on the live corpus before this migration: subagent transcripts
-- would produce 52,092 rows and 5,988 had landed. 89% discarded. 25,567 of the
-- losses collide with the parent transcript directly; the remainder collide
-- with SIBLING subagents, because several run under one parent session and
-- each restarts seq at 0. The database held 45,696 rows where it should have
-- held roughly 92,000 -- more than half of everything captured was missing,
-- including 53% of the corpus the watcher had been specifically fixed to see.
--
-- ## The fix
--
-- agent_id is the third part of the identity that was always implied and never
-- stored. It is NULL for a main-session row and the subagent's `agentId` for a
-- sidechain row -- the same id `<agent-message from="...">` quotes, so a
-- handback in the parent transcript now joins to the transcript it came from.
--
-- session_id deliberately keeps meaning "the parent session". Keying subagent
-- rows by agentId instead would have avoided a migration, but it would have
-- cut the rows off from the task they belong to: every task/session join in
-- the app goes through session_id, and a subagent IS part of its parent's
-- session. This way those joins are untouched and subagent rows simply stop
-- colliding.
--
-- COALESCE, not a plain three-column index: SQLite treats NULLs as distinct in
-- a UNIQUE index, so `(session_id, NULL, seq)` would never conflict with
-- itself and main-session rows would lose the duplicate protection they have
-- today -- which is what makes re-ingesting a tailed file idempotent.
ALTER TABLE messages ADD COLUMN agent_id TEXT;

DROP INDEX IF EXISTS messages_session_seq;
CREATE UNIQUE INDEX IF NOT EXISTS messages_session_seq
  ON messages(session_id, COALESCE(agent_id, ''), seq);

-- Drop the subagent rows that DID land, so the re-ingest can restore them
-- properly.
--
-- The minority of subagent rows that won their collision were written before
-- this column existed, so they sit in the table with agent_id NULL -- which is
-- the value that means "main session". Left alone they would be wrong (their
-- agent unattributable, so invisible to the subagent view) AND duplicated,
-- because the rewind below re-reads the same lines and the unique key now
-- differs. Measured on the live database: re-ingesting without this produced
-- 97,489 rows where 92,302 were expected, the excess being exactly these.
--
-- Identified by their own raw_json rather than by a heuristic: `agentId` is a
-- top-level field Claude Code writes on subagent lines and on nothing else.
-- This is the `raw_json` rule paying for itself -- the rows are deletable only
-- because the original line was kept, and they come back verbatim from the
-- file moments later.
DELETE FROM messages
 WHERE agent_id IS NULL
   AND json_extract(raw_json, '$.agentId') IS NOT NULL;

-- Recover what was dropped.
--
-- `bytes_ingested` is what stops a fully-read file being read again, so the
-- 46,000 rows lost to the old index would stay lost without this: the files
-- are complete on disk and the watcher would never look at them again. Only
-- subagent transcripts are rewound -- main-session files were never affected,
-- and re-reading 218MB of them would cost minutes for nothing.
--
-- Safe to re-run: the unique index above makes re-ingest idempotent, so rows
-- that did land are re-inserted as no-ops rather than duplicated.
UPDATE transcript_files
   SET bytes_ingested = 0, last_seq = -1
 WHERE path LIKE '%/subagents/%';

-- The join a subagent panel needs: "which agents belong to this session".
CREATE INDEX IF NOT EXISTS messages_agent ON messages(session_id, agent_id);
