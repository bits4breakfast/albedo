# TODO — the actionable backlog

`STATUS.md` says where the build **is**; this says what to **do** next, roughly
in the order I would do it. Each item carries the reason, because the reason is
what decides whether it is still worth doing in three weeks.

Nothing here is a bug in shipped behaviour unless it says so.

---

## 1. Watcher: a polling fallback — done

Shipped in `src/capture/watcher.ts`. Every 30s, once the backfill is in, the
watcher stats each transcript and compares it to the size ingest last saw; growth
older than 5s with no ingest pending means the native watcher missed it. The
poll ingests it and the app reports "live updates are being polled, not
watched". A failed `watch()` falls into the same mode.

The surfacing half turned out to be missing, not just the fallback:
`liveUpdatesError` and the `degraded` event had no reader. `useTasks` now
subscribes and the message lands in the banner.

**Not verified live.** The comparison is unit-tested
(`findUnreportedGrowth`); the real thing needs a filesystem that swallows
events, or a no-op'd `watch()` callback, and a transcript append.

---

## 2. Platform and distribution

### 2a. Linux build config — done

Was macOS-only by configuration, not by code. Now:

- `bundle.targets` is `["app", "dmg", "deb", "appimage"]`; the bundler builds
  only the ones that belong to the host. `bundle.icon` lists the png/ico set
  as well as the icns.
