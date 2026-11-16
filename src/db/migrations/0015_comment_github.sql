-- v15: where a comment on a review task goes (#287, steps 3 and 4).
--
-- Decided by the owner (schema.sql and migrations are a shared contract;
-- 2026-11-09). On a review task a comment is either a question for the
-- review session, as on any task, or a draft for GitHub that waits for
-- Submit Review; a reply to another reviewer's thread is a draft too.
--
-- github    NULL: for Claude (Ask Claude), as every row before v15 is.
--           'draft': a draft for GitHub, sent with Submit Review.
-- reply_to  NULL, or for a reply to someone else's review thread: the REST
--           id of that thread's first comment, which the reply is posted to.
--           A reply keeps the thread's path and line, and '' as its
--           anchor_text: it hangs on the thread, not on the code.
--
-- sent_at keeps its meaning, "it went": for a draft, GitHub accepted it.
--
-- v15, not v14: #295 takes v14 (0014_guide_focus.sql) in parallel.
ALTER TABLE comments ADD COLUMN github TEXT;
ALTER TABLE comments ADD COLUMN reply_to INTEGER;
