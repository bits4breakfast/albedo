-- v19: messages_au fires only when `body` or `id` is written (#361).
--
-- schema.sql's update trigger was `AFTER UPDATE ON messages`: every UPDATE,
-- whatever it set, deleted the row from messages_fts and indexed its body
-- again. The only UPDATE on messages sets task_id (adoptSessionIntoTask),
-- which re-indexed every row of the adopted session for an unchanged body.
--
-- `UPDATE OF id, body` fires whenever either is in the SET list, changed or
-- not, so every update that can change what the index holds (the text, or
-- the rowid it is filed under) re-indexes exactly as before. One that names
-- neither leaves old.id = new.id and old.body = new.body, and deleting then
-- re-adding the same text under the same rowid leaves the index as it was:
-- skipping it changes nothing that search returns.
--
-- schema.sql is migration v1 and is never edited; the trigger is replaced
-- here instead.
DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER messages_au AFTER UPDATE OF id, body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
