# Architecture

How Albedo is put together, and the decisions behind it that are easy to undo
by accident. Read [CLAUDE.md](../CLAUDE.md) first: it holds the hard rules (the
two channels, the narrow hook-events widenings, contrast, the shared contracts)
and this document does not repeat them. The transcript format itself is in
[TRANSCRIPT-FORMAT.md](TRANSCRIPT-FORMAT.md).

## Data flow

**The pty executes; it is never read.** Each task runs `claude` in a real
pseudo-terminal (`src-tauri/src/pty.rs`, bridged by `src/lib/pty.ts`). Bytes
go to xterm.js and nowhere else. Input goes the other way: keystrokes, and a
few deliberate writes from the UI (the message box, a note after a file save).
Nothing parses the output, so nothing breaks when Claude Code changes how it
draws its TUI.

**The transcript is the source of truth.** Claude Code appends one JSON line
per event to `~/.claude/projects/<dir>/<session>.jsonl`, with subagent runs in
`<session>/subagents/*.jsonl`. `src/capture/watcher.ts` tails those files by
byte offset (`transcript_files.bytes_ingested`), parses only complete lines
through `src/capture/adapter.ts`, and inserts `Message` rows into SQLite. A
30-second poll compares disk with what was ingested, because a filesystem watch
can succeed and never fire (network mounts, WSL's `/mnt/c`). Only sessions
Albedo has a reason to hold are captured: those belonging to a task, and those
imported from History. Everything else stays on disk for Claude Code to own.

**The UI reads SQLite.** `src/ui/useTasks.ts` lists tasks, subscribes to
`onCaptureUpdate` and `onTasksChanged`, and derives each task's status with
`deriveStatus` (`src/capture/status.ts`) from persisted rows only. The
transcript pane, touched files, search, the session browser and context meters
are all queries over the same tables.

**Hook events cover what the transcript cannot see yet.** A permission prompt
or a question is written to the transcript only once the turn ends, so while a
task waits on you, the transcript is silent. Albedo starts `claude` with a
`--settings` block whose hooks run `~/.albedo/hook.sh <task>`, which appends a
line to `~/.albedo/events/task-<id>.jsonl`. `src/capture/hookEvents.ts` reads
it and is the only file that knows the payload shape. It answers "this task is
waiting on you, on what", carries the answer back for a `PermissionRequest`,
and reports `SessionStart`. The exact scope, and why it is that narrow, is in
CLAUDE.md. If hooks cannot be installed, the session starts without them and
status falls back to the transcript alone.

**The status-line snapshot.** The same script, in `status` mode, is Claude
Code's `statusLine`. It writes `~/.albedo/events/status-<id>.json` with the
plan's five-hour and seven-day usage, the context window size and the session
id. `planUsage()` feeds the status strip (`src/ui/StatusBar.tsx`);
`withReportedWindow()` in `src/capture/context.ts` replaces an inferred context
limit with the one Claude Code reported.

**How a task knows its session.** Albedo picks the session id before `claude`
runs: `planSpawn()` in `src/ui/sessionSpawn.ts` returns `--session-id <new>`
for a new task, `--resume <id>` for an existing one, and
`--resume <src> --fork-session --session-id <new>` for a fork. `Terminal.tsx`
records that id through `linkTaskSession()` (`src/capture/sessionLink.ts`)
before spawning. Afterwards it changes only when the task's own terminal
reports a `SessionStart` with another id (`/clear`, `/resume`) or when History
attaches a past session. Each change is logged to `~/.albedo/logs/sessions.jsonl`.
Capture finds a transcript's task by session id, never by folder in a shared
checkout.

## Module map

Entry points listed are exported today; "called by" is the main consumers, not
an exhaustive list.

### `src/capture/` — transcripts into SQLite, and everything derived from them

| file | owns | main entry points |
| --- | --- | --- |
| `adapter.ts` | the JSONL format, alone | `parseLine`, `parseTranscript`, `extractUsage`, `titleOf`, plus SQL expressions (`usageSqlExpr`, `gitBranchSqlExpr`, `prosePromptSqlPredicate`) so queries elsewhere never name a JSON path |
| `watcher.ts` | tailing, backfill, polling, import | `startCapture`, `onCaptureUpdate`, `onCaptureProgress`, `listDiskSessions`, `importTranscripts`, `reconsiderSession` |
| `status.ts` | task status from rows | `deriveStatus`, `statusExpiresAt`, `pendingQuestion`, `RUNNING_WINDOW_MS` |
| `context.ts` | context-window occupancy | `contextUsage`, `contextUsageForSessions`, `contextBands`, `withReportedWindow`, `CONTEXT_WINDOW_TIERS` |
| `usage.ts` | token totals over rolling windows | `usageSummary`, `windowUsage`, `usageBreakdown` |
| `hookEvents.ts` | the hook and status-line payloads | `startHookEvents`, `hookSettingsArg`, `pendingPrompt`, `onPromptChange`, `answerPrompt`, `onSessionStart`, `onStatusSnapshot`, `planUsage`, `snapshotForSession` |
| `sessionLink.ts` | the only writer of `tasks.session_id` | `linkTaskSession`, `newSessionId`, `sessionTranscriptExists`, `lastModelOf` |
| `queue.ts` | Claude Code's input queue, in memory | `queuedFor`, `onQueueChange` |
| `modelCatalog.ts` | model choices and windows | `loadModelChoices`, `loadDefaultModel`, `loadModelWindows` |

`index.ts` is the public surface. Called by `useTasks.ts`, `App.tsx`,
`Terminal.tsx`, the transcript pane, `StatusBar.tsx` and the session browser.
`src/db/` imports SQL expressions from `adapter.ts` so the format still lives
in one file.

### `src/db/` — SQLite access

`index.ts` holds tasks and messages: `getDb`, `listTasks`, `getTask`,
`createTask`, `updateTask`, `archiveTask`, `deleteTask`, `purgeTaskHistory`,
`compactHistory`, `getMessages`, `insertMessages`, `adoptSessionIntoTask`,
`searchMessages`, `findTaskBySessionId`, `onTasksChanged`, and the transcript
file records the watcher keeps. Alongside it:

- `projects.ts`: `listProjects`, `createProject`, `updateProject`,
  `findProjectByRepo`, `normalizeRepoPath`, `listUnclaimedRepos`,
  `onProjectsChanged`.
- `sessions.ts`: `listPastSessions` for the History browser, aggregated in SQL.
- `touched.ts`: `touchedFiles`, `touchedFilesDetailed` for the Files pane.
- `subagents.ts`: `listSubagents`, `liveRuns`.
- `comments.ts`: review comments on a task's files (`listComments`,
  `addComment`, `relocate`, `formatForClaude`).
