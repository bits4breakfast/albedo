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
- **Unverified claims about Claude Code.** A PR stated that `--append-system-prompt` applies on every spawn. Measured with `claude -p`: it applies when the session is created, persists across `--resume`, and is ignored when passed on resume. **Rule:** measure Claude Code behaviour (version noted) before writing it in code or a PR. Say what wasn't measured (interactive mode, `/clear`).

## Shared helpers and scope

- **Changing a shared helper for one feature.** Chat tasks made `taskBase('')` return null. That also changed the main-checkout browse diff, from "against upstream" to "against HEAD", which nobody asked for. **Rule:**
  - Before changing a shared function, list every caller: `git grep`.
  - If another caller's behaviour changes, don't. Scope the change to the feature instead.
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
- **Running tests while files change.** A vitest run started in the same command as a rebase reported 13 fewer tests. **Rule:** run the suite only after git has finished rewriting the tree, and rerun when a count looks wrong.

## Cleanup paths

- **An optional helper blocked a core action.** Removing a task failed with "forbidden path: ~/.albedo/phpantom/phpantom_lsp/.phpantom.toml (not a git failure)". Archive calls `stopPhpantom(worktree)`, which awaited the server's *start*; the start had failed (the config write was refused), so the stop rethrew that error and the archive aborted. The start failed because Tauri's fs scope `$HOME/.albedo/**` does not match dot-files on Unix (`requireLiteralLeadingDot`), so PHPantom had never started at all and navigation silently used git grep. **Rule:**
  - Cleanup of an optional component (language server, watcher, probe) never throws into the action it is part of: catch, log, carry on.
  - A file whose name starts with a dot needs that dot spelled out in the fs scope.
  - An optional feature that fails to start says so somewhere visible, instead of silently falling back for months.

## Data and contracts

- **`schema.sql` is migration v1 and is never edited.** tauri-plugin-sql checksums applied migrations. New columns go in a new numbered migration, registered in `src-tauri/src/lib.rs`.
- **A test build must not open the real database.** It applies new migrations to the owner's data, and an older installed build may then refuse to start. **Rule:** run test builds with their own bundle identifier and a separate `HOME`.

## UI

- **Defaults that lose work.** The composer cleared its draft on every task switch, by design, and a project switch is a task switch (#55). **Rule:** treat anything the user typed as data: keep it until it's sent or explicitly discarded.
- **A late send acting on the wrong task.** Caught in review of #56: switch task while a send is still being written, and when that send completed it cleared the composer -- which by then held the *new* task's restored draft. A send held at a permission prompt was also simply dropped on a switch (#55's first version). **Rule:** anything that completes asynchronously (a send, a save, a release) acts only on the task that started it; check ownership at completion, not at start, and on failure give the text back to its own task.
- **Two writers on one pty.** Buttons (Push, Create PR, Clear, the model picker) wrote to the terminal directly while the outbox released held messages; two pastes landing between a paste and its Enter merge into one message (#56 review). **Rule:** every write to a task's pty goes through one gateway with a per-task lock; no component calls `submitPty` on its own.
- **Two copies of the same thing on screen.** The file name showed three times in the editor (#57), and "Transcript" twice while the editor was open. **Rule:** before adding a label, check whether a parent row already shows it.

## Shell scripts (for agents)

- **zsh `path` is `PATH`.** `while read path …` in zsh wipes the command search path, and every later command is "not found". Use another variable name.
- **Project folders start with `-`.** In `~/.claude/projects`, a glob like `*/*.jsonl` passes `-Users-…` to grep as options. Use `--` before the file list.
