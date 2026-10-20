# Contributing to Albedo

Albedo is a Tauri app: a React and TypeScript frontend, and one Rust file for
the pty (`src-tauri/src/pty.rs`). For what it does and how to use it, see the
[README](README.md).

## Set up

You need Node 22 or newer and a Rust toolchain (`rustup`, installed at
`~/.cargo`). On Linux, `./build.sh` prints the system libraries Tauri needs.

```sh
npm install
npm run tauri dev   # run the app
```

## Checks

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
cargo fmt && cargo clippy --manifest-path src-tauri/Cargo.toml
```

CI (`.github/workflows/ci.yml`) runs them on every push, and builds the Linux
`.deb` and `.AppImage` on demand. `./build.sh` runs the same checks before a
release build.

Most of what Albedo does is observe another program's side effects, and the
tests mock exactly that boundary. A green run is necessary, not sufficient:
run the app and try the change.

## Read before changing anything

- [CLAUDE.md](CLAUDE.md): the architecture rules and why they exist. The one
  that matters most: the terminal is execution only and its output is never
  parsed. Structured data comes from the transcript files on disk.
- [docs/INTERFACES.md](docs/INTERFACES.md): the module contracts.
- [docs/TRANSCRIPT-FORMAT.md](docs/TRANSCRIPT-FORMAT.md): the transcript
  format, which only `src/capture/adapter.ts` may know.
- [docs/STATUS.md](docs/STATUS.md) and [docs/TODO.md](docs/TODO.md): where
  the work is, and what comes next.
- [docs/LINUX-WSL.md](docs/LINUX-WSL.md): running and testing on Linux and
  under WSL2.

`src/types.ts` and `src/db/schema.sql` are shared contracts: propose changes
to them rather than making them in passing.
