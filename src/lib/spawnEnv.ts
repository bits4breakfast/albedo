/**
 * Hard rule 3 for processes spawned through the Tauri shell plugin: no process
 * Albedo starts carries the Anthropic credentials. An inherited key reaching a
 * `claude` silently bills the API instead of the subscription -- and git runs
 * hooks (post-checkout on `worktree add`), gh runs extensions, and either may
 * start one.
 *
 * The plugin merges `env` into the inherited environment and cannot remove a
 * variable (leaving `env` out clears nothing; `null` clears everything), so the
 * keys are blanked. The ptys and the one-shot run remove them and `unset` them
 * after the login shell's profile instead (src-tauri/src/pty.rs, STRIPPED_ENV).
 */
export const BLANKED_ANTHROPIC_ENV: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
});

/** `env` with the Anthropic credentials blanked; nothing in `env` can restore them. */
export function withoutAnthropicKeys(env?: Record<string, string>): Record<string, string> {
  return { ...env, ...BLANKED_ANTHROPIC_ENV };
}