- `schema.sql` is migration 1; `migrations/0002`…`0007` follow and are
  registered in `src-tauri/src/lib.rs`. Never edit an applied migration; add a
  new numbered one.
- `testkit.ts`: `createTestDb`, `seedTurn`, `seedTranscriptFile` for tests.

Called by `capture/`, `useTasks.ts`, `App.tsx` and most dialogs.

### `src/git/` — git, always as argv

- `worktree.ts`: the runner (`git`, `gitOk`, `setGitRunner` for tests) and
  everything a task's checkout needs: `createWorktree`, `removeWorktree`,
  `listWorktrees`, `uncommittedChanges`, `probeWorkAtRisk`, `assessLoss`,
  `repoRootFor`, `repoToplevel`, `listBranches`, `baseFreshness`,
  `branchCommits`.
- `reconcile.ts`: path primitives, worktree ownership (`albedoOwnsWorktree`,
  `worktreeSharedWithLiveTask`), `validateWorktreeRoot`, and `findOrphans` for
  the reconcile view.
- `slug.ts`: `nameTask`, `branchNameFor`, `isValidRefName`.
- `moveTask.ts`: `planMove`, `runMove`, moving a task between its worktree
  and the main checkout.
- `resumePlace.ts`: `planResumePlace`, `recreateWorktree` for a session whose
  folder is gone.
- `branchSync.ts`: `useBranchSync`, keeping `tasks.branch` in step with git.
- `fileDiff.ts`, `findInFiles.ts`, `codeIndex.ts`, `phpRefs.ts`: per-file
  diffs, Find in Files, the quick-open index, and git-grep PHP references.

Called by the new-task, archive, move and reconcile dialogs, `GitBar.tsx`,
the Files pane, quick open and the editor.

### `src/gh/` — the GitHub CLI

