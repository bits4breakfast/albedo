# Module interfaces

Frozen contract between workstreams. Each signature is owned by exactly one
module; callers code against it before the implementation lands. If you need a
change here, raise it with the lead — do not edit another module's files.

## `src/lib/pty.ts` — owner: pty workstream

```ts
export function spawnPty(opts: PtySpawnOptions): Promise<string>;   // resolves to ptyId
export function writePty(ptyId: string, data: string): Promise<void>;
export function resizePty(ptyId: string, cols: number, rows: number): Promise<void>;
export function killPty(ptyId: string): Promise<void>;
export function onPtyOutput(ptyId: string, cb: (bytes: Uint8Array) => void): () => void;
export function onPtyExit(ptyId: string, cb: (code: number | null) => void): () => void;
```

`onPtyOutput` hands the caller **decoded bytes**; base64 is an implementation
detail of the bridge. Both `on*` return an unsubscribe function.

## `src/db/index.ts` — owner: capture workstream

```ts
export function getDb(): Promise<Database>;

export function listTasks(opts?: { includeArchived?: boolean }): Promise<Task[]>;
export function getTask(id: number): Promise<Task | null>;
export function createTask(t: NewTask): Promise<Task>;
export function updateTask(id: number, patch: Partial<Task>): Promise<void>;
export function archiveTask(id: number): Promise<void>;

export function getMessages(opts: {
  taskId?: number;
  sessionId?: string;
  afterSeq?: number;
  limit?: number;
}): Promise<Message[]>;

export interface SearchHit { message: Message; snippet: string; taskTitle: string | null }
export function searchMessages(query: string, opts?: {
  taskId?: number; repoPath?: string; toolName?: string;
  since?: number; until?: number; limit?: number;
}): Promise<SearchHit[]>;
```

## `src/capture/index.ts` — owner: capture workstream

```ts
export function startCapture(): Promise<CaptureHandle>;
export interface CaptureHandle { stop(): Promise<void> }

/** Fires whenever rows land, so the UI can refresh without polling. */
export function onCaptureUpdate(
  cb: (u: { sessionId: string; cwd: string | null; lastSeq: number }) => void,
): () => void;

/** Status derived from persisted rows only. Never from pty output. */
export function deriveStatus(messages: Message[]): TaskStatus;

/** Rolling 5h-window usage for the header, from transcript usage records. */
export function usageSummary(): Promise<{ inputTokens: number; outputTokens: number; sinceTs: number }>;
```

## `src/git/worktree.ts` — owner: worktree workstream

```ts
export interface WorktreeInfo { path: string; branch: string | null; head: string; locked: boolean }

export function repoName(repoPath: string): Promise<string>;
export function listBranches(repoPath: string): Promise<{ current: string; all: string[] }>;
export function worktreePathFor(project: Project, slug: string): Promise<string>; // <worktreeRoot>/<slug>
export function createWorktree(o: { repoPath: string; baseBranch: string; branch: string; path: string }): Promise<void>;
export function listWorktrees(repoPath: string): Promise<WorktreeInfo[]>;
export function uncommittedChanges(worktreePath: string): Promise<{ files: string[]; dirty: boolean }>;
export function removeWorktree(o: { repoPath: string; path: string; branch: string | null; force: boolean; deleteBranch: boolean }): Promise<void>;
export function findOrphans(o: {
  repoPaths: string[];        // repos to ask git about (projects + tasks, unioned)
  worktreeRoots: string[];    // every project's worktreeRoot -- Albedo's territory
  knownPaths: string[];       // worktrees a live task claims
  reclaimablePaths: string[]; // archived tasks' worktrees, still on disk
}): Promise<OrphanInfo[]>;
// Options object, not positional. It grew to four string[] lists, and a caller
// swapping two of them would have type-checked fine and silently misclassified
// -- which here means offering to delete the wrong worktree.
```

