# Status — where the build got to

Written at commit `0cd5bd3`+. Five commits.

- `7a995af` — MVP M1–M4
- `21a1ba6` — spec additions (touched files, file editing, usage gauges) + archive fix
- `72d6d43` — this document
- `0cd5bd3` — projects + the contrast pass
- *(next)* — light/dark theming

---

## Verification state — read this before trusting anything

| | |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **571 passing**, 17 files |
| `cargo test --lib` / `clippy` / `fmt` | 8 passing, clean, clean |
| `cargo build` | links, 51MB debug binary |
| App launch | runs under a Finder-like minimal PATH |
| M1 capture, end-to-end | **38,398+ messages, 115 transcripts, 41.8 days** |
| Migration v2 (projects) | applies to the live 262MB database |
| Contrast audit | **0 failures**, both palettes, flat and tinted grounds |
| Theme toggle | verified live — switches without reload, persists |
| FTS search | returns hits across that history |

**What is NOT verified, and why it matters:**

- **The pty rendering Claude Code's TUI.** The spawn path is tested (shell
  quoting round-trips against a real shell, `exit 42` propagates, a missing
  command surfaces as exit 127 with zsh's diagnostic visible in the pane) but
  nobody has watched the TUI actually draw inside xterm. The terminal used to
  build this lacked macOS screen-recording permission.
- **Resize.** The spec flagged it as where the pty would go wrong, and it is
  still the least-exercised path. Drag the splitter and the window edge.
- **Every layout decision.** There is no component-test harness (no jsdom) in
  the repo. All 522 tests cover pure logic — adapters, diffs, git parsing,
  paging, path containment, token arithmetic. Not one component is covered.
- **The editor's save-conflict path against a real concurrent agent.** Logic is
  tested; the actual race is not.

---

## Running it

```sh
npm run tauri dev          # first launch ~60s for the Rust link
```

```sh
npm test                   # vitest
npm run typecheck          # tsc --noEmit
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Database lives at
`~/Library/Application Support/com.upsellguru.albedo/albedo.db`.
Worktrees are cut at `~/agents/<repo>/<task-slug>`.

Capture has **already ingested your history** — but the task list will be empty
and none of it is visible in the UI. That is correct, not a bug: those sessions
were terminal-launched so no task claims them, and the cross-task search UI is
M5. Confirm the data is real with:

```sh
sqlite3 ~/Library/Application\ Support/com.upsellguru.albedo/albedo.db \
  "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '\"worktree\"';"
