# TODO — the actionable backlog

`STATUS.md` says where the build **is**; this says what to **do** next, roughly
in the order I would do it. Each item carries the reason, because the reason is
what decides whether it is still worth doing in three weeks.

Nothing here is a bug in shipped behaviour unless it says so.

---

## 1. Watcher: a polling fallback

**The one I would do first, and not because of Windows.**

`src/capture/watcher.ts:223` registers `tauri-plugin-fs`'s native `watch` with a
debounce. There is no polling fallback anywhere in `src/capture/`. Native events
are inotify on Linux, FSEvents on macOS — and there are filesystems where
`watch()` **succeeds and then never fires**:

- WSL's `/mnt/c` (the Windows drive, via drvfs/9p) delivers no inotify events;
- NFS/SMB network mounts, commonly;
- some container bind mounts.

The failure mode is the bad one. `watch()` returns a valid unwatch handle, so
`liveUpdatesError` stays null, nothing reports `degraded`, and every row still
arrives — via the startup backfill. The app looks healthy.

That is exactly the bug `STATUS.md` calls the sharpest in the project's history:
the watcher that never fired from the first commit while 787 tests stayed green.
It is currently one unusual filesystem away from returning, and this time
nothing would even error.

**Shape of the fix.** Not "replace events with polling" — poll only as a
fallback, and use the discrepancy as the detector:

- after `start()`, note `bytes_ingested` for the newest transcript;
- on an interval (30s is plenty), `stat` the handful of files the app is
  actually tailing and compare `mtime`/size to what was last ingested;
- if the poll finds an append the watcher never reported, the watcher is inert:
  keep polling, and surface it the way `liveUpdatesError` is surfaced today —
  "live updates are being polled, not watched" is a true and useful sentence.

**Why it is worth it regardless of platform:** it converts a silent failure into
a slower-but-working one, and it makes the dead-watcher case *detectable*, which
it is not today.

---

## 2. Platform and distribution

### 2a. Linux build config — small, unblocks 2b

Currently macOS-only by configuration, not by code:

- `src-tauri/tauri.conf.json` → `bundle.targets` is `["app", "dmg"]`. Add
  `"deb"`, `"appimage"`, `"rpm"` as wanted.
- `bundle.icon` lists only `icons/icon.icns`, even though `icon.ico`, `icon.png`
  and the `Square*.png` set are already generated on disk. Widen it.
- `src/ui/editor/openFile.tsx` falls back to `open -a PhpStorm`, which is macOS
  only. The `phpstorm` CLI is tried *first* and is cross-platform, so this
  degrades rather than breaks; `xdg-open` is the Linux second chance.
- `--traffic-lights-w: 78px` (`src/styles.css:113`) reserves header space for
  the macOS stoplights. Dead padding elsewhere; gate it.

Already portable, no work needed: `FALLBACK_SHELL` `cfg`s to `/bin/sh` off
macOS, and `comboOf` accepts Ctrl as well as ⌘.

### 2b. Windows = a Linux build under WSL, not a port

Two things genuinely block a native Windows build, and both are ports:

- `src-tauri/src/pty.rs` spawns `$SHELL -l -i -c <script>` — the quoting, the
  in-shell `unset ANTHROPIC_API_KEY`, the fish-vs-POSIX spelling. All POSIX.
- `src/lib/paths.ts` assumes POSIX absolute paths (`startsWith('/')`, splits on
  `/`, canonicalises against `/`). `C:\...` fails every check. It is the
  containment boundary, so it fails *closed* — nothing opens.

Under WSL2 both disappear: a real Linux shell, real POSIX paths, Claude Code
installed in WSL as normal. So 2a is most of the Windows story.

**Hard constraint if anyone tries it:** repos *and* `~/.claude/projects` must
live inside the WSL ext4 filesystem, never on `/mnt/c` — see item 1. Until item
1 lands, a `/mnt/c` setup fails silently.

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

## 4. UI/UX

- **No `aria-live` anywhere in `src/`.** A task going blocked, a capture error
  and the backfill are announced visually only. The attention feature added in
  this round is a dock bounce plus a border pulse — nothing a screen reader
  sees. One polite live region announcing status transitions would cover most
  of it.
- **`SHORTCUTS` has no renderer.** `src/ui/shortcuts.ts` exports a documented
  table precisely so a help surface can render it instead of a second list
  drifting from the first. Until something does, ⌘[ / ⌘] / ⌘← / ⌘→ are
  undiscoverable. A `?` overlay is a small component.
- **`canResume(taskId)` is exported and nothing consumes it**
  (`src/ui/Terminal.tsx:160`). So the composer still cannot say "your
  conversation will be picked up" rather than the deliberately vague placeholder
  that is true either way. Wiring it is the point of it existing.
- **Selecting a task outside the active project tab is still a visual no-op.**
  `select()` (`App.tsx`) sets `selectedId` but never moves
  `activeProjectTabKey`, so opening a session from another project appears to do
  nothing. Same shape as a bug already fixed twice — the scope has to move
  first.

---

## 5. Transcript and diff follow-ups

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

## Already recorded elsewhere — do not duplicate here

`STATUS.md` → **Known gaps** owns: no reprocessor, thin component coverage,
forked-task ancestry, the 1.3MB bundle chunk, `beforeSeq`. `STATUS.md` →
**Open right now** owns whatever is mid-flight this week.

M5 scope (file tree, filename search, ripgrep sidecar, cross-task search,
per-task usage and auth mode) lives in the Notion spec, not here.