## `src/lib/diff.ts` — owner: transcript-pane workstream

```ts
export function diffStrings(oldText: string, newText: string, path: string): FileDiff;
export function parseUnifiedDiff(text: string): FileDiff[];
export function langForPath(path: string): string;
```

## React components

```ts
// src/ui/Terminal.tsx        — owner: shell
<Terminal task={Task} onExit={(code) => void} />
// src/ui/TaskList.tsx        — owner: shell
<TaskList tasks={Task[]} selectedId={number|null} onSelect={(id)=>void} onNew={()=>void} />
// src/ui/NewTaskDialog.tsx   — owner: worktree
<NewTaskDialog open={boolean} onClose={()=>void} onCreated={(t: Task)=>void} />
// src/ui/WorktreeReconcile.tsx — owner: worktree
<WorktreeReconcile open={boolean} onClose={()=>void} />
// src/ui/transcript/TranscriptPane.tsx — owner: transcript
<TranscriptPane taskId={number|null} sessionId={string|null} />
```

## Styling

One stylesheet, `src/styles.css`, owned by the shell workstream. Other
workstreams add their rules in a clearly commented block at the end of their own
component file via a co-located `<style>`-free convention: use CSS custom
properties already defined in `styles.css` (`--bg`, `--panel`, `--border`,
`--text`, `--muted`, `--accent`, `--add`, `--del`) and add class names prefixed
with your area (`tx-` transcript, `wt-` worktree). Do not edit `styles.css`
outside the shell workstream — append to `src/ui/<area>.css` and import it.

---

# Lead rulings

Resolved after the shell workstream surfaced them. These are binding.

1. **Component exports.** `NewTaskDialog`, `WorktreeReconcile` and `TranscriptPane`
   are **default exports**. A named export alongside is fine; the default must exist.

2. **`getMessages` ordering.** Results always come back **ascending by `seq`**
   (for `{taskId}` queries: `ts` ASC, `seq` ASC as tiebreaker, because `seq`
   restarts at 0 in a resumed session's transcript file).

   Which end `limit` truncates depends on the paging direction:

   | call | `limit` keeps |
   | --- | --- |
   | `afterSeq` absent | the **most recent** rows (tail) |
   | `afterSeq` present | the **oldest** rows after that seq (head) |

   `deriveStatus` depends on the tail case: fed the oldest 400 rows of a long
   session it would report stale status forever.

   The head case exists because the alternative is unsafe. With tail semantics a
   forward page that comes back *full* silently means rows between `afterSeq` and
   the returned window were dropped, so a caller appending that page splices a
   hole into the middle of its transcript — and it surfaces as a rendering bug
   nowhere near its cause. Direction-dependent truncation makes forward paging
   contiguous by construction. `afterSeq` is exclusive.

3. **`listTasks()`** excludes `archived` unless `{ includeArchived: true }`.

4. **`usageSummary().sinceTs`** is the **start of the rolling 5h window**
   (`now - 5h`), not the timestamp of the oldest record in it. The header computes
   remaining window time from it directly.

5. **Task mutation notifications.** `src/db/index.ts` additionally exports:

   ```ts
   export function onTasksChanged(cb: () => void): () => void;
   ```

   Fired by `createTask`, `updateTask` and `archiveTask` after the write commits,
   and by the capture watcher when it adopts a `sessionId` or bumps
   `last_activity_at`. In-process only — one app, one window, so a simple
   module-level Set of callbacks is sufficient. Without it the shell cannot see
   task rows mutated behind its back by the worktree or capture modules.

---

# Recorded for M5, not acted on

**`rawJson` at the read boundary.** Transcript lines on this machine are
brutally long-tailed: mean 3.1 KB, p99 35 KB, largest single line 1.06 MB
(measured across 115 files / 207 MB). A render window containing a few of those
is dominated by them regardless of pagination strategy. If the transcript pane
ever feels slow, a `getMessages` variant that omits or truncates `rawJson` for
render-only callers buys far more than paging changes — the pane only needs
`rawJson` for the handful of rows it actually expands.

This does **not** relax CLAUDE.md rule 2: `raw_json` is never dropped at the
*write* boundary. This is about what a read hands back.

**`TouchedFile` has no "outside the worktree" flag.** A transcript path that
resolves outside the task's checkout is deliberately kept (under-reporting is
the dangerous direction) but is distinguishable only by its leading `/`. If the
touched-files view ever needs to style or filter those, that wants a field
rather than a string test.

