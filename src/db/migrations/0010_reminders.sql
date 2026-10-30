-- v10: reminders -- a note on a task that comes back at its time as a card.
--
-- Decided by the owner (schema.sql and migrations are a shared contract;
-- issue #156). A reminder belongs to the task it was set on and is kept here,
-- not in local storage: one missed while Albedo was closed fires on the next
-- launch, and a build switch must not lose it.
--
-- What was true when it was set is recorded with it (session, transcript,
-- folder, branch, HEAD), because the task may be archived or deleted by the
-- time it fires. Then Albedo opens a new task in the same project and the
-- card says where the work stood.
--
-- Nothing deletes a row except the person (Delete in the reminders list).
-- Archiving or deleting the task keeps its reminders: that is the case they
-- exist for. Every time is epoch milliseconds, like the tasks table.
CREATE TABLE reminders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The task it was set on. Never changes, and may outlive the task row.
  task_id         INTEGER NOT NULL REFERENCES tasks(id),
  -- The task's project when it was set; where a replacement task is opened.
  project_id      INTEGER REFERENCES projects(id),
  -- What to be reminded of. Any number of lines.
  text            TEXT    NOT NULL,
  -- When it fires. A snooze moves it.
  due_at          INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- 'user' (the reminders dialog) | 'session' (Claude, through Albedo's MCP, #157).
  created_by      TEXT    NOT NULL,
  -- The session the task was on, and its transcript file, when it was set.
  -- NULL when the task had none yet.
  session_id      TEXT,
  transcript_path TEXT,
  -- Where the work was: the repository, the task's folder, its branch and
  -- HEAD. branch is '' for a chat (as in tasks), NULL on a detached HEAD or
  -- when git could not say; head_sha NULL when git could not say.
  repo_path       TEXT    NOT NULL,
  worktree_path   TEXT    NOT NULL,
  branch          TEXT,
  head_sha        TEXT,
  -- The session's own summary, when a session set it (#157). Sent with the
  -- reminder from a replacement task, in place of the last answer.
  brief           TEXT,
  -- 'pending' | 'snoozed' (waiting) | 'fired' (its card is showing) |
  -- 'sent' | 'dismissed' (done). Written explicitly by every insert.
  state           TEXT    NOT NULL,
  -- When it last fired; NULL until then.
  fired_at        INTEGER,
  -- The task whose card shows it: the task it was set on, or the one opened
  -- for it. NULL until it has fired and been delivered.
  card_task_id    INTEGER REFERENCES tasks(id)
);

-- The scheduler's question: what is waiting and due.
CREATE INDEX reminders_due ON reminders(state, due_at);
-- The per-task list, and the cards a task shows.
CREATE INDEX reminders_by_task ON reminders(task_id);
CREATE INDEX reminders_by_card ON reminders(card_task_id);
