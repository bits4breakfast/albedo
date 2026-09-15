# Albedo

Personal desktop cockpit for running multiple Claude Code sessions.

Named after Edoardo and Alberto (ALB + EDO). Albedo is the fraction of incident
light a surface reflects rather than absorbs. The app does not generate
anything; it reflects a Claude Code session back in a readable form.

## What it solves

1. Conversation history is not searchable or easy to revisit
2. Parallel sessions are hard to track — which one is blocked, which is done
3. Worktrees are created manually and land in folders that are painful to clean up
4. Reading diffs in flat terminal output is tiring

PHPStorm stays the editor. This is a cockpit, not an IDE.

## Architecture in one line

**Wrap Claude Code, do not replace it.** It runs in an embedded pty exactly as
it does in a terminal; the app reads structure from the transcript JSONL on
disk and never parses terminal output.

See `CLAUDE.md` for the rules, `docs/INTERFACES.md` for the module contracts,
and `docs/TRANSCRIPT-FORMAT.md` for the transcript format the adapter isolates.

## Setup

Requires Node 20+ and a Rust toolchain (`rustup`, installed at `~/.cargo`).

```sh
npm install
npm run tauri dev
```

```sh
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Status

MVP milestones M1–M4: transcript capture, shell + session list, worktrees,
transcript pane. M5 (cross-task search UI, inline CodeMirror edits, per-task
usage accounting, per-task auth mode) is out of scope for now.
