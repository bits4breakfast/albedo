# Contributing to Albedo

Albedo is a Tauri app: a React and TypeScript frontend, and one Rust file for
the pty (`src-tauri/src/pty.rs`). For what it does and how to use it, see the
[README](README.md).

## What to expect

Albedo is a personal tool, built and maintained in spare time by a small team.
Pull requests from forks are welcome, but nobody is on call for them, so
please read this before you start.

- **Open an issue first for anything bigger than a small fix.** Albedo
  deliberately does less than it could (see [CLAUDE.md](CLAUDE.md)), and a
  feature that does not fit will be declined however well it is built. A few
  lines in an issue save you a weekend.
- **First response: within two weeks.** That is a reply, not a review: it may
  be "yes, go ahead", "not for now", or "this needs a decision first".
- **Review: when there is time.** Small, focused pull requests are reviewed
  sooner; one that touches many areas at once waits the longest.
- **Inactive pull requests close after 30 days** without a reply from the
  author. Closing is not a judgement on the work, and you can reopen it.
- **No pull request is guaranteed to be merged**, and a maintainer may take
  an idea and implement it differently.
- **CI runs on your pull request** once a maintainer approves the run, which
  GitHub requires for first-time contributors.

By contributing, you agree that your contribution is licensed under the
[MIT license](LICENSE).

## Beyond Albedo's current choices

Albedo today runs Claude Code, works on GitHub, and gives type-aware
navigation only for PHP (see "Opinionated by design" in the
[README](README.md)). Those are where it started, not where it has to stay.
Proposals for other languages, git hosts or coding agents are welcome. Open
an issue first, because each one touches a boundary that has to stay clean:

- **Another language's navigation** fits beside `src/lsp/phpantom.ts`: a
  language server that answers Go to Declaration and Find Usages, optional,
  with git grep (`src/git/phpRefs.ts`) as the fallback.
- **Another git host** fits beside `src/gh/`: pull request status read
  through that host's CLI, degrading to "no badge" when it is missing.
- **Another coding agent** is the largest change. Everything structured comes
  from Claude Code's transcript files through one adapter
  (`src/capture/adapter.ts`), and a second agent needs its own adapter
  producing the same `Message` rows. The terminal output stays unparsed.

## What to work on

The backlog is in [GitHub issues](https://github.com/bits4breakfast/albedo/issues).
If you are new to the code, start with one labelled "good first issue".

Not planned: a file tree, search across tasks, a ripgrep sidecar, and
per-task usage or auth mode. Open an issue before starting on any of them.

## A good pull request

- One change, with a description of what it does for someone using the app
  and why.
- Tests for the behaviour it changes, and `npm test` and `npm run typecheck`
  passing.
- Tried in the running app (see below), with a screenshot for anything
  visible.
- Within the rules in [CLAUDE.md](CLAUDE.md). The terminal's output is never
  parsed, and the transcript format stays inside `src/capture/adapter.ts`. A
  change that breaks either will not be merged.

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
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the module map, the data
  flow, and the design decisions behind them.
- [docs/TRANSCRIPT-FORMAT.md](docs/TRANSCRIPT-FORMAT.md): the transcript
  format, which only `src/capture/adapter.ts` may know.
- [docs/LINUX-WSL.md](docs/LINUX-WSL.md): running and testing on Linux and
  under WSL2.

`src/types.ts` and `src/db/schema.sql` are shared contracts: propose changes
to them rather than making them in passing.