**`beforeSeq`.** Deliberately not added. Backward paging re-reads the window
(0.6 MB per step at k=1, growing linearly), which is real but bounded: the
largest session observed is 3,675 lines, ~18 steps to walk entirely. Revisit
when sessions exceed ~5k rows, or when the pane must hold >1,000 rows at once.

---

# M4 additions — touched files, opening and editing

Added to the spec after the first five workstreams landed. Same rules: one
owner per signature, callers code against this doc.

## `src/lib/paths.ts` — owner: editor workstream

**The single place path resolution happens.** The spec is explicit that
resolution is worktree-scoped and enforced in one place: `src/Foo.php` always
means *this task's* checkout. Nothing else in the app may join a transcript path
to a filesystem path.

```ts
export interface ResolvedPath { absolute: string; relative: string }

/**
 * Resolve a path seen in a transcript against a task's worktree.
 * Returns null when the path escapes the worktree -- callers render it as
 * plain text rather than a link. Must reject `..` traversal, absolute paths
 * outside the worktree, and symlinks pointing out of it.
 */
export function resolveInWorktree(worktreePath: string, raw: string): Promise<ResolvedPath | null>;

/** Pull `path:line` / `path:line:col` / `path", line N` out of transcript text. */
export function parsePathRef(text: string): { path: string; line: number | null } | null;
```

Containment is a security boundary, not a convenience: a transcript is data the
app renders, and a path in it must never be able to open or write outside the
task's checkout.

## `src/lib/handEdited.ts` — owner: editor workstream

```ts
/** Session-scoped, in memory. Cleared when the app restarts, per spec. */
export function markHandEdited(taskId: number, relPath: string): void;
export function isHandEdited(taskId: number, relPath: string): boolean;
export function onHandEditedChange(cb: () => void): () => void;
```

## `src/ui/editor/FileEditor.tsx` — owner: editor workstream

```ts
// default export
<FileEditor task={Task} request={OpenFileRequest | null} onClose={() => void} />
```

CodeMirror 6 + Shiki highlighting. Light edits only: no autocomplete, no
linting, no LSP. `Cmd+S` writes straight to the worktree, then:
1. marks the file hand-edited for the session, and
2. calls `notePty(taskId, …)` to place an unsent one-line note in the pty input.

## `src/ui/editor/openFile.tsx` — owner: editor workstream

App-wide entry point so any renderer can ask for a file without knowing what
the editor is.

```ts
export const FileOpenContext: React.Context<(req: OpenFileRequest) => void>;
export function useOpenFile(): (req: OpenFileRequest) => void;
export function openInPhpStorm(worktreePath: string, relPath: string, line?: number | null): Promise<void>;
```

## `src/ui/Terminal.tsx` — owner: shell workstream (addition)

```ts
/**
 * Place text in the pty's input WITHOUT submitting it. The agent may be
 * mid-turn, so sending stays manual -- write the text, never a newline.
 * Returns false when the task has no live pty.
 */
