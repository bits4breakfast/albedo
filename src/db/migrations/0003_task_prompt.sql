-- v3: per-project initial-prompt template for issue-keyed tasks.
--
-- The user names a task with a tracker key (UP-2398) and expects the session to
-- pick it up. Albedo does NOT look the issue up -- Claude Code already has the
-- tracker's MCP -- so this only has to name the key in the prompt the session
-- starts with. Placeholders: {key}, {title}, {branch}.
--
-- NULL/empty means no initial prompt, which is the default: silently prompting
-- an agent the user just launched is a side effect they did not ask for.

ALTER TABLE projects ADD COLUMN task_prompt_template TEXT;
