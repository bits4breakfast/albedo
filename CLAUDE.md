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

## Contrast

The first thing the user said after running this app was that they could not
read it. Three rules came out of the fix:

1. **4.5:1 is a floor, not a preference.** Measure against `--panel-raised` —
   selected and hovered rows, i.e. the row most likely being read. Measuring
   against `--bg` alone flattered `--muted` to 4.24 when it was really 3.18.
2. **Never dim text with `opacity`.** It composites *after* the token is chosen,
   so it silently undoes the contrast that token guaranteed, and it is invisible
   to any audit of the variables. Use a lower-contrast token instead.
3. **Every surface belongs in the token block.** A ground invented locally is a
   text-contrast decision made by someone thinking only about a hover state.
   `--panel-hover` and `--panel-active` exist for exactly this.
4. **Audit against tinted grounds, not only flat ones.** A token cleared at 4.5
   against `--panel` stops being true the moment a component washes the ground
   beneath it, and nothing in the variables shows it. Found twice, independently:
   light `--add`/`--del`/`--accent` clear 5.0+ on white and fail at 4.2-4.35 on a
   diff row tint; shell text tokens at exactly 4.5 on white measure 3.71-3.93 on
   the worktree warning tints. Either give the token headroom (~5.4 on the flat
   ground) or let the tinted surface carry its own text tiers. Say in the token
   comment which grounds a value was cleared against.
5. **Never `color-mix(… , transparent)` for a tint that must be legible.** It
   composites against whatever happens to be behind it, so one declaration
   darkens on a dark ground and *lightens* on a light one -- the ratio inverts
   with the theme, silently. Name the ground: `color-mix(in srgb, var(--warn)
   80%, var(--track))`. A p% mix with a ground is arithmetically identical to a
   p% alpha composite over it, so naming it changes nothing except that it stays
   correct when the theme flips.
6. **An alpha is not theme-portable.** The same alpha over near-black and over
   near-white lands a completely different separation, because the token beneath
   it differs too. Every wash needs a measured value per theme.

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
