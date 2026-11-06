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
cargo fmt --all && cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets
```

CI (`.github/workflows/ci.yml`) runs them on every push, and builds the Linux
`.deb` and `.AppImage` on demand. `./build.sh` runs the same checks before a
release build.

Most of what Albedo does is observe another program's side effects, and the
tests mock exactly that boundary. A green run is necessary, not sufficient:
run the app and try the change.

## Dependencies

New dependency versions wait out an embargo: **7 days** after they were
published, **14** for a new major (or a new 0.x minor, which npm and Cargo
treat as breaking). A compromised release is usually caught and pulled within
days, and the wait keeps it out of Albedo.

- **Adding or upgrading an npm package:** `npm run deps:add -- <pkg>` (or
  `deps:add-dev`). It runs `npm install --before=<a week ago>`, so npm picks
  the newest version that is at least a week old. Avoid `npm install
  <pkg>@latest`, `npm update` and `cargo update`: they take whatever was
  published a minute ago. Cargo has no equivalent of `--before`, so after
  any Rust update run `npm run deps:check` before pushing.
- **The gate:** on every pull request that changes `package-lock.json` or
  `src-tauri/Cargo.lock`, CI (`dependency-age` in
  `.github/workflows/ci.yml`) runs `scripts/check-release-age.mjs`. It asks
  the npm registry and crates.io when each *new or changed* version was
  published and fails the PR if any is under the embargo. Unchanged entries
  are never re-checked. If a registry cannot be reached, it fails rather than
  let a version through. Git, `file:` and linked dependencies have no publish
  time; they are listed as skipped, for a human to look at. Run it locally
  with `npm run deps:check` (compares against `origin/main`).
- **Dependabot** (`.github/dependabot.yml`) applies the same 7/14 days as its
  `cooldown` for version updates. Security updates are not delayed by
  Dependabot, but still meet the gate.
- **Override, for an urgent fix:** add the exact version to
  `.dependency-embargo-allow.json` in the same PR, with a reason. The entry
  is part of the PR diff, so whoever reviews the PR approves the exception.

  ```json
  { "allow": [
    { "ecosystem": "npm", "name": "some-package", "version": "1.2.4",
      "reason": "fixes GHSA-xxxx-xxxx-xxxx, published yesterday" }
  ] }
  ```

  `ecosystem` is `npm` or `cargo`. Remove the entry once the version is past
  the embargo.

## Screenshots: the demo profile

Screenshots in the README and anywhere else public come from the demo
profile, never from a window you work in: a real window shows real projects,
branches and conversations. Everything in the demo is made up. Keep it that
way: no real project, company, customer, issue key or worktree name, and no
lorem ipsum either.

```sh
npm run demo                  # reset the demo and start the app in it
npm run demo -- --no-reset    # start it again as you left it
npm run demo -- --setup-only  # reset only
npm run demo -- --no-reset --real-claude  # your own claude; see below
```

**What it is.** The app runs with its own home folder,
`/Users/Shared/albedo-demo` on macOS and `~/.albedo-demo` elsewhere
(`ALBEDO_DEMO_HOME` moves it), and its own bundle identifier, so its
database, `~/.albedo`, `~/.claude/projects`, worktrees and web storage are all
separate from yours. Nothing of yours is read or written. `npm run demo`
starts `tauri dev`, so quit any other `tauri dev` first (port 1420).

**What's in it.** `scripts/demo/scenario.mjs`: two projects, `recipe-app`
and `blog`, with git repositories, worktrees, commits and transcripts, and six
tasks in every state the task list has:

| Task | State |
| --- | --- |
| Add dark mode to settings | Waiting on you: Allow or Deny `npm test -- src/settings` |
| Import recipes from a link | Running |
| Search recipes by ingredient | Running |
| Round amounts to kitchen fractions | Ready to Review, PR #14 open, approved, checks green |
| Show cooking time on recipe cards | Done |
| Add an RSS feed (`blog`) | Idle, finished on a question |

**No Claude login, no network.** On the demo's PATH, `claude` and `gh` are
scripted stand-ins (`scripts/demo/fake-claude.mjs`, `fake-gh.mjs`). The
`claude` stand-in plays a task's session back when its terminal starts: it
appends the transcript lines and runs the hooks Albedo passed it, so the
waiting card, Running and the plan meters come through the real pipe. Allow
or Deny on the card is answered by the real hook script, and the session
carries on accordingly. Its terminal says it is a stand-in. `gh` answers the
PR badge, its review state and the Checks dialog for the one made-up pull request.

**A reset** rebuilds everything from the scenario, timed from now, and keeps
the app's own preferences (zoom, theme, layout, the selected task), which
live in its web storage. Reset again before a shoot if the ages in the task
list have grown.

### The hero shot

The image at the top of the README, and in a launch post. It shows one idea:
several pieces of work in parallel, and one of them needs you.

1. `npm run demo`, and wait for the window.
2. Start the sessions: a terminal starts only when its task is first opened.
   Click **Import recipes from a link**, **Search recipes by ingredient**,
   then **Add dark mode to settings**. The first two move to Running, the
   third to Needs You with its card.
3. Keep **Add dark mode to settings** selected. Layout **Transcript**
   (**⌘\\**), with **Files** pinned as a column. Scroll the transcript to the
   end (**⌘↓**), so the card, the last edits and the commits show.
4. **⌘+** once or twice (110% or 125%), so the task titles can be read on a
   phone.
5. **⋯ › Theme: Dark**, and take it again in **Theme: Light**.
6. Capture the window: **⇧⌘4**, then **Space**, then **⌥**-click the window
   (no shadow). Save it as `docs/screenshots/main-window.png`.

For a post, take the same arrangement as a portrait or square frame
(1080×1350 or 1200×1200): either a crop of the task list and the waiting card,
or the full window on a plain background with a margin.

Don't press Allow or Deny before the shot: each answers the prompt for good.
Reset to get it back.

### The other screenshots

| File | How |
| --- | --- |
| `main-window.png` | The hero shot, above. |
| `window-areas.png` | The hero shot in Light, with the areas numbered as in the README's "The window", added in Preview (Markup). |
| `waiting-on-you.png` | The hero arrangement, cropped to the transcript's end and the card. |
| `dark-question.png` | The `blog` tab, **Add an RSS feed**, Dark, Transcript layout: the turn ending on a question. |

**Where the demo stops.** The stand-in plays only its script: a new task
made in the demo, or a message sent to one, gets no answer. Anything that
needs a real session (a reply, a subagent, an AskUserQuestion card, a
compaction) is taken by hand, still in the demo profile:
`npm run demo -- --no-reset --real-claude` starts the app with your own
`claude` instead of the stand-in. The demo's home has no Claude Code settings
of yours, so if it asks you to sign in, run `/login` in the task's terminal.
Work only in the demo projects, and write prompts you would be happy to
publish: they end up in the transcript you photograph.

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
