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
