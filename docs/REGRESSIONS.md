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
- **Running tests while files change.** A vitest run started in the same command as a rebase reported 13 fewer tests. **Rule:** run the suite only after git has finished rewriting the tree, and rerun when a count looks wrong.

## Data and contracts

- **`schema.sql` is migration v1 and is never edited.** tauri-plugin-sql checksums applied migrations. New columns go in a new numbered migration, registered in `src-tauri/src/lib.rs`.
- **A test build must not open the real database.** It applies new migrations to the owner's data, and an older installed build may then refuse to start. **Rule:** run test builds with their own bundle identifier and a separate `HOME`.

## UI

- **Defaults that lose work.** The composer cleared its draft on every task switch, by design, and a project switch is a task switch (#55). **Rule:** treat anything the user typed as data: keep it until it's sent or explicitly discarded.
- **Two copies of the same thing on screen.** The file name showed three times in the editor (#57), and "Transcript" twice while the editor was open. **Rule:** before adding a label, check whether a parent row already shows it.

## Shell scripts (for agents)

- **zsh `path` is `PATH`.** `while read path …` in zsh wipes the command search path, and every later command is "not found". Use another variable name.
- **Project folders start with `-`.** In `~/.claude/projects`, a glob like `*/*.jsonl` passes `-Users-…` to grep as options. Use `--` before the file list.