export function notePty(taskId: number, text: string): Promise<boolean>;
```

## `src/db/touched.ts` — owner: touched-files workstream

```ts
export function touchedFiles(taskId: number): Promise<TouchedFile[]>;
```

Groups `messages` by `target_path` for the task's sessions (edit count, last
touched), then merges `git status` from the worktree. A file git reports that
the transcript never mentioned is included with `source: 'git'` — the agent can
change files outside its edit tool and the view would otherwise lie.

## `src/ui/TouchedFiles.tsx` — owner: touched-files workstream

```ts
// default export
<TouchedFiles task={Task} />
```

Rows are clickable and call `useOpenFile()`. This is the change-set view, the
other axis to the chronological transcript.

---

# Additive props and exports (recorded, not frozen)

Added by owners to their own components. All optional, so the frozen
signatures above still hold.

```ts
<TaskList … onArchive?={(t: Task) => void}
            contextBySession?={Map<string, ContextUsage>} />
<Header   … context?={ContextUsage | null} />
```

`src/ui/StatusDot.tsx` (shell-owned) additionally exports the small-indicator
kit: `ContextMeter`, `contextLevel`, `contextReadout`, `contextTitle`,
`CONTEXT_WARN` (0.7), `CONTEXT_HIGH` (0.9). **Reuse these rather than
re-deriving thresholds** — a context figure that disagrees with the one in the
task row is worse than no figure.

## Honesty rule for inferred context limits

Binding on every surface that displays context occupancy.

The transcript records the model id but **not** its context window size, so the
denominator is inferred from the session's observed peak.

| `limitBasis` | render |
| --- | --- |
| `'known'` | a hard percentage (`87%`) |
| `'inferred'` | **no percentage** — the exact token count (`~86k`), hatched fill |

The token count is exact whatever the denominator turns out to be, so it is the
honest fallback. Colour thresholds still apply to inferred readings: the alarm
is the best available signal and suppressing it would be its own failure — but
it is shaped as a hint, never as a claim.

## Additive exports, official

Owners added these within their own modules; recorded so callers can rely on them.

```ts
// src/lib/paths.ts
export type WorktreeProbe =
  (absolutePath: string, worktreeRoot: string | null) => Promise<string | null>;
export function setWorktreeProbe(p: WorktreeProbe): void;

// The probe is a CANONICALISER, not a contained-or-not check. Containment lives
// entirely in resolveInWorktree, so a buggy or lying probe still cannot hand out
// an escape -- there is a test that injects one. `worktreeRoot` is a hint the
// degraded fallback uses to bound its walk, null when the root itself is being
// canonicalised. setWorktreeProbe also clears the canonical-root memo.

// src/lib/handEdited.ts
export function handEditedFiles(taskId: number): string[];  // useful to the touched-files view
export function clearHandEdited(taskId: number): void;

// src/db/touched.ts
export function touchedFilesDetailed(taskId: number): Promise<{ files: TouchedFile[]; gitError: string | null }>;

