-- v9: when the user last had each task open.
--
-- Decided by the owner (schema.sql and migrations are a shared contract;
-- issue #90). The task list lifts a task into Ready to Review when a turn
-- ended after this and the branch has work on it; opening the task sets it.
-- Epoch milliseconds, like every other time in this table. Kept here rather
-- than in local storage: a status must not be lost or diverge across builds.
--
-- NULLABLE: NULL is "never opened", so any finished turn is unseen. Every row
-- that exists already is backfilled to now, the moment this applies -- nothing
-- tracked what was seen before, and the safe reading of that is "seen", not a
-- Ready to Review group holding every task with a branch the first time the
-- app starts.
ALTER TABLE tasks ADD COLUMN seen_at INTEGER;
UPDATE tasks SET seen_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
