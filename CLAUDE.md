# Albedo

Personal desktop cockpit for running multiple Claude Code sessions. **Wraps**
Claude Code, never replaces it.

## Two channels, strictly separated

| Channel | Direction | Purpose |
| --- | --- | --- |
| pty (`src-tauri/src/pty.rs`) | bidirectional | Execution only. Output is **opaque** — never parsed. |
| transcript JSONL on disk | read only | All structured data: search, history, status, diffs. |

A third, narrow channel exists by the owner's decision: **hook events**
(`src/capture/hookEvents.ts`). Claude Code writes the turn it is waiting on to
the transcript only once the turn ends, so an approval question or permission
prompt is invisible there while it waits. Albedo spawns `claude` with a
`--settings` block whose hooks append one JSON line per event to
`~/.albedo/events/task-<id>.jsonl`; the app reads that file. It is structured
and never terminal bytes. It is used for exactly one thing -- "this task is
waiting on you, on what, and here is the user's answer" -- and nothing else may
be built on it without the same decision. `hookEvents.ts` is the only file that
knows the hook payload shape.

It is no longer purely read-only, and this is the whole of the widening: the
`PermissionRequest` hook waits (up to an hour) for
`answer-<task>-<request>.json` and prints it as its documented decision. Albedo
writes that file only from a click on the "waiting on you" card -- Allow, Deny,
"don't ask again" for a plain allow-rule suggestion, or AskUserQuestion answers
-- and only while that exact request is still pending. Measured on Claude Code
2.1.302: the terminal dialog is shown and usable the whole time, answering
there first kills the waiting hook (so a late card answer can never apply), and
a hook that times out decides nothing. Nothing writes an answer on its own, and
keystrokes are not used: the pty stays input-only and unread.

A second, equally narrow widening, by the owner's decision (2026-10-20): the
`SessionStart` line keeps `session_id` and `source`, and nothing else from that
payload. It exists so a task follows `/clear` and `/resume` typed inside Claude
Code. That is the whole of it.

A third, by the owner's decision (2026-10-20): the `--settings` block also sets
Claude Code's `statusLine` to the same script in `status` mode. It keeps the
plan's five-hour and seven-day used percentage and reset time, the context used
percentage and window size, and the session id -- nothing else -- in one
`status-<id>.json` replaced on each refresh, and prints nothing (Albedo's
terminals have no status line). It feeds the status strip's plan meters and
the context window size; `hookEvents.ts` (STATUS_SNAPSHOT) is still the only
file that knows the shape.

A fourth, by the owner's decision (issue #42): Claude Code's workspace trust
dialog comes before any hook runs and before there is a transcript, so neither
channel sees it. Before spawning, Albedo reads
`projects[<path>].hasTrustDialogAccepted` from `~/.claude.json` -- that flag
and nothing else from that file, read only, never written -- to know the
dialog is coming. It shows "waiting on you" until the session's first
`SessionStart` hook event, which fires only once the folder is trusted, and
says the answer is in the terminal. Anything it cannot read means "unknown",
and unknown shows nothing. `src/capture/workspaceTrust.ts` is the only file
that knows this.

