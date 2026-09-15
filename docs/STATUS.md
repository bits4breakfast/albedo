# Status — where the build got to

**Read this first if you are picking the project up cold.**

## Open right now — start here

1. **LIVE BUG, unfixed.** The app shows:
   `Could not assign existing tasks to projects: Can't find variable: listProjects.`
   That is `backfillProjectsFromTasks` throwing in `src/db/projects.ts`. Ruled out:
   it is not a missing import (the function is defined in that file and hoists),
   and `tsc` is clean. Almost certainly a **circular import** leaving the binding
   in TDZ — `db/index → capture/adapter → … → db/projects → db/index` is the
   suspected shape. `madge --circular src` would settle it.
   **Consequence while it throws: tasks are not being linked to projects**, which
   presents as tasks landing in the wrong tab.

2. **In flight, not landed** (each was dispatched and may be partially applied):
   - `canResume(taskId)` export, so the composer can tell "your conversation will
     be picked up" from "this one was pruned and cannot be"
   - switching tab + focus when opening a session from another project
   - `TouchedFiles` row layout at 180–240px (the new pinnable column's minimum)
   - calling `allow_project_dir` for every project root on startup — **until this
     lands, opening a file in a worktree outside `~/agents` fails with
     "forbidden path"**. The Rust command exists and compiles; nothing calls it.

3. **Never verified by anyone:** the pty actually drawing Claude Code's TUI, and
   resize under a hard splitter drag. Both need a human at the window.

---

Nine commits, ~35,100 lines.

| | |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **832 passing**, 26 files |
| `cargo test --lib` / `clippy` / `fmt` | 8 passing, clean, clean |
| Builds | `vite build` and `cargo build` both pass |
| M1 capture | 529 transcripts, 45,497 messages, 42 days |
| **Live capture** | **measured at 392ms**, file write → watcher → adapter → SQLite |
| Migrations 1–4 | applied to the live database |
| Contrast | 0 failures, both palettes, flat and tinted grounds |

---

## Read this before trusting a green run

**This app can only be validated by running it.** Most of what it does is
observe another program's side effects, and the test suite mocks exactly that
boundary. Five of the most consequential bugs were found by the user opening the
app for a few minutes; none were findable by the tests.

The sharpest example: **the fs watcher never fired, from the first commit until
very late.** `tauri-plugin-fs` gates `watch` behind a non-default Cargo feature,
so the command was never compiled in and every call threw `Command watch not
found`. 787 tests were green throughout — all of them passing against a mocked
watcher. Everything in the database had arrived via the startup backfill.

So the smoke test that matters is **"does it still see things happen"**: write a
transcript line, watch it land. Not "do the tests pass".

**Still not verified:** the pty rendering Claude Code's TUI, and resize. The
spawn path is well tested (shell quoting round-trips against a real shell,
`exit 42` propagates, a missing command surfaces as 127 with zsh's own message
in the pane) but nobody has watched the TUI draw or dragged the splitter hard.

---

## What exists

**Capture (M1).** Watches `~/.claude/projects` recursively — including the
`subagents/` transcripts nested two levels deeper, which are 53% of the corpus
and were silently skipped for most of the build. Tails by byte offset. All
format knowledge lives in `src/capture/adapter.ts`.

**Shell (M2).** Task list grouped by status, embedded xterm pty, per-project
tabs (hidden below two projects), context meters, persistent usage panel.

**Worktrees (M3).** Projects define where their worktrees live, so your own
layout works rather than being migrated to suit the app. Archive, delete, and an
orphan reconcile view.

**Transcript (M4).** Renders from SQLite: tool chips, per-tool input rendering,
Edit diffs with word-level highlighting, envelope chips for machine-generated
user rows, clickable paths opening a CodeMirror editor, a touched-files view,
and a composer that sends without switching panes.

**Sessions.** A browser over every captured session with FTS search; resume
(continue or fork); every task resumes across restarts.

**Themes.** System / light / dark, with light re-picked rather than inverted.

---

## Running it

```sh
npm run tauri dev
npm test && npm run typecheck
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Database: `~/Library/Application Support/com.upsellguru.albedo/albedo.db`
(~290MB and growing — 166MB of that is `raw_json`, which is the honest cost of
the never-drop rule, not a leak).

---

## Rules that must not erode

In `CLAUDE.md` in full. The ones that cost most to fix later:

1. **Only `src/capture/adapter.ts` knows the JSONL format.**
2. **Never parse pty output.** One boolean is permitted — whether *any* bytes
   arrived, to tell a rejected `--resume` from a session the user ended. Looking
   *at* the bytes is still forbidden.
3. **Never drop `raw_json`** at the write boundary.
4. **`resolveInWorktree` is the single containment point.** A transcript is data
   the app renders; a path in it must never reach the filesystem otherwise.
5. **`ANTHROPIC_API_KEY` is stripped twice** — `env_remove` in `pty.rs` *and* an
   in-shell `unset` after the login shell sources the profile. Remove either and
   API billing silently returns.
6. **Resolve and link automatically; never create.** Linking a task to an
   existing project is provable. Creating a project is the user's decision.
7. **Deleting a task never deletes its transcript**, and the dialog says so —
   which makes it a contract rather than a comment.

## Identity, and three paths that look alike

- Repository identity is `git rev-parse --git-common-dir` + `dirname`.
  `--show-toplevel` returns the *worktree* when run inside one.
- `worktreePath` = where the session runs. `repoPath` = the resolved repository.
  `projectId` = resolved from `repoPath`; null is valid and lands in "Other".
- `seq` is **file-local** — it restarts at a resume or fork, so a task holds
  overlapping runs. Task-scoped ordering uses `ts`; `afterSeq` is only meaningful
  within one session. `messages.id` is the monotonic cross-session cursor if one
  is ever needed.

## Honesty rules the UI follows

Do not "fix" these:

- **No percentage against a denominator we do not have.** Plan limits are not on
  disk anywhere. The usage section shows absolute tokens and deliberately has no
  bar, because in a section headed "usage" any bar reads as percent-of-quota.
- **`cache_read` is never added to spend.** It is re-counted every turn — 911
  turns re-reading the same context reported 227M against a real 5.9M.
- **Inferred context limits render no percentage**, just the exact token count.
- **The countdown says "ages out in", not "resets in".**

---

## Known gaps

- **No reprocessor.** `bytes_ingested` means a fully-ingested file is never
  re-read, so any future adapter improvement applies only to new transcripts.
  7,954 `tool_use` rows have a null `target_path`; if extraction improves, they
  stay null. `raw_json` exists so this is fixable — nothing has been built.
- **Component coverage is three files.** jsdom landed late; `EmptyState`, the
  harness template, and the composer's retry flow are covered. Everything else
  in `src/ui` is verified by reading.
- A forked task's transcript begins at the fork; no ancestry link.
- Bundle: 1.3MB main chunk. Grammars are correctly dynamic.
- `beforeSeq` deliberately absent — revisit above ~5k rows per session.

## M5, per the spec

Worktree file tree · filename search (`git ls-files` + fuzzy) · full-text search
(`ripgrep` as a sidecar) · cross-task search UI · per-task usage accounting ·
per-task auth mode. **Symbol search is explicitly out.**

---

## Where things live

```
src/capture/    adapter (sole format owner), watcher, status, usage, context
src/db/         index, projects, sessions, touched, testkit, migrations/
src/git/        worktree, reconcile, slug
src/lib/        pty client, diff, highlight, paths, handEdited, issueKey
src/ui/         App, TaskList, Terminal, Header, dialogs, EmptyState, theme
src/ui/transcript/  pane, rows, chips, diff, envelopes, toolViews, composer
src/ui/editor/  FileEditor, openFile        src/ui/gauges/  usage panel
src-tauri/src/  pty.rs, fsx.rs, lib.rs
```

`docs/INTERFACES.md` holds the frozen contracts, the rulings and the reasoning.
`docs/TRANSCRIPT-FORMAT.md` documents the JSONL format and the allowlist rule.
