# Albedo

Personal desktop cockpit for running multiple Claude Code sessions. **Wraps**
Claude Code, never replaces it. Spec: Notion "Albedo: MVP Spec".

## Two channels, strictly separated

| Channel | Direction | Purpose |
| --- | --- | --- |
| pty (`src-tauri/src/pty.rs`) | bidirectional | Execution only. Output is **opaque** — never parsed. |
| transcript JSONL on disk | read only | All structured data: search, history, status, diffs. |

Violating this separation is the one architectural mistake that matters.
If you find yourself regexing terminal bytes, stop — the answer is in SQLite.

## Hard rules

1. **Only `src/capture/adapter.ts` knows the JSONL format.** Everything else
   consumes `Message` from `src/types.ts`. A format change must be a one-file fix.
2. **Never drop `raw_json`.** History is reprocessable only if the original is kept.
3. **Strip `ANTHROPIC_API_KEY`** from every spawned environment — an inherited key
   silently bills the API instead of the subscription.
4. The Agent SDK is not used, and there is no Node sidecar.
5. `src/types.ts` and `src/db/schema.sql` are shared contracts. Propose changes,
   do not make them unilaterally.

## Layout

```
src/capture/   transcript watcher + adapter + status derivation   (M1, M2)
src/db/        SQLite access layer and schema
src/git/       worktree create/remove/reconcile                    (M3)
src/ui/        React shell, task list, xterm pane                  (M2)
src/ui/transcript/  transcript renderer and diff component         (M4)
src-tauri/     Tauri shell; src/pty.rs is the only Rust we write
```

## Commands

```
npm run tauri dev     # run the app
npm test              # vitest
npm run typecheck     # tsc --noEmit
cargo fmt && cargo clippy --manifest-path src-tauri/Cargo.toml
```