A fifth, by the owner's decision (issue #157): every session Albedo starts
also gets Albedo's own MCP server through `--mcp-config` (additive, never
`--strict-mcp-config`, so the user's servers still load). It is a small Rust
binary bundled beside the app (`src-tauri/mcp`, a sidecar; no Node, no
network, no port), and Albedo sets `ALBEDO_TASK_ID` in its environment: that
id, set at spawn, is the caller's whole identity, and nothing in a request
can name another task. It offers three tools and nothing else --
`create_reminder`, `request_session`, `notify_blocked` -- for things only the
agent starts; whatever the user starts goes through Albedo directly. A call
that passes its checks is appended as one JSON line to
`~/.albedo/inbox/task-<id>.jsonl`, and the app checks every line again (known
tool, size caps, the task id in the line equal to the file's). A session
request is never acted on without the user: it waits in Requests until they
approve it, and approving only opens New Task filled in from it. Nothing
flows back to the session. `src/capture/inbox.ts` is the only file in the app
that knows the line's shape.

## Which session a task is on

A restart resumes `tasks.session_id`, so that value is a fact, never a guess.
Albedo chooses it before `claude` runs (`--session-id` for a new session, the
id it resumes or forks to otherwise; `src/ui/sessionSpawn.ts`), and the
SessionStart hook corrects it when the terminal moves to another session.
`src/capture/sessionLink.ts` is the only code that changes it, and it logs
every change to `~/.albedo/logs/sessions.jsonl`. Capture finds a transcript's
task by session id. A folder decides only for a worktree Albedo cut for one
task, and never for a shared folder such as the main checkout. Matching by
folder was the restart bug: every session started in the main checkout
overwrote the task's id.

Violating this separation is the one architectural mistake that matters.
If you find yourself regexing terminal bytes, stop — the answer is in SQLite.

**One boolean is permitted, and it is not a precedent.** `Terminal.tsx` tracks
whether the pty produced *any bytes at all*, to tell a rejected `--resume`
(non-zero exit, zero output) from a session the user ended themselves. It counts
that bytes arrived and never looks at them, so it is immune to any change in what
Claude Code renders — which is the entire reason the rule exists. Looking *at*
the bytes is still forbidden.

## PHPantom: navigation only, PHP only

The editor spec says no LSP. The owner made one narrow exception
(`src/lsp/phpantom.ts`): the PHPantom language server answers Go to
Declaration, Find Usages and Go to Implementation (`textDocument/definition`,
`textDocument/references` and `textDocument/implementation`; the last added
by the owner's decision, 2026-10-23), nothing else -- no completion, no
diagnostics, no formatting, and its PHPStan/PHPCS/PHPMD/Mago runners are switched off in the
config Albedo writes. It is optional: `./build.sh --with-phpantom` bundles a
pinned, checksummed binary into the app as a Tauri sidecar, and
`scripts/install-phpantom.sh` puts one in `~/.albedo/bin` (the bundled copy
wins). Albedo itself never downloads anything. It starts
only when a `.php` file is opened or navigated from, and git grep
(`src/git/phpRefs.ts`) answers whenever it cannot. It is a native binary, not
a Node sidecar. Its index lives in memory and goes stale unless told: every
running server has a watcher on its worktree, and that watcher is not
optional.

## Hard rules

1. **Only `src/capture/adapter.ts` knows the JSONL format.** Everything else
   consumes `Message` from `src/types.ts`. A format change must be a one-file fix.
2. **Never drop `raw_json`.** History is reprocessable only if the original is kept.
3. **Strip `ANTHROPIC_API_KEY`** from every spawned environment — an inherited key
   silently bills the API instead of the subscription.
4. The Agent SDK is not used, and there is no Node sidecar.
5. `src/types.ts` and `src/db/schema.sql` are shared contracts. Propose changes,
   do not make them unilaterally.

## Contrast

The first thing the user said after running this app was that they could not
read it. Three rules came out of the fix:

1. **4.5:1 is a floor, not a preference.** Measure against `--panel-raised` —
   selected and hovered rows, i.e. the row most likely being read. Measuring
   against `--bg` alone flattered `--muted` to 4.24 when it was really 3.18.
2. **Never dim text with `opacity`.** It composites *after* the token is chosen,
   so it silently undoes the contrast that token guaranteed, and it is invisible
   to any audit of the variables. Use a lower-contrast token instead.
3. **Every surface belongs in the token block.** A ground invented locally is a
   text-contrast decision made by someone thinking only about a hover state.
   `--panel-hover` and `--panel-active` exist for exactly this.
4. **Audit against tinted grounds, not only flat ones.** A token cleared at 4.5
   against `--panel` stops being true the moment a component washes the ground
   beneath it, and nothing in the variables shows it. Found twice, independently:
   light `--add`/`--del`/`--accent` clear 5.0+ on white and fail at 4.2-4.35 on a
   diff row tint; shell text tokens at exactly 4.5 on white measure 3.71-3.93 on
   the worktree warning tints. Either give the token headroom (~5.4 on the flat
   ground) or let the tinted surface carry its own text tiers. Say in the token
   comment which grounds a value was cleared against.
5. **Never `color-mix(… , transparent)` for a tint that must be legible.** It
   composites against whatever happens to be behind it, so one declaration
   darkens on a dark ground and *lightens* on a light one -- the ratio inverts
   with the theme, silently. Name the ground: `color-mix(in srgb, var(--warn)
   80%, var(--track))`. A p% mix with a ground is arithmetically identical to a
   p% alpha composite over it, so naming it changes nothing except that it stays
   correct when the theme flips.
6. **An alpha is not theme-portable.** The same alpha over near-black and over
   near-white lands a completely different separation, because the token beneath
   it differs too. Every wash needs a measured value per theme.

## Layout

```
src/capture/   transcript watcher + adapter + status derivation   (M1, M2)
src/db/        SQLite access layer and schema
src/git/       worktree create/remove/reconcile                    (M3)
src/lsp/       PHPantom client: JSON-RPC framing and the server pool
src/ui/        React shell, task list, xterm pane                  (M2)
src/ui/transcript/  transcript renderer and diff component         (M4)
src-tauri/     Tauri shell; src/pty.rs plus small fs and scope helpers
src-tauri/mcp/ Albedo's MCP server: stdio, Rust, bundled as a sidecar (#157)
```

## Past regressions

`docs/REGRESSIONS.md` lists mistakes already made here once -- keyboard
matching, Claude Code's queue and transcript quirks, shared helpers changed for
one feature, tests that pass while the app does not. Read the sections your
change touches before starting, and add an entry when a review catches a new
one.

**Every time the owner reports something that used to work and no longer
does, add an entry** -- brief: what broke, a short concrete example of how it
showed up, the cause once known, the rule that prevents it. Update it when the
cause or the fix is found. A `UserPromptSubmit` hook
(`scripts/regression-reminder.sh`, wired in `.claude/settings.json`) adds a
reminder when a message reads like such a report; the rule applies whether or
not it fires.

## Dependencies

New versions wait 7 days after publishing (14 for a new major) before Albedo
takes them (#146); CONTRIBUTING.md, "Dependencies", has the details.

- Add or upgrade npm packages with `npm run deps:add -- <pkg>` (or
  `deps:add-dev`), which installs with `--before=<a week ago>`.
- Never run `npm install <pkg>@latest`, `npm update` or `cargo update` to
  take new versions: they ignore the embargo. If a lockfile changes anyway,
  run `npm run deps:check` before pushing.
- The CI job `dependency-age` (`scripts/check-release-age.mjs`) fails a PR
  that brings in a younger version. The only override is an entry with a
  reason in `.dependency-embargo-allow.json`; agents never add one on their
  own -- the owner decides.

## Commands

```
npm run tauri dev     # run the app
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run deps:check    # dependency embargo against origin/main
cargo fmt --all && cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets
npm run build:mcp     # the MCP server, beside a dev build's binary (tauri dev runs it)
```

## Foreign keys are not enforced

`tauri-plugin-sql` never issues `PRAGMA foreign_keys = ON`, so every
`REFERENCES` clause in the schema is documentation. The test harness sets it OFF
deliberately to match — a harness stricter than production fails on valid
inserts and, worse, can pass on orderings production would reject. If it is ever
turned on, expect fallout: `messages.task_id` and `tasks.project_id` are both
written before the referent necessarily exists.
