# Claude Code transcript JSONL — observed format

Observed on Claude Code **v2.1.272**, macOS. This is an internal format with no
compatibility contract. Everything documented here is knowledge that must stay
behind `src/capture/adapter.ts`; no other module may encode any of it.

## Location

```
~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl
```

The directory name is the absolute cwd with `/` and `.` replaced by `-`, e.g.
`/Users/dev/www/albedo` → `-Users-dev-www-albedo`. Do not reconstruct the
cwd from the slug — it is lossy. Read the `cwd` field off any line instead.

Files are append-only during a session. Tail by byte offset; never re-read whole.

## Line types seen

| `type` | Notes |
| --- | --- |
| `user` | Human turn, **and** tool results (see below) |
| `assistant` | Model turn; content blocks include `text`, `thinking`, `tool_use` |
| `attachment` | Pasted/att­ached content, has `attachment`, no `message` |
| `system` | Hook output, warnings |
| `summary` | Context-compaction summary |
| `mode`, `permission-mode`, `atis-latch`, `ai-title`, `last-prompt`, `bridge-session`, `queue-operation`, `file-history-snapshot`, `pr-link`, `custom-title`, `agent-name`, `worktree-state`, `relocated`, `cost-state`, `file-history-delta`, `frame-link`, `artifact-autoreact-ledger`, `artifact-comment-monitor` | Bookkeeping. Ignore — do not persist as messages. |

**The adapter is an allowlist, not a denylist.** It persists `user`, `assistant`
and `system` and ignores everything else. The bookkeeping list above was already
incomplete once (ten of those types were found only after the first pass), and
Claude Code adds more between releases. A denylist would silently start writing
a new bookkeeping type into history as if it were conversation; an allowlist
ignores it. `summary` is documented by the format but was not observed in any
file on this machine.

Note also that `user` lines carry an **array of `text` blocks**, not only a
string — both forms map to role `user`. Unknown block types (`image`,
`tool_reference`, anything future) get a placeholder row rather than being
dropped: M1 is irreversible, so over-capture beats losing a line.

## Envelope fields (on `user` / `assistant` lines)

`uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO 8601), `cwd`, `version`,
`gitBranch`, `isSidechain`, `userType`, `message`.

**`sessionId` can change mid-file** after a resume/compaction; trust the field
on each line, not the filename.

`isSidechain: true` marks subagent traffic. Persist it (it is in `raw_json`) but
the transcript pane collapses sidechain rows by default.

## `message` shapes

- assistant: `{ model, id, role, content[], usage, stop_reason, ... }`
- user: `{ role, content }` where content is a **string** for typed prompts and
  an **array** for tool results.

### Content blocks

| block | fields |
| --- | --- |
| `text` | `text` |
| `thinking` | `thinking`, `signature` |
| `tool_use` | `id`, `name`, `input` |
| `tool_result` | `tool_use_id`, `content`, `is_error?` |

`tool_result.content` is a string **or** an array of `{type:"text",text}` blocks.

**`thinking` is empty on disk.** Claude Code persists the block's `signature`
and not the reasoning, so every observed block is
`{ type: "thinking", thinking: "", signature: "..." }`. Reading another field
will not recover it. Keep the rows anyway: the row marks where the model
reasoned, `raw_json` keeps the signature, and if the text is ever persisted the
rows are already in place.

### `usage`

`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, plus fields that come and go. Read defensively.

## `toolUseResult`

Top-level on the `user` line that carries a `tool_result`. Shape varies by tool:

- Bash → `{ stdout, stderr, interrupted, isImage, noOutputExpected }`
- Edit/Write → object with `filePath`, `oldString`, `newString` (or `structuredPatch`)
- Read → `{ file: { filePath, content, numLines } }`
- Grep/Glob → array, or `{ matches, query }`
- string, for several tools

Treat it as `unknown` and narrow per tool name. Never assume a key exists.

## Compaction (Claude Code 2.1.309-2.1.310)

Not the `summary` line type. A compaction writes, back to back:

1. `type: "system"`, `subtype: "compact_boundary"`, `content: "Conversation
   compacted"`, `parentUuid: null` (`logicalParentUuid` names the last line
   before it), and `compactMetadata`: `trigger` (`auto` / `manual`),
   `preTokens`, `durationMs`, `preservedSegment`, `postTokens`, …
2. `type: "user"`, `isCompactSummary: true`, `isVisibleInTranscriptOnly: true`,
   `parentUuid` = the boundary's `uuid`: the summary, as string content. It
   carries a `<tools-used-before-summary>` tag after its opening sentence.

The summary's `timestamp` is ~8 ms **earlier** than the boundary's (16 of 16
measured), so a ts-ordered read returns it first. The pane pairs them by
adjacency and `parentUuid` (`src/ui/transcript/compaction.ts`). The preserved
recent messages are not written again after the boundary.

A compaction while idle is followed ~450 ms later, with only `attachment`
lines between, by `type: "system"`, `subtype: "informational"`, `level:
"notice"` ("Compacted while idle, …"). `trigger` still says `auto`, and
`informational` is used for other notices too, so the transcript has no field
marking it as idle: the pane recognises it only by its position.

## Permission prompts (status = `blocked`)

There is no explicit "waiting for permission" line. A session is blocked when the
last persisted line is an `assistant` line whose final content block is a
`tool_use` **and** no matching `tool_result` has arrived. A denial arrives as a
`user` line carrying `toolDenialKind`.

## Rows Albedo persists

Each JSONL line may expand into several `messages` rows:

| source | role |
| --- | --- |
| `user` line, string content | `user` |
| `user` line, `tool_result` block | `tool_result` (one row per block) |
| `assistant` line, `text`/`thinking` block | `assistant` |
| `assistant` line, `tool_use` block | `tool_use` (one row per block) |
| `system` line | `system` |

`seq` is `lineIndex * 100 + blockIndex` so ordering is stable and a line can
expand into blocks without renumbering.
