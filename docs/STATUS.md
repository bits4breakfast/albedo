# Status — where the build got to

**Read this first if you are picking the project up cold.**

## Open right now — start here

1. **Restart the app once, and watch it migrate.** Migration 5 has not run on
   your live database yet — it will on next launch. It has been rehearsed on a
   copy of the real 299MB file: 0.43s, then a re-ingest of 417 subagent
   transcripts taking ~8s, ending at ~91,500 rows with zero duplicates and a
   clean FTS integrity-check. Expect the first launch after this to be busy for
   about ten seconds. If it is not, the migration did not run — check
   `PRAGMA user_version`.

2. **The database moved.** The identifier is now `com.bits4breakfast.albedo`,
   so the app-data directory moved with it. The real database (2 tasks, 2
   projects) was carried across by hand; the empty one the renamed app created
   for itself is parked at `com.bits4breakfast.albedo.autocreated-backup` and
   can be deleted once you are satisfied.

3. **Still never verified by anyone:** the pty actually drawing Claude Code's
   TUI, and resize under a hard splitter drag. Both need a human at the window.
   Unchanged from before — nothing in this round touched the pty.

4. **The backlog now lives in `docs/TODO.md`** — what to do next, with the
   reasons, in rough priority order. The polling fallback for the fs watcher is
   now built (not yet verified live): `watch()` succeeds but never fires on WSL's `/mnt/c` and
   on some network mounts, which would silently reproduce this project's worst
   historical bug with nothing reporting `degraded`.

   Summarised below, in full there:
   - `App.tsx` is 1,600 lines with 26 `useState`, 15 `useEffect` and 11
     `useCallback` in one component. Three cohesive groups are sitting there
     ready to be hooks: layout geometry, dialog open/close, and launch notices.
     `useTasks.ts` is the precedent.
   - Three hand-rolled localStorage read/write pairs with identical try/catch
     shape, 9 keys in `LS` and 2 more as loose consts, plus 6
     `useEffect(() => store(...))` lines. One `usePersisted(key, codec,
     fallback)` collapses all of it.
   - Two conventions for CSS. Five components co-locate a stylesheet
     (`transcript.css`, `worktree.css`, `touched.css`, `editor.css`,
     `gauges.css`); sixteen more live in a 1,735-line `styles.css`, including
     a 213-line Session browser block belonging to a 571-line component. The
     better pattern already exists here, it is just not applied evenly.
   - No `aria-live` anywhere. A task going blocked, a capture error and the
     backfill are all announced visually only — including the new attention
     mark, which is a dock bounce plus a border pulse and nothing a screen
     reader sees.
   - `SHORTCUTS` in `src/ui/shortcuts.ts` is now a documented table with
     nothing rendering it. A help surface is a small component away, and until
     there is one ⌘[ / ⌘] / ⌘← / ⌘→ are undiscoverable.

---

Eighteen commits.

| | |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **873 passing**, 29 files |
| `cargo test --lib` / `clippy` / `fmt` | 8 passing, clean, clean |
| Builds | `vite build` and `cargo build` both pass |
| M1 capture | 529 transcripts, **~91,500 messages after migration 5**, 42 days |
| **Live capture** | **measured at 392ms**, file write → watcher → adapter → SQLite |
| Migrations 1–4 | applied to the live database; **5 pending first launch** |
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

**The second sharpest example, found in this round:** every subagent transcript
had been silently discarded since the first commit. Claude Code writes them
under the PARENT's `sessionId`, `seq` is file-local, and the unique index was
`(session_id, seq)` — so a subagent's line 0 collided with the parent's line 0
and `INSERT OR IGNORE` did what it says. 52,092 rows expected, 5,988 stored:
89% gone, and subagent traffic is 53% of the corpus. No error was raised
anywhere and 787 tests were green, because every fixture seeded one file per
session — the single shape that cannot collide. Migration 5 fixes it; the
lesson is that a fixture which never reproduces the real shape proves nothing,
and both of these bugs were found by counting rows against the files on disk.

**So: when a capture change lands, count.** Parse the files with the real
adapter, count what it should produce, compare to the table. Twice now that has
taken minutes and found something years of green tests did not.

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

**Subagents.** A strip above the transcript listing the agents a session has
running in parallel, with status derived the same way a task's is. Appears only
while something is live.

**Attention.** A task going blocked (or a running one finishing) bounces the
dock when Albedo is not focused, and marks the row when it is — macOS drops
`requestUserAttention` for the active app, so the in-window mark is the
notification, not a decoration on one. `src/ui/attention.ts`.

**Keymap.** One matcher and one documented table in `src/ui/shortcuts.ts`:
⌘N, ⌘1…9, ⌘[ / ⌘], ⌘← / ⌘→, ⌘\. The arrow bindings stand down inside text
fields, where they mean start/end of line.

**Themes.** System / light / dark, with light re-picked rather than inverted.

---

## Running it

```sh
npm run tauri dev
npm test && npm run typecheck
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Database: `~/Library/Application Support/com.bits4breakfast.albedo/albedo.db`
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