// src/capture (usage.ts)
export function windowUsage(kind: '5h' | 'week'): Promise<WindowUsage>;
export function usageBreakdown(): Promise<{ input: number; cacheRead: number; cacheCreation: number; output: number }>;
```

## Rust commands

| command | why it exists |
| --- | --- |
| `pty_spawn` / `pty_write` / `pty_resize` / `pty_kill` | the embedded pty; no first-party Tauri plugin exists |
| `canonicalize_path` | `tauri-plugin-fs` exposes `stat`/`lstat` but no `canonicalize`, so worktree containment could not follow a symlink and had to refuse every one of them. The user's own repo has 182. Resolution only — containment stays in `resolveInWorktree`, so the security decision is not split across two languages. |

---

# Projects

Added after the first run. Replaces the hardcoded `~/agents/<repo>/<slug>`
worktree location with a per-project choice, so an existing layout (the user's
own worktrees live under `~/www/worktrees`) stays usable.

Schema lives in `src/db/migrations/0002_projects.sql`. **`src/db/schema.sql` is
migration v1 and is already applied to live databases — never edit it.**
Additions go in a new numbered migration, registered in `src-tauri/src/lib.rs`.

## `src/db/projects.ts` — owner: capture/db workstream

```ts
export function listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>;
export function getProject(id: number): Promise<Project | null>;
export function findProjectByRepo(repoPath: string): Promise<Project | null>;
export function createProject(p: NewProject): Promise<Project>;
export function updateProject(id: number, patch: Partial<NewProject>): Promise<void>;
export function archiveProject(id: number): Promise<void>;
export function onProjectsChanged(cb: () => void): () => void;
```

`repo_path` is UNIQUE — one project per repository. `createProject` on an
existing repo path must fail with a clear error rather than silently returning
the existing row; the caller decides whether to edit it instead.

## `src/git/worktree.ts` — owner: worktree workstream (change)

```ts
// was: worktreePathFor(repoPath, slug) -> ~/agents/<repo>/<slug>
export function worktreePathFor(project: Project, slug: string): Promise<string>;
```

Resolves to `<project.worktreeRoot>/<slug>`, expanding a leading `~`. The extra
`<repo>` segment the old form inserted is gone: the root is now per-project, so
the user's chosen directory *is* the namespace. Two projects sharing a worktree
root is the user's business, but `createWorktree` must refuse a path that
already exists rather than write into it.

## Reconcile — owner: worktree workstream (change)

`findOrphans` scans **every project's `worktreeRoot`**, not `~/agents`. The
classification rule stays: a worktree under a known project's root that no task
claims is an `orphan`; anything outside every known root is `unknown` and gets
no remove button. This is what makes the user's pre-existing `~/www/worktrees`
entries actionable once a project points there, while still never offering to
delete something Albedo has no claim on.

## Path validation

`worktreeRoot` is user-entered, so validate on save, not on use:

- must be absolute (after `~` expansion)
- must not be inside the project's `repoPath` — a worktree inside the repo it
  came from is a mess git will let you create and you will regret
- must not be `/` or a home directory root
- parent must exist; the root itself is created on demand

A bad root is a broken task creation at the worst moment, so fail early and loudly.

## Known import cycle

`src/git/worktree.ts` imports `expandTilde`/`normalizePath` from
`reconcile.ts`, while `reconcile.ts` imports from `worktree.ts` (which also
re-exports `findOrphans`). Safe today because neither module touches the other
at evaluation time, only inside function bodies — but it will break the moment
someone adds a top-level constant initialised from the other module. If it ever
bites, move the path primitives wholesale into `worktree.ts` and the direction
collapses.

## CSS baseline

`color-mix()` is used in `transcript.css` and `gauges.css` (token-derived tints
that must not go stale when a token moves). It needs **Safari 16.4 / WKWebView**.

`vite.config.ts` sets `build.target: 'safari15'` and `cssTarget` inherits it,
but esbuild passes `color-mix` through untouched at that target — verified, not
assumed. Tauri uses the system WKWebView, so the real floor is the user's macOS.
If a lower floor is ever needed, both workstreams hold measured pre-composited
hex equivalents; ask rather than eyeballing replacements, because these values
were each chosen against a specific ground.

---

# Theming

The app was dark-only. Light is now a first-class theme, not a tint of the dark one.

## Mechanism

`data-theme` on `<html>`, written by the shell workstream:

| attribute | meaning |
| --- | --- |
| *(absent)* or `data-theme="system"` | follow `prefers-color-scheme` |
| `data-theme="light"` | force light |
| `data-theme="dark"` | force dark |

Token structure in `styles.css`, and **all three blocks are required**:

```css
:root                                   { /* full LIGHT palette */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light'])       { /* dark overrides */ }
}
:root[data-theme='dark']                { /* dark overrides, same values */ }
```

Guarding the media block with `:not([data-theme='light'])` is what makes the
explicit choice win in both directions. **No colour may have its only definition
inside a media or `[data-theme]` block** — a token defined only in the dark block
is undefined in light, and renders as nothing rather than as wrong, which is
harder to spot.

Also set `color-scheme: light dark` so native scrollbars, form controls and the
webview's own ground follow.

## The bar is the same in both themes

The contrast rules in `CLAUDE.md` are not dark-specific. A light palette must be
measured the same way:

- **4.5:1 for text, 3.0:1 for UI**, against the **worst ground** — in light that
  is the light equivalent of `--panel-raised`, i.e. selected and hovered rows.
- Three distinct text tiers. Light has the same problem inverted: the usable
  range runs from 4.5 up to ~15 against white, so three tiers still fit.
- **The dark palette must not regress.** Re-audit both after the split.

Accent, status, add/del and warn/danger hues almost always need *different*
values per theme, not the same value reused — a colour tuned for 4.5 on near
black is usually 2-something on near white.

## Shiki

`src/lib/highlight.ts` hardcodes `THEME = 'github-dark-default'`. It needs a
light counterpart. Two viable routes, transcript workstream's call:

1. **Dual themes emitting CSS custom properties** (`--shiki-light`/`--shiki-dark`
   per token, CSS picks). No re-tokenising on switch, no flash, and the token
   cache stays theme-agnostic. Preferred.
2. Re-tokenise on theme change and clear the LRU cache. Simpler; costs a
   re-highlight on a rare action.

Whichever is chosen, the diff view's add/del backgrounds and the editor must
agree with it — a light editor showing dark-theme syntax colours is worse than
no highlighting.

## xterm

`Terminal.tsx` builds its theme from `getComputedStyle` on the tokens, so it
follows automatically — but it reads them **once at construction**. It must
rebuild and re-apply on theme change, for every live terminal, without
respawning the pty.

---

# Issue-keyed tasks

The user names a task with a tracker issue key (`ACME-2398`, `PLATFORM-19T`,
`HUB-429902396650`) and expects the branch, the worktree, the task row and the
session itself to pick it up.

## Albedo does NOT integrate the Linear API

Deliberately. Claude Code already has Linear MCP configured on this machine, so
the session can fetch the issue itself. Albedo only has to **name the issue in
the initial prompt**; the agent does the lookup.

That keeps Albedo free of tracker credentials, free of a second integration to
maintain, and works unchanged for `HUB-*` or any other key family without
Albedo knowing what those trackers are. It is also the spec's core rule applied
to a new surface: wrap Claude Code, do not duplicate what it can already do.

## `src/lib/issueKey.ts` — owner: worktree workstream

```ts
export interface IssueRef { key: string; rest: string }
/** Pull a leading tracker key off a task title. Null when there isn't one. */
export function parseIssueKey(title: string): IssueRef | null;
```

Pattern is `PROJ-SUFFIX` anchored at the start: uppercase alpha prefix, hyphen,
alphanumeric suffix. Observed on this machine: `ACME-2398`, `ACME-2387`,
`PLATFORM-19T`, `HUB-429902396650`. Be conservative — a title that merely starts
with a capitalised word must not match.

## Naming, once a key is found

| | with a key | without |
| --- | --- | --- |
| branch | `ACME-2398` or `ACME-2398-<slug of rest>` | `<slug>` (unchanged) |
| worktree dir | `<worktreeRoot>/ACME-2398` | `<worktreeRoot>/<slug>` |
| task row | key as its own chip, title beside it | title only |

Matches the user's existing branches (`ACME-2398`, `ACME-2398-followup`).

## Initial prompt — `claude [prompt]`, not a pty write

`claude` takes a positional prompt argument. Pass it at spawn as argv.

Do **not** write the prompt into the pty after spawn: that needs to know when
Claude Code has finished booting, and the only way to know is to read terminal
output — which is the one thing this app never does. argv sidesteps it entirely.

Per-project template placeholders, all four agreed across workstreams:

| placeholder | value |
| --- | --- |
| `{key}` | the issue key (`ACME-2398`), empty when the title has none |
| `{rest}` | the title minus the key; falls back to the full title when no key |
| `{title}` | the full title exactly as typed |
| `{branch}` | the branch the worktree was cut on |

`{rest}` exists because a template like `"Fetch {key} and implement: {rest}"` has
no other way to name the descriptive half without repeating the key.

The template is stored on
the project. Empty by default — opt-in, because silently prompting an agent the
user has just launched is a side effect they did not ask for.

**Send it only on a task's first spawn** — gate on `task.sessionId === null`.
Re-spawning after a kill must not re-prompt; the session already has the context.

The gate is enforced twice, deliberately: once where the prompt is computed, and
once by pinning the value in a ref **at mount** rather than reading the live prop
inside the spawn effect. The ref is load-bearing — the spawn is async and
`sessionId` flips to non-null as soon as capture adopts the session, plausibly
before the component next renders, so reading the prop inside the effect would
make "did we prompt?" depend on a race.

**Known edge case, accepted:** a task spawned that never writes a transcript
(so `sessionId` stays null) will be prompted again after an app restart. That is
the gate working as specified, and it is arguably right — the agent never got
going. Avoiding it would need a separate `prompted_at` column, which is not worth
a schema change for a case where the current behaviour is defensible.

---

# Resuming captured sessions

Albedo has every past Claude Code session on disk indexed — 115 of them, 41.8
days. `claude --resume <session-id>` reopens one, so this is a browsing problem
more than an execution one.

## The safety constraint, designed in rather than bolted on

A task Albedo cut owns its worktree, so `git worktree remove` on archive is
safe. **A resumed session runs in whatever cwd it originally used**, which is
frequently the main repo checkout (`~/www/acme`). Offering to remove that
on archive would be catastrophic, and would look entirely reasonable on the way
past — the archive flow cannot otherwise tell the difference.

Migration v4 adds `tasks.owns_worktree INTEGER NOT NULL DEFAULT 1`. A resumed
task sets it to 0, and:

- `ArchiveTaskDialog` must not offer worktree removal or branch deletion at all
  when `ownsWorktree` is false. Archive means "drop it from the list" and
  nothing else, and the dialog should say so plainly.
- `findOrphans` must never classify a not-owned path as reclaimable.

## `src/db/sessions.ts` — owner: capture workstream

```ts
export interface PastSession {
  sessionId: string;
  cwd: string | null;
  title: string | null;        // ai-title / custom-title, else null
  firstTs: number;
  lastTs: number;
  messageCount: number;
  taskId: number | null;       // already adopted by a task
  cwdExists: boolean | null;   // null = not checked
}