`gh.ts` runs `gh` (argv only, never throws at callers: no PR, no `gh`, offline
all end as `null`). `prStatus.ts` parses `gh pr view` and labels it.
`prStore.ts` caches and polls (`usePrStatus`, `usePrPolling`,
`refreshPrStatus`). Called by `PrBadge.tsx`, `GitBar.tsx`, `TaskList.tsx` and
the follow-up flow.

### `src/lsp/` — PHPantom, navigation only

`jsonrpc.ts` frames messages (`Connection`, `Deframer`). `phpantom.ts` is the
server pool (`phpantomFor`, `warmPhpantom`, `stopPhpantom`,
`phpantomInstalled`), at most `MAX_SERVERS` at once, each with a watcher on its
worktree. Called by `src/ui/editor/symbolNav.ts`, and stopped by the archive
and move dialogs. Scope and packaging are in CLAUDE.md.

### `src/lib/` — small, mostly pure helpers

- `pty.ts`: `spawnPty`, `writePty`, `resizePty`, `killPty`. Output and exit
  arrive through the `PtyHandlers` passed to `spawnPty`, as bytes.
- `paths.ts`: `resolveInWorktree`, `parsePathRef`, `setWorktreeProbe`.
- `handEdited.ts`: `markHandEdited`, `isHandEdited`, `handEditedFiles`.
- `issueKey.ts`: `parseIssueKey`, `fillPromptTemplate`.
- `highlight.ts`: Shiki (`highlightToTokens`, `THEMES`).
- `diff.ts`: `diffStrings`, `parseUnifiedDiff`, `langForPath`.
- Also `anchor.ts`, `fuzzy.ts`, `fsGrants.ts`, `pasteImage.ts`, `ptyInput.ts`,
  `platform.ts`, `urls.ts`, `openUrl.ts`, `clipboard.ts`, `build.ts`.

### `src/ui/` — the React shell

- `App.tsx`: layout, dialogs, and wiring between panes.
- `useTasks.ts`: task list state, status derivation, subagent and hook updates.
- `Terminal.tsx`: one xterm per task; builds the spawn argv, links the
  session, and exports `submitPty`, `notePty`, `hasLivePty`, `startPty`.
- `sessionSpawn.ts`: `planSpawn`, pure.
- `TaskList.tsx`, `StatusBar.tsx`, `StatusDot.tsx`, `GitBar.tsx`,
  `TouchedFiles.tsx`, `SessionBrowser.tsx`, `NewTaskDialog.tsx`,
  `ArchiveTaskDialog.tsx`, `MoveTaskDialog.tsx`, `WorktreeReconcile.tsx`,
  `ProjectsDialog.tsx`, `QuickOpen.tsx`, `FindInFiles.tsx`.
- `attention.ts`: dock bounce, in-window mark and notification when a task
  needs you. `shortcuts.ts`: the keymap table that `ShortcutsHelp.tsx` renders.
- `theme.ts`: the theme choice. `sendPrompt.ts`: buttons that hand a prompt to
  a session.

### `src/ui/transcript/` — the read pane

`TranscriptPane.tsx` (including the message box), `MessageRow.tsx`,
`ToolChip.tsx`, `Diff.tsx`, and `PromptCard.tsx`, the "waiting on you" card.
`envelopes.ts` is the single place that knows the machine-generated blocks
inside user turns; `toolViews.ts` is the single place that knows each tool's
input shape. `composerBridge.ts` lets other panes put text into the message box.

### `src/ui/editor/` — viewing and light editing

`FileEditor.tsx` (CodeMirror for editing behaviour, Shiki for colour, no
completion or linting), `EditorTabs.tsx` and `tabsModel.ts`, `FileDiffView.tsx`,
`symbolNav.ts` (Go to Declaration and Find Usages: PHPantom, then `phpRefs`,
then the code index), review comments (`comments.ts`, `CommentViews.tsx`), and
`openFile.tsx` (`FileOpenContext`, `useOpenFile`) so any pane can open a file
without knowing what the editor is.

### `src-tauri/src/`

- `pty.rs`: `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`,
  `pty_kill_stale`. Four threads per pty; events go over a per-spawn channel so
  a fast exit (a rejected `--resume`) is never lost. Spawns through the login
  shell and strips `ANTHROPIC_API_KEY` twice: `env_remove`, then an `unset`
  after the profile is sourced. Each needs the other.
- `lib.rs`: app setup, plugins, the migration list, the menu (Close Tab
  instead of Close Window, a Quit that asks while tasks are busy:
  `set_busy_tasks`, `quit_app`).
