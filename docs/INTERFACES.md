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
export function worktreePathFor(repoPath: string, slug: string): Promise<string>; // ~/agents/<repo>/<slug>
export function createWorktree(o: { repoPath: string; baseBranch: string; branch: string; path: string }): Promise<void>;
export function listWorktrees(repoPath: string): Promise<WorktreeInfo[]>;
export function uncommittedChanges(worktreePath: string): Promise<{ files: string[]; dirty: boolean }>;
export function removeWorktree(o: { repoPath: string; path: string; branch: string | null; force: boolean; deleteBranch: boolean }): Promise<void>;
export function findOrphans(repoPaths: string[], knownPaths: string[]): Promise<WorktreeInfo[]>;
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

**`beforeSeq`.** Deliberately not added. Backward paging re-reads the window
(0.6 MB per step at k=1, growing linearly), which is real but bounded: the
largest session observed is 3,675 lines, ~18 steps to walk entirely. Revisit
when sessions exceed ~5k rows, or when the pane must hold >1,000 rows at once.
