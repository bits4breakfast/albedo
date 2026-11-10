-- v14: what a project's Review Guides set aside and flag (#295).
--
-- Decided by the owner (schema.sql and migrations are a shared contract;
-- issue #295, 2026-11-09). Each is a JSON array of glob patterns, matched on
-- the paths git reports (src/guide/focus.ts):
--
--   guide_set_aside  files put in the guide's own Set Aside group, listed
--                    last, and never sent to the Guide writer
--   guide_careful    files marked "review carefully"
--
-- They are the defaults the Write Guide screen starts from; a guide keeps
-- the lists it was written with.
--
-- NULLABLE, no backfill: NULL is Albedo's starting set (focus.ts), which
-- every project before v14 reads as. '[]' is "none".
ALTER TABLE projects ADD COLUMN guide_set_aside TEXT;
ALTER TABLE projects ADD COLUMN guide_careful TEXT;