- `shell:allow-execute` allows `xdg-open` next to `open`, and
  `src/lib/openUrl.ts` picks one per platform (`src/lib/platform.ts`, from the
  webview's user agent). `phpstorm` is still there, for the external-editor
  template in §5.
- `/usr/bin/gh` is a fourth `gh` location (apt/dnf), in `GH_PROGRAMS` and the
  scope; a test checks every name the runner tries is in the capability.
- `--traffic-lights-w` is 0 unless `main.tsx` stamped
  `data-platform="macos"` on the root. `titleBarStyle`/`hiddenTitle` are
  macOS-only keys and simply ignored on Linux, which draws its own title bar.
- `.github/workflows/ci.yml` runs typecheck, vitest (so the hook script runs
  under dash), fmt, clippy `-D warnings`, cargo test and
  `tauri build --bundles deb,appimage` on ubuntu-22.04, and uploads the
  `.deb` and `.AppImage`.

Already portable, no work needed: `FALLBACK_SHELL` `cfg`s to `/bin/sh` off
macOS, `comboOf` accepts Ctrl as well as ⌘, and pty.rs's process groups and
`poll` are plain POSIX.

**Done:** `src/git/reconcile.ts` applied two macOS rules everywhere -- the
`/tmp`, `/var`, `/etc` -> `/private/...` firmlinks, and case-insensitive
`pathKey`. Both now apply only off Linux (`MAC_PATHS`, from `detectPlatform`),
so a Linux path is compared case-sensitively and never rewritten.

**Not yet run by a person.** CI proves it builds and the tests pass on
Linux; nobody has launched the window.

### 2b. Windows = a Linux build under WSL, not a port

How-to for a Windows user: `docs/LINUX-WSL.md`.

Two things genuinely block a native Windows build, and both are ports:

- `src-tauri/src/pty.rs` spawns `$SHELL -l -i -c <script>` — the quoting, the
  in-shell `unset ANTHROPIC_API_KEY`, the fish-vs-POSIX spelling. All POSIX.
- `src/lib/paths.ts` assumes POSIX absolute paths (`startsWith('/')`, splits on
  `/`, canonicalises against `/`). `C:\...` fails every check. It is the
  containment boundary, so it fails *closed* — nothing opens.

Under WSL2 both disappear: a real Linux shell, real POSIX paths, Claude Code
installed in WSL as normal. With 2a done, that is the Windows story.

**Hard constraint if anyone tries it:** repos *and* `~/.claude/projects` must
live inside the WSL ext4 filesystem, never on `/mnt/c`. Since item 1 a
`/mnt/c` setup no longer fails silently -- it degrades to the 30 s poll and
says so -- but it is still the wrong place.

**Untested, flagged not asserted:** Tauri's Linux webview is WebKitGTK, which
under WSLg is widely reported to need `WEBKIT_DISABLE_DMABUF_RENDERER=1` to
render at all. Nobody here has run it. Expect to fight it.

### 2c. Shipping a signed binary

`npm run tauri build` already produces `.app` + `.dmg`, **unsigned** — fine for
this machine, refused on anyone else's.

1. Apple Developer Program ($99/yr) and a *Developer ID Application* cert.
2. Codesign **and notarize**. Without notarization Gatekeeper's message is the
   misleading "damaged and can't be opened", not "unsigned" — budget debugging
   time for that sentence. Tauri v2: `bundle.macOS.signingIdentity`,
   `hardenedRuntime`, `entitlements`; notarization via `APPLE_ID` /
   `APPLE_PASSWORD` / `APPLE_TEAM_ID` at build time.
3. Universal binary — the build targets the host arch only today. Add
   `--target universal-apple-darwin` for Intel.
4. No updater is configured. Optional, but retrofitting one after people have
   installed v1 is worse than deciding now.

**Non-technical:** Albedo *wraps* Claude Code, so a binary is only useful to
someone who already has it installed and authenticated. Per the spec this stays
single-user with their own credentials — sharing a build is fine, sharing a
subscription is not.

---

## 3. Code organization

Found in the review pass; none of it is a bug, all of it is drift that gets
more expensive.

- **`App.tsx` is ~1,600 lines with 26 `useState`, 15 `useEffect`, 11
  `useCallback`.** Three cohesive groups are sitting there ready to move:
  layout geometry (`sidebarWidth`, `mode`, `orientation`, `ratio`,
  `panesWidth`, `filesWidth`, `filesPinned`, `dragging`), dialog open/close
  (`newTaskOpen`, `reconcileOpen`, `projectsOpen`, `sessionsOpen`, `importOpen`,
  `archiveTarget`, `endIntent`), and launch notices (`dismissed`,
  `hiddenProjectIds`, `startupError`, `backfill`). `useTasks.ts` is the
  precedent for what that looks like done well.
- **Three hand-rolled localStorage read/write pairs** with the identical
  try/catch shape (`readStored`/`store`, `readHiddenProjects`/
  `writeHiddenProjects`, `readDismissed`/`writeDismissed`), nine keys in `LS`
  and two more as loose consts, plus six `useEffect(() => store(...))` lines
  that are pure boilerplate. One `usePersisted(key, codec, fallback)` collapses
  all of it and puts every key in one place.
- **Two conventions for CSS.** Five components co-locate a stylesheet
  (`transcript.css`, `worktree.css`, `touched.css`, `editor.css`,
  `gauges.css`); sixteen more live in a ~1,735-line `styles.css`, including a
  213-line Session browser block belonging to a 571-line component. The better
  pattern already exists here — it is just not applied evenly.

---

## 4. UI/UX — done, except §7

Shipped: a polite `aria-live` region announcing blocked/finished (reusing the
attention marks, so it is silent for a prompt you answered yourself); a `⌘/`
overlay rendered from `SHORTCUTS`, with a header button; the composer
placeholder now reads `canResume`; and `select()` moves to the task's project
tab first, so opening a session from another project is no longer a no-op.

Still open: **the touched-files view is the wrong shape** — see §7.

None of this has been checked by a person at the window yet.

---

## 5. Configuration: decide the tiers before adding options

There is **no settings UI anywhere** in `src/ui`, and configuration is already
split across two stores with no home for a third kind:

| Tier | Where it lives | What it holds today |
| --- | --- | --- |
| Per-project | SQLite `projects` | `worktree_root`, `default_base_branch`, `task_prompt_template` |
| Per-task | SQLite `tasks` | branch, base, `owns_worktree` |
| View state | localStorage, 11 keys | widths, pane mode, active tab, theme |
| **App-wide** | **nowhere** | — |

The trap is adding a settings dialog before deciding that split, which produces
a third ad-hoc store and a dialog that writes to all three.

**Proposed split.** *View state* stays in localStorage — it belongs to the
device, not the user, and a window width is not a preference worth syncing.
Everything else is real configuration and belongs in SQLite beside the projects
it qualifies: a `settings` key/value table for app-wide, existing columns for
per-project. The DB is already the store, migrations already exist, and it stays
inspectable with `sqlite3`, which is how this project gets debugged.

*(The honest alternative is a hand-editable `config.json` in the app-data dir:
it can be fixed in an editor when a bad value breaks startup, which SQLite
cannot. Worth weighing if the setting list grows past a dozen.)*

### What is actually missing is identity and integration, not tuning

1. **The `claude` binary is hardcoded** — `command: 'claude'`
   (`src/ui/Terminal.tsx:509`). A version manager, a wrapper script or a
   non-PATH install cannot be pointed at it. It also blocks default flags
   (`--model`, `--permission-mode`), which is the same slot the spec's M5
   per-task auth mode needs.
2. **There is no external-editor action at all any more.** "Open in PHPStorm"
   was removed rather than left hardcoded (it named one editor in both the CLI
   and a macOS-only `open -a` fallback). What should replace it is a command
   **template** — `code --goto {path}:{line}`, `zed {path}:{line}`,
   `idea --line {line} {path}` — with `{path}` and `{line}` substituted and the
   arguments passed as an array, never interpolated into a shell string. The
   old implementation's comment on argument injection is worth reading before
   rewriting it: a worktree path with a space in it is the easy case.
3. **The transcript root is hardcoded** — `PROJECTS_SUBPATH = '.claude/projects'`
   (`src/capture/watcher.ts:46`), and `CLAUDE_CONFIG_DIR` is read nowhere. If
   anyone sets it, capture silently sees nothing: the same look-healthy-but-empty
   failure as item 1 in this file. Read the env var first, fall back to the
   default, and let a setting override both.

### What NOT to make configurable

The ~14 module constants (`RUNNING_WINDOW_MS`, `DEBOUNCE_MS`, `COALESCE_MS`,
`PAGE`, `TAIL_LIMIT`, `BODY_MAX_CHARS`, …) are engineering constants, not user
preferences. Exposing them adds surface and support burden for no benefit, and
several are load-bearing in ways a user cannot be expected to reason about —
`RUNNING_WINDOW_MS` is the whole reason a finished task does not read as
`running` for 90 seconds. Leave them in code where their comments are.

---

## 6. Transcript and diff follow-ups

- **Between-hunk gaps on a `git diff` are still dead.** The new context
  expansion (`lib/anchor.ts`) covers the leading and trailing edges only. The
  bars *between* hunks still render as a static `⋯ 30 unchanged lines` that no
  click opens, even though the file is now being read and anchored. Each hunk
  already anchors independently, so the region between hunk `i-1`'s end and hunk
  `i`'s start is available — it is a rendering change, not new machinery.
- **Expansion anchors ~51% of the time** on the live corpus (the rest correctly
  report "this file has changed since"). If that proves annoying in practice,
  the honest improvement is *not* fuzzy matching — it is reading the blob from
  git (`git show <sha>:<path>`) for diffs that carry a commit, which would be
  exact rather than approximate.

---

## 7. Touched files should read like `git status`, not like a log

The spec asked for "path, edit count, last touched" and that is what was built.
In use it is the wrong shape: the question this view answers is *what does the
change set look like right now, before I commit*, and neither how many tool
calls hit a file nor when they did tells you that. It is a change set, so it
should look like one — path, status, and eventually `+`/`-`.

### Drop two columns

`src/ui/TouchedFiles.tsx` (end of the row renderer):

- `tf-edits` — the `3×` count, from `TouchedFile.editCount`.
- `tf-when` — the relative time, from `TouchedFile.lastTouchedAt`.

Keep the status code, the path, and both badges: `worktree` (git saw a change
the transcript never mentioned) and `hand` (you saved it yourself). Those two
say something `git status` cannot, which is the whole reason this is not just a
shell-out.

### The sort has to change with them — do not miss this

`compareTouched` (`src/db/touched.ts:260`) orders by `lastTouchedAt`, then by
`editCount`, then by path. Remove both columns and the list is ordered by two
things you can no longer see, which reads as unordered.

`git status` sorts by path, and that is probably right here too. The open
question is the deliberate rule above it: `source: 'git'` rows currently lead
the list, because "something changed here that the agent never told you about"
is the most valuable line in the view. Path-ascending throws that away. Worth
keeping as a group header or a sticky first section rather than losing it to
alphabetical order.

### `+`/`-` needs data nothing collects yet

`src/git/worktree.ts` runs `git status --porcelain=v1 -z` and nothing else;
there is no `numstat` anywhere. Adding per-file line counts means:

- `git diff --numstat` for unstaged and `git diff --numstat --cached` for
  staged, summed — a file can have both;
- **untracked files produce no numstat at all.** They are pure additions, so
  either count the lines directly or use `git diff --no-index -- /dev/null
  <file>`. Skipping them would show `—` against exactly the new files the agent
  just wrote, which is the worst column to have blank;
- **binary files report `-`/`-`** rather than numbers. Render that as binary,
  not as zero.

Cost is one or two more git invocations per refresh, on the same cadence as the
existing `git status` call.

### Contract note

`TouchedFile` in `src/types.ts` is a frozen contract (`docs/INTERFACES.md`).
Outside the renderer, `editCount` and `lastTouchedAt` are referenced only by
`src/db/touched.test.ts`. Still, **stop rendering them before proposing their
removal** — adding `added`/`deleted` is additive and safe, deleting fields is a
separate conversation, and the ordering above may want `lastTouchedAt` anyway.

---

## 8. Images: paste and drag-and-drop into the composer

**Sending is done.** A Finder drop inserts the shell-escaped path. A ⌘V that
carries image data is written to `~/.albedo/paste/<timestamp>.png` and inserted
the same way (`src/lib/pasteImage.ts`, with `fs:allow-write-file` granted). Still
open: cleanup of `~/.albedo/paste/`, a chip in place of the raw path, and
rendering image blocks in the transcript. The analysis below is kept.

Screenshots are how you report a UI problem, and today there is no way to get
one into a session except by switching to the terminal. Nothing in `src/ui`
handles a drop, a paste of image data, or a `DataTransfer`.

**The pty cannot carry an image.** It is a byte stream and, per CLAUDE.md,
opaque: execution only. Claude Code takes images as **file paths** in the
prompt. So Albedo's job is never to understand an image — only to get one onto
disk and type its path. That keeps the feature on the right side of the
two-channel rule and needs no new protocol.

### Two input routes, and only one needs a write

1. **A file dragged from Finder** — `onDragDropEvent` is available on both the
   window and the webview in the installed `@tauri-apps/api` (2.11.1) and hands
   over real **paths**. Nothing is written; the path goes straight into the
   composer. This is the cheap 80% and could ship on its own.
2. **A paste (⌘V), or a drag out of a browser** — these carry bytes, not a
   path, so the image has to be materialised before it can be referenced.

### Where the bytes go — decide this first

**Not into the worktree.** An image written there shows up in `git status`,
so it appears in the touched-files view as a `worktree` row: the app reporting
its own scratch files as changes the agent made.

**App-data, not temp.** Temp is cleaned, and a session resumed months later
would reference a path that no longer exists — leaving `raw_json` as the only
trace of what was discussed. App-data persists with the database, which is the
right lifetime. Grant it at runtime through `src/lib/fsGrants.ts`, the way
project roots already are.

Consequence worth knowing: `resolveInWorktree` refuses paths outside the
worktree, so an image path rendered in the transcript will not be clickable.
That is the containment rule working correctly, not a bug to route around.

### Two blockers, both one line, both easy to lose an hour to

- **`fs:allow-write-file` is not granted.** `src-tauri/capabilities/default.json`
  has `fs:allow-write-text-file` only — text, not bytes. A PNG needs the binary
  permission plus an `fs:scope` entry for wherever the images land; the scope
  currently covers `$HOME/.claude/projects` and `$HOME/agents` only.
- **`dragDropEnabled` is unset**, so it defaults to true — Tauri's native
  drag-drop handler takes the event and **HTML5 `ondrop` never fires in the
  webview**. Use `onDragDropEvent` (which is what you want anyway: paths, not
  `File` objects), or set it false and do it in the DOM. Do not spend the
  afternoon debugging a dead `ondrop` handler.

### Decide up front, unpleasant to retrofit

- **Cleanup.** Pasted screenshots accumulate forever otherwise. Age them out, or
  keep them per-task and delete with the task — noting that deleting a task
  already promises not to touch its transcript, so the same care applies.
- **What the composer shows.** A raw `/var/folders/.../a1b2.png` in the input is
  ugly and unreviewable; a chip standing for the path reads better, but the
  composer sends plain text to the pty, so the chip has to resolve back to the
  path on send.

### Rendering: the data is already captured

The adapter has no image case — `[image]` is the generic unknown-block
placeholder (`src/capture/adapter.ts:558`), so an image already in a transcript
renders as that literal text.

But **`raw_json` keeps the base64 verbatim** (verified): every image ever pasted
into any captured session is already in the database and can be rendered without
re-capturing anything. The never-drop rule paying for itself a third time.

Only one image block exists in the whole corpus today, so rendering is low-value
until sending works — which is the right order to build them in anyway.

---

## 9. Tabs and naming

Three separate things, reported together from the project tab strip. The first
is a bug; the other two are missing affordances over plumbing that already
exists.

### 9a. BUG — the "+N closed" menu opens invisibly — done

**Fixed** by the portal: `src/ui/ClosedProjectsMenu.tsx` renders the menu on
`document.body`, positioned from the chip's rect, and closes on an outside
press, Esc (focus returns to the chip), blur, resize, or the strip scrolling.
The diagnosis below is kept for the record.

It is not a dead button. `onClick` toggles `menuOpen` and the menu renders a
head plus one `row-menu-item` per hidden project, each calling `onRestore`. The
markup is fine.

**It is clipped.** `.project-tabs` sets `overflow-x: auto; overflow-y: hidden`
(`src/styles.css:1204`) so the strip can scroll sideways, and
`.project-tabs-menu` is `position: absolute; top: 26px` (`:1618`) — i.e. it
drops *below* the strip, into the axis that is clipped. An absolutely
positioned child cannot escape an ancestor that hides overflow.

So a closed project is currently unrecoverable through the UI, which is exactly
the one-way door the comment above that button says it exists to prevent.

Fix is one of: render the menu in a portal on `document.body` and position it
from the button's rect; or move `.project-tabs-restore` out of the scrolling
container so it is a sibling of the strip rather than a child. The portal is
more work and survives future layout changes; the sibling is two lines.

### 9b. Nothing can be renamed, though the data layer already allows it

There is no rename affordance anywhere — not for a project, not for a task.

The plumbing is not the blocker: `updateProject(id, { name })`
(`src/db/projects.ts:253`) and `updateTask(id, { title })` (`src/db/index.ts:249`)
are both generic column-patchers and already accept it. This is a UI gap only.

Task titles matter more than project names. A task created from a pasted brief
is titled with the whole first prompt — one in the live database is a
200-character paragraph — and `wrapForTooltip` exists precisely because those
titles overflow everything they touch. Renaming is the actual fix; the tooltip
wrapping was the workaround.

### 9c. "Other" should offer to create a project

A task whose `repoPath` resolves to no project row gets `projectId: null` and
lands in the **Other** tab. That is correct and deliberate — CLAUDE.md: *resolve
and link automatically; never create. Linking a task to an existing project is
provable. Creating a project is the user's decision.*

But the rule forbids creating silently, not **offering**. Landing in "Other"
with no path forward makes a correct design read as a dead end — the app knows
the repo root, knows it has no project, and says nothing.

The offer already exists elsewhere: `ImportProjects` does exactly this at
startup, including the careful part (offering the repo *root*, never a worktree
that resolves to it — see the comments in `src/ui/ImportProjects.tsx`). Reuse
that, do not write a second one. An inline "create a project for `~/www/albedo`"
on the Other tab, or on the task row, is the whole feature.

---

## 10. Touched files: sizing and full paths

Both from using the pane; both small.

- **The list should expand as far as you want.** The pinned files column is
  bounded by `FILES_MIN`/`FILES_MAX` in `src/App.tsx` and the tab version
  inherits the pane. On a long change set the list is the thing you want most of
  the window for, and it cannot have it. Raising the ceiling is a constant;
  letting it take the full pane is the real fix.
- **Hovering a filename should show the full path.** The row renders the path
  split into `tf-dir` / `tf-name` and truncates the directory, so a deep path
  shows a filename with no way to see where it lives. There is no `title` on the
  row. The transcript's `PathLink` already does exactly this (`title={target}`)
  — match it, so the same gesture works in both places.

---

## 11. Syntax highlighting — already done; one real gap

Answering the question rather than filing it: **Shiki is already wired up**
(`shiki ^1.24.2`), with **39 grammars** registered in `src/lib/highlight.ts`,
each behind its own `import()` so they stay dynamic chunks rather than bloating
the main bundle. It drives both the transcript diffs (`.tx-tok`) and the
CodeMirror editor (`.ed-tok`), and it is theme-aware through `--shiki-light` /
`--shiki-dark`. CodeMirror 6 additionally supplies its own PHP and JavaScript
modes for the edit buffer.

Checked against what is actually edited in the live database rather than
assumed. Every extension with more than a handful of edits is covered —
`php` (2,256), `md`, `ts`, `jsx`, `tsx`, `html`, `yaml`, `css`, `sh`, `rs`,
`sql`, `js` — and `langForPath` already maps the aliases (`mjs` → javascript,
`yml` → yaml).

**The one gap: `.tpl` (16 edits) falls through to plain text.** Smarty
templates. Shiki has a `smarty` grammar, so this is one line in the `LANGS`
table plus one in `langForPath`. Not urgent at 16 edits, but it is the only
thing in the corpus that is genuinely unhighlighted.

Nothing else to choose or install here.

---

## 12. The "thinking" disclosure promises content that does not exist

Expanding a thinking row shows an empty box. **This is not a capture bug, and
it is not fixable by reading the transcript differently.**

Measured across the whole corpus: **18,040 thinking blocks, 0 of them carry any
text.** Every one is `{ type: 'thinking', thinking: '', signature: '<~1000
chars>' }` — Claude Code persists the cryptographic signature and not the
reasoning. The adapter already reads the right field
(`src/capture/adapter.ts:532`, `stringOr(block['thinking'], '')`); the field is
empty at the source. The live database agrees: 17,899 thinking rows, every body
empty.

So the defect is the UI claiming otherwise. `ThinkingRow`
(`src/ui/transcript/MessageRow.tsx`) renders a disclosure button whose only
possible outcome is an empty `div`, and the word count is always 0 so the label
degrades to a bare "thinking".

**Fix by telling the truth, not by hiding it.** A thinking block is real
information — the model reasoned here, and the row marks where. It just has no
readable body. So: render it as a non-interactive marker, with no caret and
nothing to open. If the rows are worth keeping visible at all, "thought here"
with no affordance beats a control that opens nothing.

Do NOT drop the rows from capture. `raw_json` holds the signature, and if Claude
Code ever starts persisting the text, the rows are already in place.

Separately and independently: **the disclosure caret is too small.** Same
`Disclosure` component is used by the tool chips, the subagent chip, injected
context and this row, so sizing it up is one change in one place — worth doing
regardless of what happens above.

## 13. Follow-up tasks: what was left out

"Follow-up…" (merged PR badge, row menu for merged or archived tasks) only
prefills the new-task dialog. Three gaps, deliberately:

- **No lineage.** Nothing records which task a follow-up came from. That needs
  a `followup_of INTEGER REFERENCES tasks(id)` column -- a `schema.sql` change,
  so a proposal, not something to slip in. With it the row could show "follow-up
  of #42" and the prompt could be rebuilt later.
- **Keyed titles share the folder.** `ACME-2398 follow-up` gets its own branch
  (`ACME-2398-follow-up`) but, by `nameTask`'s one-worktree-per-issue rule, the
  bare-key folder `ACME-2398`. If the shipped task still has its worktree, git
  refuses with `path-exists`; the dialog warns, and archiving first is the fix.
  Revisit if follow-ups-before-archiving turns out to be the common case.
- **The prompt override is in memory.** It is consumed at the first spawn,
  which is immediate; quitting between Create and the session starting loses it
  and the project template applies instead.

---

## Already recorded elsewhere — do not duplicate here

`STATUS.md` → **Known gaps** owns: no reprocessor, thin component coverage,
forked-task ancestry, the 1.3MB bundle chunk, `beforeSeq`. `STATUS.md` →
**Open right now** owns whatever is mid-flight this week.

M5 scope (file tree, filename search, ripgrep sidecar, cross-task search,
per-task usage and auth mode) lives in the Notion spec, not here.
