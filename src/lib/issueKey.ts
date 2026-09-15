/**
 * Tracker issue keys in task titles.
 *
 * The user names a task `UP-2398 fix the login loop` and expects the branch,
 * the worktree and the task row to pick the key up. This module is the only
 * place that decides what a key looks like.
 *
 * **Albedo does not talk to Linear, or to any tracker.** It recognises the key
 * and names it in the prompt the session starts with; Claude Code's own MCP
 * does the lookup. That keeps tracker credentials out of the app and works
 * unchanged for key families Albedo has never heard of.
 *
 * Pure: no I/O, no Tauri. Owner: worktree workstream (M3).
 */

export interface IssueRef {
  /** The key exactly as it appeared, e.g. `UP-2398`. */
  key: string;
  /** What followed it, separators trimmed. Empty when the title was just the key. */
  rest: string;
}

/**
 * `PROJ-SUFFIX` anchored at the start of the title.
 *
 *  - prefix: 2-10 uppercase letters. Two is the floor because a single letter
 *    turns "E-mail the team" into the key `E-mail`.
 *  - suffix: uppercase alphanumerics. `PLATFORM-19T` is real, so it is not
 *    digits-only; `HUB-429902396650` is real, so it is not short.
 */
const ISSUE_KEY = /^([A-Z]{2,10})-([A-Z0-9]{1,20})/;

/**
 * What is allowed to follow a key. **An explicit list, checked separately from
 * the regex**, because this is the rule that decides identity and it should be
 * readable and testable on its own rather than inferred from a lookahead.
 *
 * Anything not in here means the match was a prefix of a longer token, and the
 * whole title is treated as plain text. That is the safe direction, and the
 * asymmetry is worth spelling out:
 *
 *  - Over-matching `UP-2398_v2` yields the key `UP-2398`, and since the
 *    worktree directory is the *bare key*, it collides with the real UP-2398 —
 *    a different issue, same folder. The user names tasks by key precisely so
 *    identity is unambiguous; silently truncating it is the worst failure here.
 *  - Under-matching costs a chip in the dialog and a placeholder in a prompt.
 *    The title still slugs into a perfectly good branch (`up-2398-v2`), which
 *    is distinct from UP-2398 and collides with nothing.
 *
 * `-` is included because `UP-2398-followup` is a branch the user already has;
 * `:` and `,` because a title naturally continues after them. `.` `_` `/` are
 * NOT included: they read as part of one identifier, which is the ambiguity
 * this list exists to refuse.
 */
export const KEY_TERMINATORS: readonly string[] = [
  ' ',
  '\t',
  '\n',
  '\r',
  '-',
  ':',
  ',',
  '\u2013', // en dash
  '\u2014', // em dash
];

/**
 * Prefixes that fit the shape but are standards, formats or codecs rather than
 * trackers. Measured false positives, not speculation: each one is a phrase a
 * developer plausibly types at the start of a task title, and each would
 * otherwise become a branch name and a worktree directory.
 *
 * A veto here costs a user with a genuine `UTF-*` tracker one renamed branch;
 * no veto costs every user who writes "UTF-8 encoding is broken" a directory
 * called `UTF-8`. Extend it when a new one shows up -- it is a list, not a
 * cleverness.
 */
const NOT_TRACKERS = new Set([
  'UTF',
  'ISO',
  'RFC',
  'ASCII',
  'MP3',
  'MP4',
  'SHA',
  'MD5',
  'IPV4',
  'IPV6',
  'COVID',
  'ES',
  'CSS',
  'HTML',
]);

/**
 * Trimmed off the front of `rest`. Deliberately the same character set as
 * {@link KEY_TERMINATORS} -- a character good enough to end a key is a
 * separator, and nothing else is.
 */
const LEADING_SEPARATORS = /^[\s\-:,\u2013\u2014]+/;

/**
 * Pull a leading tracker key off a task title, or null when there isn't one.
 *
 * Deliberately conservative in three ways, because a key that matches too
 * eagerly renames a branch and a directory wrongly:
 *
 *  1. **Anchored.** `Fix UP-2398 later` does not match. A key mentioned in
 *     passing is not the same as a task named after one.
 *  2. **The suffix must contain a digit.** `ABC-DEF` is a hyphenated phrase,
 *     not an issue. This is what keeps ordinary English out.
 *  3. **Uppercase only.** `up-2398` and `TODO-list` do not match.
 *
 * The cost of being wrong is asymmetric but not destructive -- the new-task
 * dialog shows the detected key and the branch and path it produces before
 * anything is created, so a bad guess is visible and the user can retitle.
 */
export function parseIssueKey(title: string): IssueRef | null {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;

  const m = ISSUE_KEY.exec(trimmed);
  if (!m) return null;

  const prefix = m[1];
  const suffix = m[2];
  if (prefix === undefined || suffix === undefined) return null;

  // An issue number is a number. Without this, every hyphenated capitalised
  // phrase is a key.
  if (!/[0-9]/.test(suffix)) return null;
  if (NOT_TRACKERS.has(prefix)) return null;

  const key = `${prefix}-${suffix}`;

  // The identity check: the key has to END here. `UP-2398_v2` and `UP-2398a`
  // are single tokens that merely start like a key, and calling either one
  // `UP-2398` would point the task at the wrong issue.
  const next = trimmed.charAt(key.length);
  if (next !== '' && !KEY_TERMINATORS.includes(next)) return null;
  const rest = trimmed.slice(key.length).replace(LEADING_SEPARATORS, '').trim();
  return { key, rest };
}

/** True when `title` is exactly a key and nothing else. */
export function isBareIssueKey(title: string): boolean {
  const ref = parseIssueKey(title);
  return ref !== null && ref.rest.length === 0;
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

/** Values a per-project prompt template can name. */
export interface PromptVars {
  /** Full task title, exactly as typed. */
  title: string;
  /** Branch the worktree was cut on. */
  branch: string;
}

/** The placeholders, in the order the projects dialog lists them. */
export const PROMPT_PLACEHOLDERS = ['{key}', '{rest}', '{title}', '{branch}'] as const;

/**
 * Expand a per-project prompt template.
 *
 * Lives here, next to the parser, so there is **one** implementation: the
 * projects dialog previews the result and the shell sends it at spawn, and two
 * `.replaceAll` chains that drift would mean the preview quietly lying about
 * what the agent will be told.
 *
 * `{key}` is empty when the title has none, and `{rest}` falls back to the full
 * title — so a template written for keyed tasks degrades to something sensible
 * rather than to a sentence with a hole in it.
 *
 * Returns null for a template that is empty, or that expands to nothing: the
 * caller should then pass no prompt argument at all rather than an empty one.
 */
export function fillPromptTemplate(
  template: string | null | undefined,
  vars: PromptVars,
): string | null {
  const t = (template ?? '').trim();
  if (t.length === 0) return null;

  const issue = parseIssueKey(vars.title);
  const filled = t
    .replaceAll('{key}', issue?.key ?? '')
    .replaceAll('{rest}', issue?.rest || vars.title)
    .replaceAll('{title}', vars.title)
    .replaceAll('{branch}', vars.branch)
    .trim();

  return filled.length > 0 ? filled : null;
}
