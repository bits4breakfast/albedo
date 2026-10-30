# Regressions and near-misses

Mistakes that were made here once, so nobody makes them twice. Each entry says what went wrong, why it was easy to do, and the rule that prevents it. Read the sections that touch your change before you start; add an entry when a review or a user catches a new one.

## Keyboard

- **Refusing a modifier broke a layout.** To keep ⌘[ from firing on ⇧⌘[, the first version ignored ⌘[ whenever Shift was held. On layouts where `[` itself needs Shift, ⌘[ stopped working. **Rule:**
  - Check the more specific combo first, by `e.code` (`BracketLeft`), and fall through to the existing `key` match unchanged.
  - Never refuse a modifier globally to disambiguate.
- **Shortcuts collide silently.** The editor's CodeMirror keymap, the app's `useShortcuts`, macOS text fields and the terminal (`terminalTakesKey`) all see the same keys. **Rule:**
  - For any new combo, grep the editor keymap and the CodeMirror defaults it loads, plus `shortcuts.ts`. Say in the PR what you checked.
  - Use `e.code` wherever Option or Shift change `key`.

## Claude Code's transcript and queue

- **Queued text is not what Albedo sent.** Claude Code records a pasted image as `[Image #N]`, while Albedo sends a file path. An exact-text match left a duplicate "Sending" row up for 30s. **Rule:** match queue entries by time and origin, not by text.
- **One `dequeue` is not one entry.** Claude Code took four queued messages with a single `dequeue` and passed on only the last one. The rest stayed "queued" forever (#60). **Rule:** reconcile the queue against what actually happened (later user rows, turn end), not by counting records.
- **A queued message can answer a dialog.** A message typed into Claude Code's queue during a turn was released into the next AskUserQuestion menu and cancelled it (#61). Albedo can't unqueue what it has handed over. **Rule:** anything that types into the pty while a turn runs must assume it may land in a prompt.
- **Inferring turns from transcript lines.** #61 first read "a turn is running" from `deriveStatus`'s time windows (idle after 90 s of silence, so a long think read as idle), then from prompt/turn-end marks that missed two shapes, both caught in review against real transcripts: a non-meta `<task-notification>` user line written *after* a turn's `turn_duration` (read as a new turn that never ended; held messages stuck up to 47 min), and a turn started from the queue (`dequeue`, then an `isMeta` user line) that produced no start mark (a release fired straight into it). **Rule:** a turn-boundary rule must be replayed against real transcripts for notification-, queue- and interrupt-driven turns, not only typed prompts; injected text never starts a turn, and a `dequeue` does.
- **Status lags the queue.** Status is derived asynchronously from persisted rows, while the queue updates in memory. Between a turn ending and the next starting, or while Claude Code silently retries, status reads `idle` with entries still queued. Gating visibility on status made a message appear nowhere. **Rule:** one shared predicate decides both "where it's shown" and "when the other copy may go", so a message is always in exactly one place.
- **The transcript pane stopped following while a subagent ran.** The PTY showed the reply, while the pane still showed the previous one with "Sending · 24s", or "Working · 1m 12s" two minutes after the reply was stored (#104). Ingest was on time. The pane's tail asked for `seq > highest seq held` across the whole session, but `seq` is numbered per file, and subagent rows share the parent's session id. A subagent at seq 108 900 put the cursor past every parent row still to come (the parent was at 96 800). **Rule:**
  - `seq` orders rows within one file only: one parent transcript, or one subagent's. Never compare or page on it across a session that has subagents.
  - "What is new since I last read" is `id`, which ingest assigns in insertion order (`getMessages({ afterId })`).
  - When the pane and the PTY disagree, check whether the row is in the DB before suspecting ingest.
- **A long message showed as raw tags under "You".** A 38,000-character subagent report printed as `You  Another Claude session sent a message: <agent-message from="…"> [Subagent hand-back] …`, frame and all (#126). Cause: a body longer than `BODY_MAX_CHARS` (20,000) is stored cut, with a marker, and the cut took the closing `</agent-message>`; the envelope parser rightly keeps an unclosed tag as text. **Rule:** anything that parses a body's structure (envelopes, markdown) renders from `fullBodyOf`, which reads a cut body whole from `raw_json`; test with a body past the limit.
- **A local slash command showed as raw tags, and its echo stuck on "Sending".** Typing `/rc` showed `Sys <command-name>/remote-control</command-name> <command-message>…` in the transcript, and "You /rc · Sending · 7s" stayed at the bottom, below later rows, until its 30 s timeout (#113). Cause: Claude Code writes some slash commands it runs itself (`/remote-control`, `/rename`, `/resume`, `/context`, `/login`) as `system` lines with subtype `local_command` -- the envelope, then `<local-command-stdout>` -- not as the `user` line `/clear` or `/model` gets. The envelope rendering and the echo's "a prompt row arrived" check both looked at `user` rows only. **Rule:**
  - The same thing can arrive as different line types. When rendering or matching a kind of row, check real transcripts for every line type that carries it (`grep -rh '"subtype":"local_command"'` over `~/.claude/projects`).
  - Anything that waits for "the row for what I just sent" also accepts the rows a command writes instead of a prompt (`echoLanded` in `TranscriptPane.tsx`).
  - Again in #122: a background task's end comes as a `user` line when the session is idle, and as a `queued_command` attachment, with no user line, when a turn is running (415 of 662 here). Reading only the user lines would have kept most finished work "running".
- **Harness-written `isMeta` prompts shown as "You".** Owner-reported (#138). A `/loop` session filled with long "You" rows nobody typed: on every wake-up Claude Code writes `system`/`scheduled_task_fire` ("Claude resuming /loop wakeup … · 2 no-op ticks"), then a `user` line `isMeta: true` "[2 prior /loop wakeups found nothing actionable; loop is healthy.]", then the loop's whole prompt again as a `user` line with `isMeta`, `promptSource: "system"`, `turnOrigin: "scheduled"`. Same class, reported during the fix: inside a subagent, "[handback-send-enforce] Your report has not been delivered…" (an `isMeta` sidechain `user` line) showed as "You" in the subagent group. Cause: the pane draws every `user` row under "You" unless its body parses as envelopes, and these are plain text. `isPromptRow` counted them too, so a wake-up landing while a message was on its way would have cleared its "Sending" echo. **Rule:**
  - `user` is the line's type, not its author. `harnessInputOf` (adapter.ts) names what Claude Code wrote itself, by shape: `isMeta`, no `origin`, string content, no `promptSource` other than `"system"`. Skill bodies (content blocks), peer and coordinator messages (`origin`), envelopes and image notes keep their own rendering.
  - Keep such rows `user` in storage: status, the queue and the turn edges already read them right (a wake-up's prompt is the turn's activity). Change who they are attributed to at render, and in `isPromptRow`.
  - When an `isMeta` line shows up somewhere new, enumerate the variants across real transcripts (`grep -rh '"isMeta":true' ~/.claude/projects`, grouped by `origin.kind`, `promptSource`, `turnOrigin`, content type) before writing the rule.
- **A built-in skill's text shown as "You".** Owner-reported (#150): Claude loading the browser-automation skill showed a bare "Skill ✓" chip, then the skill's whole instructions as a long "You" row. Cause: Claude Code writes a skill's text as its own `user` line after the Skill call (`isMeta`, `sourceToolUseID` naming the call, content an array of `text` blocks). A plugin or user skill's text begins "Base directory for this skill:", which `envelopes.ts` drew as a folded "Skill Loaded" row; a built-in skill's text does not, so it fell through to plain prose under "You". `isPromptRow` counted it as well, so a skill loading while a message was on its way would have cleared that message's "Sending" echo. **Rule:**
  - Link a line to what caused it by the id the line carries (`skillSourceToolUseIdOf` → the `tool_use` id), never by how its text begins: the text-prefix rule covered the skills it was written against and silently missed the rest.
  - A row folded into another (`extras` in `groupRows`) still needs a drawing of its own for when its partner is outside the loaded window, and it is never "You" there either.
  - #138's checklist applies to every new `isMeta` shape: enumerate the variants first (here: 72 with a base directory, 10 built-in, 3 string notes that share `sourceToolUseID`, and 34 typed `/skill` texts without it).
- **A new kind of stored row, read as the session's last word.** #122 keeps those attachments as `system` rows. `deriveStatus` reads a `system` row at the tail as idle, so mid-turn, between the notification and Claude's next line, the task would have read Idle while it worked, for as long as Claude took to answer it. Caught before merge. **Rule:** before storing a new kind of row, check every reader of "the newest row": `deriveStatus`, `workingState`, `echoLanded`, the compaction grouping, the subagent tail.
- **A subagent waiting on its own background work read "Running · 324h".** The Agents strip showed an async agent, spawned two weeks earlier and resumed seven times with `SendMessage`, as Running with its clock counting from the first spawn (#139). Two causes:
  - Status came from the agent's own rows only. Its last row was its hand-back, a tool result, which reads as activity for `RUNNING_WINDOW_MS`, and the strip re-derived only on a new row, so once the session went quiet it stayed Running for good. Meanwhile the parent had been told, by a `<task-notification>` with `status: completed` and the summary `Agent "…" is waiting on its own background work`, that the agent had stopped and might resume on its own.
  - Elapsed was `now - firstTs`: across resumes, the first spawn.

  **Rule:**
  - What the parent was told about a subagent (resumed, stopped, stopped for now) settles its state; its own rows decide only after that. Read through `subagentMarksOf` (adapter.ts).
  - Anything derived from a recency window carries when it expires, and something re-asks then (`statusExpiresAt`), or it is stale the moment the session goes quiet.
  - A clock across resumes counts the current run.
- **What the composer sends is read in more places than the transcript.** #155 wraps each paste in a `<pasted-text>` marker. The transcript row was the obvious reader, but the sent body is also shown or reused by the "Sending" echo, the Queued band (Claude Code's queue entries are the body, bare, 1306 of 1310 long ones here), the held-message editor, the draft a failed send comes back as (`flushPending`), and `pasteSegments`, which cut a paste in two at any image path inside it. Each would have shown raw tags, or split a marker across two pastes. Caught before merge. **Rule:**
  - Before changing the shape of what `send` produces, `git grep` every use of the body, `held.text` and queue `text`, and say in the PR what each now shows.
  - A message from the box arrives both bare and inside Claude Code's `<pasted_content id="…">` (measured 2.1.314: the whole message, id repeated on the closing tag, content verbatim). Test both shapes.
- **A wrapper touching `@path` stops Claude Code attaching the file.** Near-miss in #154: the issue's sketch wrapped a file reference as `<file-ref path="src/foo.ts">@src/foo.ts</file-ref>`. Measured on 2.1.314, Claude Code attached nothing for it (the model answered "NONE"), nor for `> @src/foo.ts</file-ref>`; it did for `> @src/foo.ts </file-ref>`, for `@src/foo.ts` on a line of its own, and for a bare `@src/foo.ts` inside a collapsed multi-line paste. **Rule:**
  - Anything Albedo writes around text Claude Code itself interprets (`@path`, `/command`, an image path) keeps that text exactly as Claude Code would see it typed: whitespace on both sides of an `@path`, a lone path for an image (ptyInput.ts).
  - Measure it with the message sent the way the composer sends it (bracketed paste, then Enter), and look for the `attachment` line of type `file` after the prompt in the transcript, not at what the model says.
- **Unverified claims about Claude Code.** A PR stated that `--append-system-prompt` applies on every spawn. Measured with `claude -p`: it applies when the session is created, persists across `--resume`, and is ignored when passed on resume. **Rule:** measure Claude Code behaviour (version noted) before writing it in code or a PR. Say what wasn't measured (interactive mode, `/clear`).

## Shared helpers and scope

- **Changing a shared helper for one feature.** Chat tasks made `taskBase('')` return null. That also changed the main-checkout browse diff, from "against upstream" to "against HEAD", which nobody asked for. **Rule:**
  - Before changing a shared function, list every caller: `git grep`.
  - If another caller's behaviour changes, don't. Scope the change to the feature instead.
- **One rule, fixed in one place.** The header offered Create PR for a branch with no commits of its own, and the tooltip said "24 commits" (#82). The cause: the local `master` was 24 commits behind `origin/master`. `taskBase` already measured against the base's upstream for exactly this reason, but `commitsOnBranch` counted against the local base. **Rule:** everything that counts or diffs a branch against its base resolves the base through `baseOrUpstream` (`src/git/worktree.ts`). When you fix a rule like this, `git grep` for the other places that apply it.
- **A one-file workaround hid the general case.** Opening `.claude/skills/x/SKILL.md` or `.github/workflows/ci.yml` in a worktree failed with "forbidden path", while the Files pane listed the folder (#93). On unix Tauri's fs scope matches with `require_literal_leading_dot: true` by default, so a `<dir>/**` grant never matches a path component that starts with a dot. #77 hit the same cause with `~/.albedo/.../.phpantom.toml` and fixed it with a literal scope entry for that one file, so nobody looked for the other dot-paths it broke. Turning the option off in `tauri.conf.json` was not enough either: the plugin applies it to capability scopes only, while `fs_scope().allow_directory` (the runtime grant) always keeps Tauri's default. **Rule:**
  - When a scope or permission refuses one path, find the rule that refused it and list what else it refuses, before adding an exception.
  - Read where a config option is applied before trusting that it applies: `allow_project_dir` grants through a runtime capability for this reason.
- **Stale comments after a behaviour change.** A comment still said "wrap" after the behaviour became "stop at the ends". **Rule:** when behaviour changes, grep the comments and the PR text for the old words.

## Tests and verification

- **jsdom passes, the app doesn't.** Review comments were never saved in the running app (0 rows in the live database), while `FileEditor.comments.test.tsx` passed (#58). **Rule:**
  - A test that mocks the database or the WebView doesn't prove the production path.
  - Check the live database (read only) or the real flow when a feature "works in tests".
- **The affordance was never drawn.** The cause of #58: the comment gutter (`commentsExtension` in `src/ui/editor/comments.ts`) was created without CodeMirror's `renderEmptyElements: true`. CodeMirror draws a gutter cell only on lines that have a marker, so on a file with no comments the hover "+" appeared on the cursor's line alone, and every other line was a blank strip that gave no sign it could be clicked. The save path and ⇧⌘C worked; nobody could find the way in. Fixed by giving every line a gutter marker of its own, which also carries the tooltip "Add a Comment (⌥⌘M)". The tests drove the keyboard shortcut and the save function, never the thing a person clicks. **Rule:**
  - Test the entry point a person uses: the rendered control (a cell, a button, a menu item exists and responds), not only the handler behind it.
  - Gutters, widgets and decorations in CodeMirror render only what their config asks for. Check the config options for "empty" or "default" rendering before assuming the DOM is there.
  - When a feature has zero real-world uses (an empty table, no log lines), suspect discoverability before suspecting the data path.
- **Test counts as a regression check.** Compare the combined test count with `main` plus what each PR adds. A drop means a test was lost. Also audit that no existing test file lost `it(` or `expect(` calls.
- **Green locally, red on CI: a different Node.** The outbox's `send.test.ts` passed on the local Node 25 and failed 6 tests, deterministically, on CI's Node 22 (`.github/workflows`: `node-version: 22`). Cause: the file never installed its own storage. On Node 22 jsdom's `localStorage` works, so one test's outbox entries leaked into the next; on Node 25, Node's own built-in `localStorage` shadows jsdom's and silently stores nothing, so the tests passed *by accident*. **Rule:**
  - Before reporting tests as passing, also run them on CI's Node: `npx -y -p node@22 -- node node_modules/vitest/vitest.mjs run`.
  - Any test touching persisted state installs a fresh in-memory store per test; never rely on the environment's `localStorage`.
  - Don't patch globals the runtime owns; inject through the module's own seam.
- **Green locally, red on CI: a fixture git never saw.** #97's tests read `src/gh/fixtures/job-failed.log`. `.gitignore` has `*.log`, so the file existed in the worktree and the suite passed there, but it was never committed: CI and a merge trial both failed to resolve the import. **Rule:**
  - After committing, run `git status --short --ignored` on new fixture folders, or run the suite from a clean checkout of the pushed branch.
  - Name fixtures with an extension the repo doesn't ignore (`.txt`, `.json`, `.jsonl`).
- **A cue that never fired, behind a catch-all and a mock.** Albedo's dock bounce and notification banners never reached the owner (#102), though `attention.ts` was fully tested. Each failed differently, and each error was caught and dropped as "a nicety":
  - The bounce was refused: `core:window:default` does not include `allow-request-user-attention`.
  - The banners went through `tauri-plugin-notification`, which on desktop answers "granted" without asking macOS. It posts through the deprecated `NSUserNotificationCenter`, which no longer delivers.
  - The tests replaced both behind `__setAttentionBackend`, so nothing ever ran the real path.

  **Rule:**
  - A feature that reaches outside the app (OS attention, notifications, an external CLI) is checked once in the installed app, not only through its test seam.
  - Its failures are logged, not swallowed: "a nicety" may fail quietly to the user, never to the console.
  - A Tauri API call needs its permission in `capabilities/default.json`; `default` sets grant less than they sound.
- **Running tests while files change.** A vitest run started in the same command as a rebase reported 13 fewer tests. **Rule:** run the suite only after git has finished rewriting the tree, and rerun when a count looks wrong.

## Cleanup paths

- **An optional helper blocked a core action.** Removing a task failed with "forbidden path: ~/.albedo/phpantom/phpantom_lsp/.phpantom.toml (not a git failure)". Archive calls `stopPhpantom(worktree)`, which awaited the server's *start*; the start had failed (the config write was refused), so the stop rethrew that error and the archive aborted. The start failed because Tauri's fs scope `$HOME/.albedo/**` does not match dot-files on Unix (`requireLiteralLeadingDot`), so PHPantom had never started at all and navigation silently used git grep. **Rule:**
  - Cleanup of an optional component (language server, watcher, probe) never throws into the action it is part of: catch, log, carry on.
  - Dot-files are covered by the fs scope's globs only because `requireLiteralLeadingDot` is off (#93); see "Shared helpers and scope".
  - An optional feature that fails to start says so somewhere visible, instead of silently falling back for months.
- **Not installed looked like broken.** After #73 said "couldn't start", an absent PHPantom still fell back to git grep in silence; the owner took the approximate lists (same-named methods, nothing through inheritance) for broken navigation (#172). **Rule:**
  - An optional component reports its availability (running / failed / not installed) from the module that owns it, and the UI shows that state rather than guessing it.
  - A fallback answer says so where it is listed ("Text search: may include false matches"), not only in a notice that may have been dismissed.

## Data and contracts

- **`schema.sql` is migration v1 and is never edited.** tauri-plugin-sql checksums applied migrations. New columns go in a new numbered migration, registered in `src-tauri/src/lib.rs`.
- **A test build must not open the real database.** It applies new migrations to the owner's data, and an older installed build may then refuse to start. **Rule:** run test builds with their own bundle identifier and a separate `HOME`.

## UI

- **Defaults that lose work.** The composer cleared its draft on every task switch, by design, and a project switch is a task switch (#55). **Rule:** treat anything the user typed as data: keep it until it's sent or explicitly discarded.
- **A late send acting on the wrong task.** Caught in review of #56: switch task while a send is still being written, and when that send completed it cleared the composer -- which by then held the *new* task's restored draft. A send held at a permission prompt was also simply dropped on a switch (#55's first version). **Rule:** anything that completes asynchronously (a send, a save, a release) acts only on the task that started it; check ownership at completion, not at start, and on failure give the text back to its own task.
- **Two writers on one pty.** Buttons (Push, Create PR, Clear, the model picker) wrote to the terminal directly while the outbox released held messages; two pastes landing between a paste and its Enter merge into one message (#56 review). **Rule:** every write to a task's pty goes through one gateway with a per-task lock; no component calls `submitPty` on its own.
- **Two copies of the same thing on screen.** The file name showed three times in the editor (#57), and "Transcript" twice while the editor was open. **Rule:** before adding a label, check whether a parent row already shows it.

- **Ages out of line in the task list.** In a group of 12 Idle rows, the first nine showed their age ("1h", "2d") about 30px left of the last three. Cause: the hidden ⌘1–9 hint shares the age's grid cell and is wider than the age, so on those nine rows the cell grew and the start-aligned age moved left. It showed once a list had more than nine rows. **Rule:** content that shares a cell with something hidden by `visibility` is aligned to the edge it should keep (`justify-self: end` for a right column); check a list longer than the shortcut range.
- **Links that look clickable and do nothing.** File names in the transcript did nothing on click (#110):
  - **Selection anywhere blocked the click.** `useActivate` ignored a click whenever any text in the window was selected. A diff line number is `user-select: none`, so clicking it never cleared an earlier selection, and every click on it was swallowed.
  - **Some names were never links.** A bare name in backticks (`` `Foo.php` ``) and a range (`` `a.php:64-75` ``) look like the links beside them, but weren't.
  - **Terminal links went nowhere.** The terminal's web links used `window.open`, which does nothing in the webview.

  **Rule:**
  - A guard that cancels a click checks only what belongs to the element clicked.
  - An "opener" that gives up says so, or falls back to something visible (Go to File); it never just returns.
- **A parsed block that nothing draws.** `envelopes.ts` parsed `<agent-message>` into a block, but `MessageRow`'s switch had no case for it and ended in `default: return null`. On this machine 6 messages from other sessions never appeared at all, and a newer `<cross-session-message>` showed as raw XML under "You" (#106). **Rule:**
  - A switch over a union of things to draw is exhaustive (`const unhandled: never = block`), so a new kind without a case is a type error, not an empty row.
  - Hiding a kind is written as its own case with the reason (as hand-backs are), never left to `default`.

- **Send stopped scrolling to the end.** Owner-reported (#142): after sending, the transcript stayed put and "↓ Latest ⌘↓" appeared; the message and the reply were below the fold. Cause, in two parts:
  - `onSent` called `jumpToEnd()` before the echo row and the working line were drawn, and nothing pinned the transcript after they were: its follow logic ran only when `messages` changed. Old since the echo existed, but harmless while `following` stayed true -- the first transcript row then took the reader to the end.
  - #136 made `grow()` collapse the dragged box to measure it, and put the transcript's `scrollTop` back afterwards. On send that put-back writes the pre-echo position, fires a scroll event, and `onScroll` reads "70px above the end" and turns following off. Confirmed by `sendScroll.test.tsx`: the "no Latest button" case passes at `2109f34^` and fails at `2109f34`.

  **Rule:**
  - Anything that writes `scrollTop` also fires a scroll event that decides `following`. Before writing it, the content must already be in its final state, or the event reads a stale distance.
  - A row the pane draws from its own state (the echo, the working line) is content like any other: a following reader stays at the end after every commit, not only after `messages` changes.
  - Scroll behaviour is tested with a layout model (heights, `scrollTop` clamping, scroll events and `requestAnimationFrame` in frame order), not by asserting a handler was called.

## Shell scripts (for agents)

- **zsh `path` is `PATH`.** `while read path …` in zsh wipes the command search path, and every later command is "not found". Use another variable name.
- **Project folders start with `-`.** In `~/.claude/projects`, a glob like `*/*.jsonl` passes `-Users-…` to grep as options. Use `--` before the file list.