```

---

## What to exercise first

1. **New task** → repo, title, base branch. The dialog shows the derived branch
   and worktree path before committing to them.
2. **Select it** → pty spawns `claude` in the worktree. *Resize aggressively here.*
3. **Type a prompt** → status goes `running` → `blocked` on a permission prompt
   → `idle` the instant the turn ends (driven by `stop_reason`, not a timer).
4. **Transcript pane** → tool chips, Edit diffs with word-level highlighting.
   Narrow it to force inline mode. Click a path — it should open the editor.
5. **FILES tab** → the change set. Files git saw but the transcript did not
   (Bash `sed`, a generator) appear marked `worktree`.
6. **Editor** → Cmd+S writes to the worktree, marks the file hand-edited, and
   queues an unsent note in the pty input. **Test the conflict path:** open a
   file Claude is actively editing, let it change underneath you, then Cmd+S.
   Expect *Reload from disk* / *Overwrite anyway*, never a silent clobber.
7. **Right-click a task → Archive** → confirmation distinguishing uncommitted
   changes from unmerged commits, three outcomes.
8. **Worktrees button** → reconcile. Your `~/www/worktrees/*` show as
   informational only, with no remove button.

---

## Architecture rules that must not erode

These are in `CLAUDE.md` too, but they are the ones that cost the most to fix later.

1. **Only `src/capture/adapter.ts` knows the JSONL format.** A format change
   must stay a one-file fix. `USAGE_JSON_PATHS`/`usageSqlExpr` live there too so
   the SQL aggregation does not become a second place that knows the format.
2. **Never parse pty output.** Status, usage, diffs and history all come from
   SQLite. If you find yourself regexing terminal bytes, the answer is in the
   database.
3. **Never drop `raw_json`** at the write boundary. Trimming it at the *read*
   boundary for render-only callers is a legitimate separate discussion.
4. **`resolveInWorktree` is the single containment enforcement point.** A
   transcript is data the app renders; a path in it must never reach the
   filesystem except through that function. The probe is a canonicaliser, not a
   permission check — there is a test that injects a lying probe.
5. **`ANTHROPIC_API_KEY` is stripped twice**: `env_remove` in `pty.rs` *and* an
   in-shell `unset` after the login shell sources the profile. Both are needed —
   removing either silently reintroduces API billing. There is a reproduction in
   the pty module's comments.

---

## Honesty rules the UI follows

Worth knowing so you do not "fix" them:

- **No percentage is shown against a denominator we do not have.** The
  subscription plan limits are not on disk anywhere (checked: `stats-cache.json`
  is historical, `policy-limits.json` is policy). So the usage section shows
  absolute tokens, burn rate and a countdown — and deliberately has **no bar**,
  because in a section headed "usage" any horizontal bar reads as
  percent-of-quota whatever the caption says.
- **Inferred context limits never render a bare percentage.** The transcript
  records `claude-opus-5` but not whether it is the 200k or 1M variant, so the
  denominator comes from the session's observed peak. When inferred: exact token
  count, `~` prefix, `approx` tag, hatched bar fill. The token count is exact
  whatever the denominator turns out to be.
- **The countdown says "ages out in", not "resets in".** It is a true rolling
  window — the number is when the oldest counted turn ages out and headroom
  starts returning, not a cliff where everything frees at once.
- **`conversationEst` under-counts on tool-heavy sessions** (the `body` column
  truncates at 20k chars, so those tokens land in `overheadEst`). Direction is
  known; both bands are labelled approximate.

---

## Known gaps and deferred work

**Recorded in `docs/INTERFACES.md` with concrete revisit triggers:**

- `beforeSeq` for backward pagination. Measured and declined: largest real
  session is 3,675 lines, not the "tens of thousands" the spec assumes. Revisit
  above ~5k rows.
- Trimming `rawJson` at the read boundary. Transcript lines are long-tailed —
  p99 35KB, largest single line 1.06MB — so this buys more than paging changes
  if the pane ever feels slow.
- `TouchedFile` has no "outside the worktree" flag; such rows are distinguishable
  only by a leading `/`.

**Not recorded elsewhere:**

- **Bundle**: 1.3MB main chunk (React + CodeMirror + app). All 43 grammar and
  WASM chunks are correctly *dynamic* — verified, not assumed — so they are not
  a startup cost. If the 1.3MB ever matters, the lever is `React.lazy` on
  `FileEditor`; CodeMirror is most of it and is not needed until a file opens.
- **Degraded symlink fallback**: without `canonicalize_path` the worktree root is
  taken as given, because there is nothing above it to walk from. Never taken on
  a current binary.
- **`stats-cache.json` has a per-model `contextWindow` field.** It is `0` for all
  nine models today, so it is useless — but it is the field to watch. If a future
  Claude Code populates it, that is a genuine `limitBasis: 'known'` signal and
  `pickWindowTier` should defer to it.

---

## M5, per the spec

- Worktree file tree for browsing beyond touched files
- Filename search: `git ls-files` + fuzzy matching in JS, no index
- Full-text search: `ripgrep` as a Tauri sidecar, shelled per query; respect
  `.gitignore` and exclude `vendor/` explicitly
- Cross-task search UI with filters by repo, date, tool
- Per-task usage accounting from transcript result records
- Auth mode as a per-task setting

**Symbol search is explicitly out** — it needs a parser, a symbol table and
per-worktree invalidation, and that is the PHPStorm job this tool leaves alone.

---

## Where things live

```
src/capture/    adapter (the only module that knows JSONL), watcher, status,
                usage, context
src/db/         index (queries), touched, schema.sql
src/git/        worktree, reconcile, slug
src/lib/        pty client, diff (Myers + word-level), highlight (Shiki),
                paths (containment), handEdited
src/ui/         App, TaskList, Terminal, Header, StatusDot, NewTaskDialog,
                ArchiveTaskDialog, WorktreeReconcile, TouchedFiles
src/ui/transcript/  TranscriptPane, MessageRow, ToolChip, Diff
src/ui/editor/      FileEditor, openFile
src/ui/gauges/      UsagePanel, ContextGauge, WindowGauge, format
src-tauri/src/      pty.rs (the one Rust module), fsx.rs (canonicalize), lib.rs
```

Read `docs/INTERFACES.md` before changing anything crossing a module boundary —
it carries the frozen contracts, the lead rulings and the reasoning behind them.
`docs/TRANSCRIPT-FORMAT.md` documents the JSONL format as observed on
Claude Code v2.1.272, including the allowlist rule.

---

## Added after the first run (commits `0cd5bd3` onward)

**Projects.** A project names a repo once and says where its worktrees live,
replacing the hardcoded `~/agents/<repo>/<slug>`. Add one via the `Projects`
control in the header. Point one at `~/www/worktrees` and the worktrees already
there become actionable in the reconcile view instead of untouchable "unknown".
Schema is migration v2 — **`src/db/schema.sql` is v1 and is already applied to
the live database; never edit it.** New schema goes in a new numbered file in
`src/db/migrations/`, registered in `src-tauri/src/lib.rs`.

**Contrast.** The whole palette was measured and raised; see the five rules in
`CLAUDE.md`. `--muted` (most of the UI) went 3.18 → 6.26, the type scale up a
notch. Three text tiers, all clearing AA, still distinct.

**Light/dark.** Toggle in the sidebar footer (`auto / light / dark`), default
system. Mechanism and required token structure are in `docs/INTERFACES.md` under
"Theming". Theme state lives in exactly one module, `src/ui/theme.ts` — do not
add a second resolver. `resolvedTheme()` reads the answer CSS already computed
rather than re-deriving it from the attribute plus media query, so the cascade
is the single source of truth.

Notes that will save time later:

- The **worst ground flips with the theme**: in dark it is the lightest surface
  (hover and selected lift), in light the darkest (they sink).
- **xterm is the only code that runs on a theme flip.** Shiki dual-tokenises, so
  every other surface is a pure CSS repaint. If you find yourself adding a
  subscription that rebuilds anything, something has drifted.
- The **xterm ANSI palette is a per-theme constant pair, not tokens** — ANSI
  white at `#ccd3de` is invisible on a white ground.

## Bugs the contrast and theming passes found in already-shipped code

Worth knowing these existed, because none would have been reported as a contrast
problem:

- Two borders in the worktree destructive-confirmation dialogs were below the UI
  floor in the **shipped dark theme** (2.25 and 1.62).
- The editor's current-search-match highlight put github-light's palest token at
  **2.99:1** and dark at **2.45:1** — under the floor on the one match being read.
  The dark half predated the light work.
- `--hatch`, the marker that says a context number is *inferred rather than
  measured*, cleared 3.0 in only 1 of 6 band/theme combinations. A marker nobody
  can see is the same as not shipping one, except we would think we had.
- The gauges bar's own extent measured 1.13 — you could not see where the bar
  ended, which is precisely the headroom reading.