export function listPastSessions(opts?: {
  query?: string;              // FTS across message bodies
  cwd?: string;
  since?: number;
  limit?: number;
}): Promise<PastSession[]>;
```

Migration v4 also adds `transcript_files.title`. Claude Code writes `ai-title`
and sometimes `custom-title` lines; the adapter skips them as bookkeeping, which
is right for `messages` — but a browser listing 115 conversations needs better
than the first 60 characters of the first prompt. Capture them into that column.

## Resuming — argv, same as the initial prompt

```
claude --resume <session-id>
```

Spawned **in the session's recorded `cwd`**, not in a new worktree: the
conversation's file paths refer to that directory. If the cwd no longer exists,
say so and offer to resume elsewhere rather than failing at spawn.

`--fork-session` starts a copy under a new session id. Worth offering as an
explicit choice ("continue this session" vs "branch from it"), not a default.

## Every task resumes, not just browsed ones

A task's session survives the app closing. Selecting an existing task spawns
`claude --resume <its sessionId>`, not a fresh `claude` — otherwise reopening
Albedo silently discards the conversation, which defeats the point of a cockpit
for long-running sessions.

`spawnArgs` takes precedence over `initialPrompt`, which matters for the **fork**
path specifically: a forked task lands under a new session id, so its
`sessionId` is null and the prompt-template gate alone would let the project
template fire alongside `--fork-session`. The precedence closes it; the
`sessionId === null` gate is necessary but not sufficient.

**Resume can fail** — a stale id, a transcript Claude Code has since pruned. The
exit code carries it (no output parsing needed): on a non-zero exit from a
resume spawn, offer to start a fresh session in the same directory and say why,
rather than leaving a dead pane. A task must never become unopenable because
its transcript aged out.

---

# Repository identity vs working tree — two different questions

A worktree's `git rev-parse --show-toplevel` returns **the worktree**, not the
repository. Using it to answer "which project does this directory belong to"
silently fails for every worktree, which is what put a resumed acme
session into the "Other" tab.

| question | command |
| --- | --- |
| which repository is this part of? | `git rev-parse --path-format=absolute --git-common-dir`, then `dirname` |
| what is the current working tree? | `git rev-parse --show-toplevel` |

Verified: the first returns the same main repo root from inside a linked
worktree **and** from the repo itself. `--path-format=absolute` matters — the
common dir can come back relative otherwise, and a project whose `repo_path` is
the literal string `.git` would be a memorable bug.

`repoRootFor()` in `src/git/worktree.ts` is the only function that answers the
first question. `uncommittedChanges` and friends correctly want the second.

## What each path on a Task means

Getting these confused resumes a conversation in the wrong directory, which is
much worse than a mis-grouped tab:

| field | value |
| --- | --- |
| `worktreePath` | where the session actually runs. For a resumed session, its original cwd, verbatim. |
| `repoPath` | the origin **repository** — the resolved root, never the worktree. Its doc comment always said so; the resumed-task path was setting it to the cwd, contradicting the contract. |
| `projectId` | resolved from `repoPath` via `findProjectByRepo`, which normalises. Null is a valid answer (a session in `~/Downloads`) and lands the task in "Other". Never invent a project. |

---

# What "the transcript" is

The word had come to mean three different things, so: **a transcript is a
task's complete record**, assembled from the rows in SQLite. It is not a file
and it is not a session.

| unit | what it is | why it is not the transcript |
| --- | --- | --- |
| **file** | `<project>/<uuid>.jsonl`, plus nested `subagents/*.jsonl` | an implementation detail. One session can span several files after a resume or compaction; one file holds one session's worth. |
| **session** | one Claude Code conversation, identified by `sessionId` | a task can span several — continue, then fork. Rendering one session truncates the task's story at the fork. |
| **task** | the unit the user named and cares about | ← this. |

## What a task's transcript contains

Everything with its `task_id`, ordered by `ts`:

- **every session the task spanned.** Continuing a browsed session adopts that
  session's whole history onto the task at creation, so a conversation started
  in a terminal weeks ago becomes part of the task the moment it is resumed.
- **subagent work, inline.** Sidechain rows carry the *parent's* `sessionId`
  (verified: all 41 sidechain sessions on this machine also appear as main
  sessions) and add an `agentId`. So they adopt with the parent automatically
  and need no separate association. The pane collapses them into one expandable
  group per run rather than interleaving them with the main thread.

## The one deliberate gap

A **fork** starts a new session and does **not** inherit the source's history —
those messages belong to the session that produced them, and `adoptSessionIntoTask`
is a single UPDATE with no inverse, so adopting on a fork would take history
*away* from whichever task legitimately owned it.

So a forked task's transcript legitimately begins at the fork point. That is
correct, not a bug to fix in the pane — but it means the user loses sight of
where the work came from, and an ancestry link ("forked from …") would be worth
having. Not built.

## Consequences that are easy to get wrong

- Query by `taskId`, not `sessionId`, wherever the question is "what did this
  task do". `sessionId` is right only when no task owns the rows — browsing
  history in the session browser.
- A task's row count can legitimately differ from its session's: larger when it
  adopted a long history, smaller when it is a fork.
