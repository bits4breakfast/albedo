# Albedo

A desktop cockpit for running several Claude Code sessions at once.

Each piece of work is a **task**: its own branch, its own git worktree, and its
own Claude Code session. Albedo keeps them side by side, tells you which one is
waiting on you, and gives you a readable view of what each has done.

Albedo wraps Claude Code and never replaces it. Every task runs the real
`claude` in an embedded terminal, exactly as it would in your shell, so your
settings, hooks, skills and subscription all apply unchanged.

![Albedo's main window: tasks grouped by state on the left, the selected task's transcript in the middle, and the files it changed on the right](docs/screenshots/main-window.png)

## What it does

### See every session at a glance

The task list groups tasks by what they need from you: **Needs You**,
**Running** and **Idle**. A task that ends its turn on a question gets a **?**
mark, so you can tell it is waiting for a decision rather than finished.

- **N Waiting** in the title bar jumps to the next task that needs you.
- A dock bounce and a pulse on the row tell you when a task gets blocked or
  finishes while you are looking elsewhere.
- Every repository gets a **project tab** in the title bar, and **⌥1–9**
  switches between them.
- The status strip shows your plan's **Session** (five-hour) and **Week**
  limits, with the time each one resets.

### Answer permission prompts without hunting for the terminal

When Claude Code asks for permission, the question appears as a card under the
transcript. **Allow**, **Deny**, or **Allow, Don't Ask Again**, which adds the
rule Claude Code suggests and shows you exactly which rule that is. Questions
Claude asks with options are offered as buttons too, plus a field for your own
answer.

The terminal prompt stays live the whole time. Answer in whichever place is
closer, and **Answer in Terminal** takes you there.

![A task waiting on a permission prompt: the card offers Allow, Allow Don't Ask Again, and Deny for a test command](docs/screenshots/waiting-on-you.png)

### Read the session instead of scrolling a terminal

The **Transcript** view renders the conversation from Claude Code's own session
files, without parsing terminal output. Tool calls are compact rows,
thinking folds away, and edits open into diffs with word-level highlighting.
Click any file path to open it.

- Switch between **PTY**, **Split** and **Transcript** with **⌘\\**. Split shows
  the terminal and the transcript side by side or stacked.
- Write to Claude from the composer under the transcript: **Enter** sends,
  **⌘U** attaches files, and images arrive as pictures.
- Change a task's model, or clear or compact its context, from the composer.
- When Claude starts subagents, a strip shows them, and clicking one opens that
  agent's own transcript.

![The transcript in dark theme: a task that finished its turn by asking which behaviour to pick](docs/screenshots/dark-question.png)

### Worktrees without the cleanup

**New Task** (**⌘N**) cuts a fresh branch into its own worktree, or works on an
existing branch, or uses the main checkout. Tasks can move between a worktree
and the main checkout, uncommitted changes included. Archiving or deleting a
task asks what should happen to its worktree and branch.
**More › Worktrees…** finds worktrees that were left behind.

### Review what changed

The **Files** panel lists every file the task touched, split into uncommitted
changes and commits on the branch, with line counts. Pin it as a column next to
the transcript, or keep it as a tab.

- The **Editor** opens any file in tabs, either as it is now or as this task's
  diff (**⇧⌘D**).
- Select lines and press **⇧⌘C** to leave a review comment, then send your
  comments to Claude in one go.
- One button at the top of Files moves the branch along: **Push**, then
  **Create PR**, then the pull request itself with its check status. Squash &
  Rebase is in the menu next to it.
- When a PR is merged, the task offers a follow-up task and a cleanup.

### Find your way around the code

- **⇧⇧** Search Everywhere, **⇧⌘O** Go to File, **⌘O** Go to Class,
  **⌥⌘O** Go to Symbol.
- **⇧⌘F** Find in Files, with match-case and regex.
- **⌘B** or **⌘-click** Go to Declaration, **⌥F7** Find Usages. For PHP these
  use the optional PHPantom language server when it is installed, and git grep
  otherwise.
- **⌥F12** opens a shell drawer in the main checkout.

### Get back to old conversations

**History** searches the full text of every session Albedo has captured, plus
Claude Code sessions it has not imported yet. Resume or fork any of them into
a task. If the session's worktree is gone, Albedo can recreate it or resume in
another folder.

## Keyboard shortcuts

**⌘/** shows this list inside the app. On Windows and Linux, ⌘ is Ctrl.

| Keys | Action |
| --- | --- |
| ⌘N | New Task |
| ⌘1…9 | Jump to the Nth task |
| ⌥1…9 | Jump to the Nth project |
| ⌘[ / ⌘] | Previous / next task |
| ⌘\\ | Cycle PTY / Split / Transcript |
| ⇧⇧ | Search Everywhere |
| ⇧⌘O / ⌘O / ⌥⌘O | Go to File / Class / Symbol |
| ⇧⌘F | Find in Files |
| ⇧⌘P | Push the selected task (commits first) |
| ⌘U | Attach files to the message |
| ⌘B, ⌥F7 | Go to Declaration, Find Usages (in the editor) |
| ⇧⌘C | Comment on the selected lines (in the editor) |
| ⌘↓ | Jump to the latest message |
| ⌥F12 | Shell in the main checkout |
| ⌘+ / ⌘− / ⌘0 | Bigger / smaller / actual-size text |

## Install

Albedo runs on macOS and Linux, and on Windows as a Linux app under WSL2 (see
[docs/LINUX-WSL.md](docs/LINUX-WSL.md)). You need Claude Code installed and
signed in, Node 22+, and a Rust toolchain.

```sh
./build.sh --install
```

This checks the prerequisites, runs the tests, builds the app (`.app`/`.dmg` on
macOS, `.deb`/`.AppImage` on Linux) and installs it. `./build.sh --help` lists
the options, including `--with-phpantom` to bundle the PHP language server.

Then add a project (a git repository) and create your first task with **⌘N**.

Albedo removes `ANTHROPIC_API_KEY` from every session it starts, so Claude Code
always runs on your subscription and never silently on API billing.

## Development

```sh
npm install
npm run tauri dev   # run the app
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

Start with [CLAUDE.md](CLAUDE.md) for the architecture rules,
[docs/INTERFACES.md](docs/INTERFACES.md) for the module contracts, and
[docs/TRANSCRIPT-FORMAT.md](docs/TRANSCRIPT-FORMAT.md) for the transcript format.

The screenshots above come from a sandboxed copy of the app with made-up
projects and conversations.

## The name

Named after Edoardo and Alberto (ALB + EDO). Albedo is the fraction of
incident light a surface reflects rather than absorbs. The app generates
nothing: it reflects a Claude Code session back in a readable form.