- `fsx.rs`: `canonicalize_path`, which the fs plugin lacks.
- `fsscope.rs`: `allow_project_dir`, widening the fs scope at runtime to a
  folder the user picked.

## Design decisions

### Repository identity is not the working tree

Inside a linked worktree, `git rev-parse --show-toplevel` returns the
worktree, not the repository. "Which project is this?" is answered by
`--path-format=absolute --git-common-dir`, then its parent: `repoRootFor()` in
`src/git/worktree.ts`. `--path-format=absolute` matters; without it the common
dir can come back as the literal `.git`. "What is the working tree?" is
`repoToplevel()`, which is what `uncommittedChanges` and friends want.

On a `Task`:

| field | meaning |
| --- | --- |
| `worktreePath` | where the session runs. For a resumed session, its original cwd. |
| `repoPath` | the repository root, never a worktree. |
| `projectId` | resolved from `repoPath` by `findProjectByRepo`. Null is valid and lands the task in "Other". |

Albedo resolves and links automatically, but never invents a project:
creating one is the user's decision.

### What "the transcript" of a task is

A task's transcript is every row carrying its `task_id`, ordered by `ts`. It
is not a file (one session can span several files) and not a session (a task
can span several). Continuing a past session adopts that session's whole
history onto the task (`adoptSessionIntoTask`). Subagent rows carry the
parent's `session_id` plus an `agent_id`, so they arrive with the parent and
the pane folds each run into one expandable group.

Consequences:

- Query by `taskId` when the question is "what did this task do"; by
  `sessionId` only when browsing history no task owns.
- `seq` is file-local (`lineIndex * SEQ_STRIDE + blockIndex`) and restarts in
  a resumed or forked file. Task-wide ordering uses `ts`; `afterSeq` only
  means something within one session.
- A fork starts a new session and does not inherit the source's history:
  adoption is a single UPDATE with no inverse, so adopting on a fork would take
  rows away from the task that owns them. A forked task's transcript begins at
  the fork.

### Paging with `getMessages`

Results always come back ascending. `limit` keeps the most recent rows when
`afterSeq` is absent (status needs the tail; fed the oldest rows of a long
session it would report stale status forever) and the oldest rows after
`afterSeq` when present. Forward pages are therefore contiguous by
construction: under tail semantics a full forward page would silently drop
the rows between `afterSeq` and the page. `afterSeq` is exclusive. There is
deliberately no `beforeSeq`.

### Archive and delete drop Albedo's copy, not Claude Code's

Archiving or deleting a task purges its messages, comments and
`transcript_files` row (`purgeTaskHistory`). Claude Code's own `.jsonl` is
never touched, so the conversation can be brought back from History, which
re-reads the file from byte 0. The status flips to archived before the purge,
so the watcher cannot re-hold the session halfway through. Unbounded growth of
the copy is why this changed from "keep everything".

### A task only removes a worktree it created

`tasks.owns_worktree` (migration 4) is 0 for a task that resumed a session in
an existing folder, which is often the main checkout. Removing that on archive
would be catastrophic and would look reasonable in the dialog. So
`ArchiveTaskDialog` offers worktree removal and branch deletion only when
`albedoOwnsWorktree()` is true and no live task shares the folder, and
`findOrphans` never treats a not-owned path as reclaimable. Anything outside
every project's worktree root is classified `unknown` and gets no remove
button.

A project's `worktreeRoot` is validated on save (`validateWorktreeRoot`): it
must be absolute after `~` expansion, not `/`, not a home directory, and not
inside the repository. A bad root would otherwise fail at task creation, the
worst moment. `createWorktree` refuses a path that already exists.

### Prompts and resumes go in argv

`claude` takes the opening prompt as a positional argument and `--resume` as a
flag, so both are passed at spawn. Writing them into the pty after spawn would
need to know when the TUI finished booting, and the only way to know is to
read terminal output.

- The project's prompt template (`{key}`, `{rest}`, `{title}`, `{branch}`;
  `fillPromptTemplate`) is empty by default and sent only on a `new` spawn of
  a task that never started. The value is pinned in a ref at mount, so
  "did we prompt?" never depends on the session id arriving mid-spawn.
- Every task resumes its own session on reopen; closing the app never discards
  a conversation.
- A resume can fail (stale id, pruned transcript). The exit code says so. A
  non-zero exit with no output at all (the one permitted boolean in
  `Terminal.tsx`) offers a fresh session in the same folder, so a task never
  becomes unopenable.
- A past session whose folder is gone is offered a recreated worktree on its
  branch, or the checkout where that branch now lives (`resumePlace.ts`).

The message box is different: the user pressing send is the signal, so
`submitPty` writes it (bracketed paste, then a separate `\r`). `notePty` puts
an unsent one-line note in the input after a file save and never submits.

### Issue keys without a tracker integration

A title starting with a key like `PROJ-123` (`parseIssueKey`: 2-10 uppercase
letters, a hyphen, uppercase alphanumerics, followed by an explicit terminator)
names the branch and the worktree folder after it. Albedo never calls a
tracker API: the prompt names the issue and Claude Code's own tools look it
up. No credentials in the app, and any key family works.

### Paths from a transcript are untrusted

`resolveInWorktree()` in `src/lib/paths.ts` is the one place a path seen in a
transcript becomes a filesystem path. It returns null for anything escaping
the task's worktree, including `..` and symlinks pointing out. `canonicalize_path`
only resolves; the containment decision stays in TypeScript. `allow_project_dir`
widens what the fs plugin may read but is not a containment check either.

### Touched files include what git sees

`touchedFiles` groups the task's rows by `target_path`, then merges
`git status`. A file git reports that the transcript never mentioned is kept
with `source: 'git'`: the agent can change files through Bash, and leaving
them out would make the view lie. Under-reporting is the dangerous direction.

### Theming

`data-theme` on `<html>` (`src/ui/theme.ts`): absent means follow the system,
`light` or `dark` forces one. Tokens in `src/styles.css`, all three blocks
required:

```css
:root                                   { /* full light palette */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light'])       { /* dark overrides */ }
}
:root[data-theme='dark']                { /* same dark overrides */ }
```

No colour may be defined only inside a media or `[data-theme]` block: it would
be undefined in the other theme and render as nothing. Shiki runs with dual
themes (`--shiki-light` / `--shiki-dark`), so switching never re-tokenises.
xterm reads the tokens through `terminalTheme()` and re-themes live terminals
in place without respawning. The contrast bar is the same in both themes; see
CLAUDE.md.

`color-mix()` needs Safari 16.4 / a recent WKWebView. `vite.config.ts` targets
`safari15` and esbuild passes `color-mix` through untouched, so the real floor
is the system webview.

### Honesty rules the UI follows

Do not "fix" these:

- **No percentage without a known denominator.** Plan percentages come only
  from Claude Code's status line; a window whose reset time has passed since
  the last report reads as unknown, not as its old figure. Context shows a
  percentage when the limit is known (`limitBasis: 'known'`, or reported by
  the status line), and only the exact token count when it is inferred from
  the session's peak.
- **`cache_read` is never added to spend.** It is re-reported every turn, so
  summing it inflates usage by orders of magnitude.
- **Reuse the shared thresholds** (`StatusDot.tsx`, `contextBands`) rather than
  re-deriving them: a context figure that disagrees with the task row's is
  worse than none.
- **Status comes from facts.** `deriveStatus` reads persisted rows (an
  unanswered `tool_use` is a waiting prompt; `stop_reason` beats recency) and
  hook events say when a prompt is open. `done` and `archived` are set by the
  user, never derived.

### Validate by running it

Most of what Albedo does is observe another program's side effects, and the
tests mock exactly that boundary. A green suite has coexisted with a file
watcher that was never compiled in (the fs plugin gates `watch` behind a Cargo
feature) and with subagent rows silently discarded by a unique index that
fixtures, each seeding one file per session, could never collide on.

So:

- After a capture change, write a transcript line and watch it land.
- Count: parse the real files with the adapter, compare with the table.
- A fixture that never reproduces the real shape proves nothing.

## Known gaps

- **No reprocessor.** A fully ingested file is never re-read, so an adapter
  improvement applies only to new lines. `raw_json` is kept so this is
  fixable; nothing is built yet.
- **Forks have no ancestry link.** A forked task's transcript begins at the
  fork with nothing pointing at the source.
- **An import cycle** between `src/git/worktree.ts` and `reconcile.ts`. Safe
  while neither touches the other at module evaluation; a top-level constant
  initialised across it would break it. The fix is to move the path
  primitives into one module.
- The backlog, with reasons, is in [TODO.md](TODO.md).
