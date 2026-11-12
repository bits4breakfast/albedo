//! The pty bridge: the one piece of Rust in Albedo.
//!
//! Responsibility is deliberately narrow. This module runs a child process on a
//! real pty and shuttles **opaque bytes** between it and the webview. It never
//! looks at what those bytes mean -- all structured data comes from the
//! transcript JSONL, never from here (see CLAUDE.md, "Two channels").
//!
//! Threading model, per pty (four threads, each blocked on exactly one thing):
//!
//! ```text
//!   reader   poll(master, wake pipe), read  --->  Vec<u8> chunks;
//!            pauses while too much output is unacknowledged (see [`Flow`])
//!   pump     coalesce ~64KB / ~8ms, send Output on the spawn's Channel;
//!            once the reader is done: take the exit code, deregister, send Exit
//!   waiter   child.wait(); then give the reader READER_GRACE to reach EOF,
//!            and wake it out of poll if it has not
//!   writer   drains the input queue into the master
//! ```
//!
//! The pump finishes last, which is why it -- and not the reader or the waiter
//! -- reports the exit. That ordering guarantees every byte the child produced
//! is delivered before the frontend is told the child is gone.
//!
//! The waiter is its own thread because EOF and the child's exit are not the
//! same event. A background grandchild (`npm run dev &` from a Bash tool call)
//! inherits the slave and keeps it open after Claude Code is gone, so the
//! master never reaches EOF. Waiting for EOF before reaping meant the exit was
//! never reported, the child stayed a zombie and the threads leaked. Now the
//! child is reaped the moment it exits, the reader gets a short grace to drain
//! what is left, and then it is stopped regardless.
//!
//! Output is paced to the page (#366). Without that, a flood (a large `cat`,
//! a long build log, a `--resume` replaying a long conversation) queued in
//! Rust, in Tauri's IPC and in xterm.js all at once, and the webview's main
//! thread filled. The page reports how many bytes xterm has finished writing
//! ([`pty_ack`]); the reader stops reading past [`HIGH_WATER`] unacknowledged
//! bytes, so the child blocks on its own write, as it would in any terminal
//! that falls behind. This counts bytes and never looks at them -- the same
//! class as the one "any bytes arrived" boolean in `Terminal.tsx`, not a
//! precedent for reading output. See [`Flow`] for why a page that stops
//! acknowledging can never freeze its process.
//!
//! Events go over a per-spawn `tauri::ipc::Channel`, not global events. A
//! global event emitted between `pty_spawn` returning and the frontend's async
//! `listen()` registering was simply lost -- a rejected `--resume` exits in
//! milliseconds, so its exit was the event most likely to vanish, leaving the
//! pane "live" over a dead process. The channel exists before the child does.
//!
//! Every session records the page that spawned it. A webview reload does not
//! unmount React, so without that, a reload orphaned every pty and the reopened
//! task spawned a second `claude --resume` on the same session. Each page calls
//! [`pty_kill_stale`] once at startup; see there.
//!
//! The requested command is not spawned directly -- it runs through the user's
//! login shell, so that it sees the same environment it would in a terminal
//! tab. See [`build_command`], which is where the reasoning and the measurement
//! behind that live.
//!
//! Unix only: process groups, `poll` and the self-pipe are POSIX, and Albedo
//! ships for macOS.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Size of a single `read(2)` from the pty master.
const READ_BUF_BYTES: usize = 8 * 1024;

/// Coalescing thresholds. A busy TUI render (Claude Code repainting a spinner,
/// say) produces hundreds of tiny writes per second; forwarding each one as its
/// own IPC message floods the webview and makes xterm.js janky. So the pump
/// accumulates bytes and sends when *either* limit is hit: enough bytes to be
/// worth a round trip, or enough time that a human would notice the latency.
/// 8ms is comfortably under one 60Hz frame, so coalescing is invisible while
/// still collapsing a render storm into a handful of messages.
///
/// The byte limit must sit well above one read. At 4KB it was below a single
/// 8KB read, so during a burst -- exactly when coalescing matters -- every
/// read went out as its own message and the deadline never got a say.
const FLUSH_BYTES: usize = 64 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// How long a killed process group gets to act on SIGHUP before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// How long the reader may keep draining after the child has exited. On a
/// normal exit EOF arrives within a millisecond or two; this only ever runs out
/// when something else still holds the slave open.
const READER_GRACE: Duration = Duration::from_millis(250);

/// How many bytes may be read from a pty and not yet acknowledged by the page
/// before the reader pauses. Far above anything interactive (a spinner tick or
/// a keystroke echo is a few bytes; a full repaint of a large terminal is tens
/// of KB), so only a flood ever reaches it. The page acknowledges in batches
/// of `ACK_BYTES` (src/lib/pty.ts, 128 KB), well under this.
const HIGH_WATER: u64 = 1024 * 1024;

/// How long a paused reader waits for an acknowledgement before it stops
/// waiting. See [`Flow`].
const ACK_STALL: Duration = Duration::from_secs(1);

/// Environment variables that must never reach a spawned Claude Code.
///
/// **Do not delete this, and do not delete either of the two places it is
/// applied.** Albedo wraps the user's Claude Code *subscription*. If an API key
/// is present in the environment, Claude Code silently prefers it and bills the
/// Anthropic API instead -- a real charge, with no visible difference in the UI
/// until the invoice arrives. The base URL is stripped for the same reason: a
/// leftover proxy/gateway endpoint reroutes the session away from the
/// subscription. This is a spec requirement (CLAUDE.md, hard rule 3).
///
/// It is applied twice because one layer is not enough:
///
/// 1. `env_remove` on the CommandBuilder, which strips what Albedo itself
///    inherited, and
/// 2. an `unset` inside the shell command line, which runs *after* the login
///    shell has sourced the user's profile.
///
/// Layer 2 is not redundant. A profile that does `export ANTHROPIC_API_KEY=...`
/// -- which is a completely ordinary thing to have in a `.zshrc` -- reinstates
/// the variable after layer 1 has already run, and the billing bug is silently
/// back. Verified: with only layer 1, a key exported from `.zshrc` reaches the
/// child; with layer 2, it does not.
const STRIPPED_ENV: [&str; 3] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
];

/// Used when `$SHELL` is unset or empty.
#[cfg(target_os = "macos")]
const FALLBACK_SHELL: &str = "/bin/zsh";
#[cfg(not(target_os = "macos"))]
const FALLBACK_SHELL: &str = "/bin/sh";

/// One message on a pty's Channel. Mirrors `PtyEvent` in src/lib/pty.ts.
///
/// Output and exit share one channel so their order is the order they were
/// sent in: the exit can never overtake the last of the output.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Output {
        /// Raw pty bytes, base64 encoded.
        ///
        /// Base64 is not decoration: a pty hands back arbitrary bytes, and a
        /// read can split a UTF-8 codepoint or an escape sequence straight down
        /// the middle. Interpreting those bytes as a String here would corrupt
        /// them (lossy conversion) or fail. Encoding the raw buffer keeps the
        /// byte stream exact; src/lib/pty.ts decodes it back to a Uint8Array.
        data: String,
    },
    Exit {
        /// `null` when the exit status could not be determined.
        code: Option<i32>,
    },
}

/// Mirrors `PtySpawnOptions` in src/types.ts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub cwd: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

/// Which page a session belongs to: the webview's label, and a token the page
/// generates once when it loads. A reload keeps the label and changes the
/// token, which is the whole point.
struct Owner {
    webview: String,
    page: String,
}

/// Everything we keep for a live pty. Removed by the pump once the exit has
/// been reported; dropping it closes the master and ends the writer thread.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Input queue drained by the writer thread, so `pty_write` never blocks.
    input: Sender<Vec<u8>>,
    /// The child's pid, which is also its process group: portable-pty makes it
    /// a session leader (`setsid`), and the login shell `exec`s the command
    /// rather than forking it. Signalling the group reaches whatever Claude
    /// Code started that is still attached to it.
    pgid: libc::pid_t,
    /// Set once the child has been reaped.
    exited: Arc<Latch>,
    /// Bytes read and not yet acknowledged by the page; see [`Flow`].
    flow: Arc<Flow>,
    owner: Owner,
}

type Sessions = Arc<Mutex<HashMap<String, PtySession>>>;

/// Managed by Tauri (`.manage(PtyRegistry::default())` in lib.rs).
#[derive(Default)]
pub struct PtyRegistry {
    /// `Arc` because the pump thread also needs to deregister on child exit,
    /// and a `tauri::State` cannot be moved into a thread.
    sessions: Sessions,
    next_id: AtomicU64,
}

impl PtyRegistry {
    /// Unique enough without pulling in a uuid dependency: a process-local
    /// counter makes it collision-free within a run, the timestamp keeps ids
    /// from being reused across restarts (they end up in log lines and in
    /// frontend maps that may outlive a reload).
    fn new_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("pty-{millis:x}-{n}")
    }

    /// Ends every session when Albedo quits (#360). Closing the masters on
    /// exit only HUPs each foreground group, and the SIGKILL that
    /// [`terminate`] sends after [`KILL_GRACE`] never comes because the app is
    /// gone by then -- so a dev server that ignores SIGHUP, or anything else
    /// in a group, outlived the quit.
    ///
    /// SIGHUP to every group now, wait up to `grace` for them to exit, then
    /// SIGKILL every group whether or not its leader went, as `terminate`
    /// does. Blocks for at most `grace`.
    pub fn shutdown(&self, grace: Duration) {
        shutdown(&self.sessions, grace);
    }
}

fn shutdown(sessions: &Sessions, grace: Duration) {
    // Collected under the lock and signalled after it: the pump deregisters a
    // session under the same lock when its child exits, so waiting while
    // holding it would stall every exit until the deadline. Each flow is
    // released before the signal: a paused reader would hold the exit (see
    // [`Flow`]).
    let groups: Vec<(libc::pid_t, Arc<Latch>)> = sessions
        .lock()
        .values()
        .map(|s| {
            s.flow.release();
            (s.pgid, Arc::clone(&s.exited))
        })
        .collect();
    for (pgid, _) in &groups {
        signal_group(*pgid, libc::SIGHUP);
    }
    let deadline = Instant::now() + grace;
    for (_, exited) in &groups {
        exited.wait(deadline.saturating_duration_since(Instant::now()));
    }
    for (pgid, _) in &groups {
        signal_group(*pgid, libc::SIGKILL);
    }
}

/// A one-way flag that can be waited on with a timeout.
#[derive(Default)]
struct Latch {
    set: Mutex<bool>,
    cv: Condvar,
}

impl Latch {
    fn set(&self) {
        *self.set.lock() = true;
        self.cv.notify_all();
    }

    /// True if the latch was set within `timeout`.
    fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut set = self.set.lock();
        while !*set {
            if self.cv.wait_until(&mut set, deadline).timed_out() {
                break;
            }
        }
        *set
    }
}

/// Output pacing for one pty: a count of bytes read and not yet acknowledged
/// by the page, and the reader's wait on it.
///
/// The reader waits only while all of these hold:
///
/// - at least [`FlowLimits::high_water`] bytes are unacknowledged;
/// - the session is not being ended. [`terminate`] and [`shutdown`] release
///   the flow before they signal: on macOS a process cannot finish exiting
///   -- not even on SIGKILL -- while output it wrote sits unread on its
///   terminal (the last close of the tty waits for it to drain), so a reader
///   still paused there would hold every kill until the stall below;
/// - the child has not exited. The same drain means a child that exits on
///   its own is reaped only once the reader has read everything up to its
///   exit, which a page that acks (or the stall below) lets happen. But a
///   backgrounded grandchild can write after that and pause the reader, and
///   a paused reader does not watch the stop pipe; the waiter releases the
///   flow on the reap so [`READER_GRACE`] keeps meaning exactly what it did;
/// - the page has acknowledged something within [`FlowLimits::stall`].
///
/// The last one is what makes a lost acknowledgement harmless. A page can stop
/// acknowledging for reasons that say nothing about whether the output is
/// wanted: it was reloaded (its sessions are swept by the next page, but only
/// once that page has started), the webview is suspended or throttled in the
/// background, an IPC call failed, a consumer was detached. Blocking the reader
/// until an ack that may never come would freeze Claude Code -- its writes to
/// a terminal are synchronous, so its whole process would stop -- with nothing
/// on screen to say why. So after `stall` without an ack the reader stops
/// waiting and reads on, unpaced, as it did before pacing existed; the next
/// ack proves the page is back and arms the wait again. The cost of a stalled
/// page is the old behaviour (output queues for it), never a hung process.
///
/// Dropping output instead was rejected: the scrollback would silently lose
/// bytes, and an escape sequence cut in half corrupts everything after it.
struct Flow {
    limits: FlowLimits,
    state: Mutex<FlowState>,
    cv: Condvar,
}

#[derive(Clone, Copy)]
struct FlowLimits {
    high_water: u64,
    stall: Duration,
}

const FLOW_LIMITS: FlowLimits = FlowLimits {
    high_water: HIGH_WATER,
    stall: ACK_STALL,
};

#[derive(Default)]
struct FlowState {
    unacked: u64,
    /// Bumped by every ack, so a waiting reader can tell one arrived.
    acks: u64,
    /// The session is ending: never pause again.
    released: bool,
    /// A wait ran out with no ack: do not pause again until the next ack.
    stalled: bool,
}

impl Flow {
    fn new(limits: FlowLimits) -> Self {
        Flow {
            limits,
            state: Mutex::new(FlowState::default()),
            cv: Condvar::new(),
        }
    }

    /// The reader read `n` bytes.
    fn read(&self, n: usize) {
        self.state.lock().unacked += n as u64;
    }

    /// The page finished writing `n` bytes. Saturating: an ack can never take
    /// the count below zero, whatever a page sends.
    fn ack(&self, n: u64) {
        let mut s = self.state.lock();
        s.unacked = s.unacked.saturating_sub(n);
        s.acks = s.acks.wrapping_add(1);
        s.stalled = false;
        self.cv.notify_all();
    }

    /// The session is ending: never pause again.
    fn release(&self) {
        self.state.lock().released = true;
        self.cv.notify_all();
    }

    /// Blocks the reader while it should not read; returns at once otherwise.
    /// The stall clock restarts with every ack, so a page that is slow but
    /// keeps acknowledging keeps the reader paced.
    fn wait_for_room(&self) {
        let mut s = self.state.lock();
        let mut deadline = Instant::now() + self.limits.stall;
        let mut acks = s.acks;
        while s.unacked >= self.limits.high_water && !s.released && !s.stalled {
            if self.cv.wait_until(&mut s, deadline).timed_out() {
                s.stalled = true;
            } else if s.acks != acks {
                acks = s.acks;
                deadline = Instant::now() + self.limits.stall;
            }
        }
    }

    #[cfg(test)]
    fn unacked(&self) -> u64 {
        self.state.lock().unacked
    }
}

/// Where a pty's output and exit go. A trait only so the lifecycle can be
/// tested without a webview; in the app it is always the spawn's Channel.
trait Sink: Send + 'static {
    fn output(&self, bytes: &[u8]);
    fn exit(&self, code: Option<i32>);
}

/// Delivery errors are ignored on purpose. A send fails when the page that
/// owns the channel is gone, and there is nobody left to tell; the session
/// still runs to completion, and the next page's [`pty_kill_stale`] is what
/// ends it.
impl Sink for Channel<PtyEvent> {
    fn output(&self, bytes: &[u8]) {
        let _ = self.send(PtyEvent::Output {
            data: BASE64.encode(bytes),
        });
    }

    fn exit(&self, code: Option<i32>) {
        let _ = self.send(PtyEvent::Exit { code });
    }
}

/// The user's login shell, which is what actually gets exec'd. See
/// [`shell_script`] for why we go through a shell at all.
pub(crate) fn login_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => FALLBACK_SHELL.to_string(),
    }
}

/// Quotes one argument for a POSIX shell command line.
///
/// Inside single quotes every character is literal, so the only thing needing
/// care is a single quote itself: close the string, emit a backslash-escaped
/// quote, reopen. This is the one place in Albedo where an argv becomes a
/// string, so it is also the one place where a worktree path or a task title
/// containing a space, a quote, a `$` or a backtick could break out of the
/// command line. It must not: these values come from user input.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// The command line handed to the login shell via `-c`.
///
/// Three statements, in this order, and the order matters:
///
/// 1. `cd` into the worktree. The shell already starts there, but a profile is
///    allowed to `cd`, and a Claude Code session running in the wrong repo is a
///    silent and expensive mistake.
/// 2. `unset` the Anthropic variables -- *after* the profile has been sourced.
///    See STRIPPED_ENV for why this is not redundant with `env_remove`.
/// 3. `exec` the requested command, which replaces the shell rather than
///    forking under it. That leaves no extra process between Albedo and Claude
///    Code: Claude Code is the session leader whose group `pty_kill` signals,
///    and the exit code reported is the command's own rather than a shell's.
pub(crate) fn shell_script(shell: &str, opts: &SpawnOptions) -> String {
    let names = STRIPPED_ENV.join(" ");
    // fish has no `unset`; every other shell we could plausibly land in (sh,
    // bash, zsh, ksh, dash) takes the POSIX spelling. Getting this wrong in
    // fish would fail *open* -- the command would still run, just with the key
    // still set -- which is why it is worth the special case.
    let unset = if Path::new(shell).file_name().and_then(|n| n.to_str()) == Some("fish") {
        format!("set -e {names}")
    } else {
        format!("unset {names}")
    };

    // An empty command is the login shell itself, for the main-checkout shell
    // drawer. Same cd and same unset first: a plain shell must not hand
    // ANTHROPIC_API_KEY to a `claude` the user types into it either.
    let mut exec = String::from("exec ");
    if opts.command.is_empty() {
        exec.push_str(&shell_quote(shell));
        exec.push_str(" -l");
    } else {
        exec.push_str(&shell_quote(&opts.command));
    }
    for arg in &opts.args {
        exec.push(' ');
        exec.push_str(&shell_quote(arg));
    }

    format!("cd {} || exit 1; {unset}; {exec}", shell_quote(&opts.cwd))
}

/// The login shell's argv, after the shell itself: `-l -i -c <script>`. One
/// copy for every path that runs a command through the login shell (the ptys
/// here, the one-shot run in oneshot.rs); see [`build_command`] for why `-l -i`.
pub(crate) fn login_shell_invocation(shell: &str, opts: &SpawnOptions) -> [String; 4] {
    [
        "-l".to_string(),
        "-i".to_string(),
        "-c".to_string(),
        shell_script(shell, opts),
    ]
}

/// Layer 1 of the strip (layer 2 is the `unset` in [`shell_script`]): calls
/// `remove` once per variable in [`STRIPPED_ENV`]. A callback so the same list
/// serves portable-pty's `CommandBuilder` and std's `Command`.
pub(crate) fn strip_env(mut remove: impl FnMut(&str)) {
    for key in STRIPPED_ENV {
        remove(key);
    }
}

/// Build the child's command line and environment.
///
/// The command is **not** spawned directly. portable-pty resolves a bare
/// `claude` through the PATH of *this* process, and a macOS .app launched from
/// Finder inherits a minimal PATH (roughly `/usr/bin:/bin:/usr/sbin:/sbin`)
/// that does not include `~/.local/bin`, where the Claude Code installer puts
/// it. A direct spawn therefore works under `npm run tauri dev` -- which
/// inherits the developer's shell -- and fails in the shipped bundle with a
/// bare "command not found", far from its cause.
///
/// So we run the command through the user's **login shell** instead of
/// prepending a guessed list of directories. The spec's premise is that Claude
/// Code runs here exactly as it does in a terminal tab, and the environment of
/// a terminal tab is whatever that user's profile builds: PATH, but equally
/// nvm/fnm/asdf shims, proxy variables and anything else they set. A hardcoded
/// PATH prefix would fix today's symptom on one machine and quietly diverge
/// everywhere else.
///
/// `-l -i` rather than `-l` alone, which is measurable and not a matter of
/// taste: on this machine `zsh -l -c 'command -v claude'` finds nothing, while
/// `zsh -l -i -c` finds it. zsh sources `~/.zshrc` -- where the installer
/// appends `~/.local/bin` to PATH -- only for *interactive* shells, so a
/// login-only shell misses exactly the thing we are here to fix. The
/// interactive flag produced no extra output when measured; if some profile is
/// noisy, that noise lands in the terminal pane, which is precisely what the
/// user sees when they open a terminal tab anyway.
///
/// `CommandBuilder::new` starts from the current process environment, so the
/// rest of the work here is subtractive.
fn build_command(shell: &str, opts: &SpawnOptions) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    for arg in login_shell_invocation(shell, opts) {
        cmd.arg(arg);
    }
    cmd.cwd(&opts.cwd);

    // Caller-supplied extras first, so the two policies below can override
    // them. Nothing the frontend passes may weaken either one.
    if let Some(env) = &opts.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    // We own the terminal emulator (xterm.js), so we also get to state what it
    // is. Without these Claude Code's TUI falls back to a dumb terminal and
    // renders without colour.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Layer 1 of the strip: removes what Albedo itself inherited, before the
    // shell starts. Applied after the caller's env so a stray key cannot be
    // reintroduced from the frontend either. Layer 2 lives in shell_script.
    strip_env(|key| cmd.env_remove(key));

    cmd
}

#[tauri::command]
pub async fn pty_spawn(
    webview: tauri::Webview,
    registry: tauri::State<'_, PtyRegistry>,
    opts: SpawnOptions,
    page: String,
    events: Channel<PtyEvent>,
) -> Result<String, String> {
    // Checked up front: a missing cwd otherwise surfaces as an opaque spawn
    // failure several layers down.
    if !Path::new(&opts.cwd).is_dir() {
        return Err(format!("cwd is not a directory: {}", opts.cwd));
    }

    let shell = login_shell();
    let pty_id = registry.new_id();
    launch(
        &registry.sessions,
        pty_id.clone(),
        Owner {
            webview: webview.label().to_string(),
            page,
        },
        build_command(&shell, &opts),
        pty_size(opts.cols, opts.rows),
        FLOW_LIMITS,
        // Names the shell as well as the command: if the spawn fails it is
        // almost always the shell that is missing, and "failed to spawn
        // claude" would send whoever reads it looking in the wrong place.
        &if opts.command.is_empty() {
            format!("login shell {shell}")
        } else {
            format!("{} via {shell}", opts.command)
        },
        events,
    )?;
    Ok(pty_id)
}

/// Sync on purpose. Tauri runs a sync command on the main thread in the order
/// the calls arrive, which is what keeps keystrokes in order -- async commands
/// race each other on the runtime's workers. All it does is enqueue, so the
/// main thread never waits on a child that has stopped reading; the writer
/// thread is the one that blocks.
#[tauri::command]
pub fn pty_write(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = registry.sessions.lock();
    let session = sessions
        .get(&pty_id)
        .ok_or_else(|| format!("unknown pty: {pty_id}"))?;
    session
        .input
        .send(data.into_bytes())
        .map_err(|_| format!("write to {pty_id} failed: pty is closing"))
}

#[tauri::command]
pub async fn pty_resize(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = registry.sessions.lock();
    // Deliberately not an error for an unknown id. Resize is driven by layout,
    // not by the user: a ResizeObserver or a window drag fires it while the pty
    // is still being spawned and again after the child has exited and the
    // session has been deregistered. Neither is a fault worth surfacing, and
    // making them errors means every caller has to swallow them anyway.
    let Some(session) = sessions.get(&pty_id) else {
        return Ok(());
    };
    session
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| format!("resize of {pty_id} failed: {e}"))
}

/// The page has finished writing `bytes` of this pty's output (xterm's write
/// callback), so the reader may read that much more. See [`Flow`].
///
/// Not an error for an unknown id, like [`pty_resize`]: the last acks of a
/// session routinely arrive after its exit has deregistered it.
#[tauri::command]
pub async fn pty_ack(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    bytes: u64,
) -> Result<(), String> {
    ack(&registry.sessions, &pty_id, bytes);
    Ok(())
}

fn ack(sessions: &Sessions, pty_id: &str, bytes: u64) {
    // Cloned out so the registry lock is not held while waking the reader.
    let flow = sessions.lock().get(pty_id).map(|s| Arc::clone(&s.flow));
    if let Some(flow) = flow {
        flow.ack(bytes);
    }
}

/// Signals the child's process group and returns at once. The exit is still
/// reported on the spawn's channel, by the pump, once the child is gone.
#[tauri::command]
pub async fn pty_kill(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
) -> Result<(), String> {
    let sessions = registry.sessions.lock();
    let session = sessions
        .get(&pty_id)
        .ok_or_else(|| format!("unknown pty: {pty_id}"))?;
    terminate(&pty_id, session);
    Ok(())
}

/// Kills every session of the calling webview that was spawned by a different
/// page, and resolves once their children are gone (or the kill grace is up).
///
/// The frontend calls this once at startup and holds every spawn until it
/// resolves, so a reopened task's `--resume` never runs alongside the old
/// page's copy of the same session. Selecting by page token rather than "kill
/// everything" is what makes it safe: it cannot reach a session the calling
/// page spawned, whatever order the IPC calls happen to arrive in.
#[tauri::command]
pub async fn pty_kill_stale(
    webview: tauri::Webview,
    registry: tauri::State<'_, PtyRegistry>,
    page: String,
) -> Result<(), String> {
    let stale = kill_stale(&registry.sessions, webview.label(), &page);
    if stale.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + KILL_GRACE + Duration::from_millis(500);
        for exited in stale {
            exited.wait(deadline.saturating_duration_since(Instant::now()));
        }
    })
    .await
    .map_err(|e| format!("waiting for stale ptys failed: {e}"))
}

fn kill_stale(sessions: &Sessions, webview: &str, page: &str) -> Vec<Arc<Latch>> {
    let sessions = sessions.lock();
    sessions
        .iter()
        .filter(|(_, s)| s.owner.webview == webview && s.owner.page != page)
        .map(|(id, s)| {
            terminate(id, s);
            Arc::clone(&s.exited)
        })
        .collect()
}

/// SIGHUP to the whole process group now, SIGKILL to it after [`KILL_GRACE`].
///
/// The group, not the pid: signalling Claude Code alone left anything it had
/// backgrounded running, still holding the slave, and the session never ended.
/// The SIGKILL goes out even if the leader died promptly, so that a
/// grandchild ignoring SIGHUP does not outlive the kill either. Signalling a
/// group that has since emptied is a harmless ESRCH; a pgid cannot be reused
/// while any member is alive, and pids are not recycled within two seconds.
fn terminate(pty_id: &str, session: &PtySession) {
    let pgid = session.pgid;
    // Before the signal: a paused reader would hold the exit. See [`Flow`].
    session.flow.release();
    signal_group(pgid, libc::SIGHUP);
    spawn_named(format!("pty-kill-{pty_id}"), move || {
        std::thread::sleep(KILL_GRACE);
        signal_group(pgid, libc::SIGKILL);
    });
}

fn signal_group(pgid: libc::pid_t, sig: libc::c_int) {
    // A pgid <= 1 would address our own group or every process we may signal.
    // A spawned child can never have one, but this is the line to be sure on.
    if pgid > 1 {
        // SAFETY: plain syscall; ESRCH (group already gone) is the expected
        // failure and needs no handling.
        unsafe { libc::killpg(pgid, sig) };
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        // A zero-sized pty makes curses applications misbehave in ways that are
        // painful to debug, and xterm.js reports 0 while its container is
        // hidden. Clamp to something sane instead.
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Opens a pty, spawns `cmd` on it, registers the session under `pty_id` and
/// starts its four threads. Returns the child's pid (= its process group).
///
/// `what` names the command in the spawn error. `limits` is always
/// [`FLOW_LIMITS`] in the app; tests shrink it.
#[allow(clippy::too_many_arguments)]
fn launch(
    sessions: &Sessions,
    pty_id: String,
    owner: Owner,
    cmd: CommandBuilder,
    size: PtySize,
    limits: FlowLimits,
    what: &str,
    sink: impl Sink,
) -> Result<libc::pid_t, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {what}: {e}"))?;

    // The slave fd must go now. While we hold it open the kernel considers the
    // pty to still have a writer, so the reader would never see EOF.
    drop(pair.slave);

    // From here on a failure must not leave the child running unowned.
    let fail = |child: &mut Box<dyn portable_pty::Child + Send + Sync>, msg: String| {
        let _ = child.kill();
        let _ = child.wait();
        Err(msg)
    };

    let Some(pgid) = child.process_id().map(|p| p as libc::pid_t) else {
        return fail(&mut child, "spawned child has no pid".into());
    };
    let reader = match pair.master.as_raw_fd().map(PtyReader::new) {
        Some(Ok(r)) => r,
        Some(Err(e)) => return fail(&mut child, format!("could not read from pty: {e}")),
        None => return fail(&mut child, "could not read from pty: no fd".into()),
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return fail(&mut child, format!("could not write to pty: {e}")),
    };

    let exited = Arc::new(Latch::default());
    let flow = Arc::new(Flow::new(limits));
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    sessions.lock().insert(
        pty_id.clone(),
        PtySession {
            master: pair.master,
            input: input_tx,
            pgid,
            exited: Arc::clone(&exited),
            flow: Arc::clone(&flow),
            owner,
        },
    );

    let PtyReader { reader, wake } = reader;
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    // Never sent on: the reader dropping it is the "I am done" signal.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let read_flow = Arc::clone(&flow);
    spawn_named(format!("pty-read-{pty_id}"), move || {
        read_loop(reader, &out_tx, &read_flow);
        drop(done_tx);
    });

    spawn_named(format!("pty-write-{pty_id}"), move || {
        write_loop(writer, &input_rx)
    });

    let (code_tx, code_rx) = mpsc::channel::<Option<i32>>();
    spawn_named(format!("pty-wait-{pty_id}"), move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        exited.set();
        // Before the grace starts: a reader paused on the page does not watch
        // the stop pipe, so the grace could not end it. See [`Flow`].
        flow.release();
        let _ = code_tx.send(code);
        // Whatever the child wrote before exiting is still in the kernel
        // buffer; the grace lets the reader deliver it. After that, whoever
        // still holds the slave is not our child, and its output is not this
        // session's. Dropping the write end of the pipe is the wake-up.
        if let Err(RecvTimeoutError::Timeout) = done_rx.recv_timeout(READER_GRACE) {
            drop(wake);
        }
    });

    let sessions = Arc::clone(sessions);
    let pump_id = pty_id.clone();
    spawn_named(format!("pty-pump-{pty_id}"), move || {
        pump_loop(&sink, &out_rx);
        // Output is fully drained at this point, so it is safe to announce the
        // exit. The waiter has already reaped the child, or is about to.
        let code = code_rx.recv().ok().flatten();
        sessions.lock().remove(&pump_id);
        sink.exit(code);
    });

    Ok(pgid)
}

/// The reader's half of the master: its own dup of the master fd, plus the
/// read end of a pipe whose write end ([`PtyReader::wake`]) stops it.
///
/// A blocking `read` on the master cannot be interrupted from another thread
/// -- closing a fd under a blocked read does not reliably wake it -- so the
/// reader polls both fds and leaves when the pipe's write end is closed.
struct PtyReader {
    reader: ReadHalf,
    wake: File,
}

struct ReadHalf {
    pty: File,
    stop: File,
}

impl PtyReader {
    fn new(master_fd: RawFd) -> io::Result<Self> {
        // CLOEXEC on all three, so no other process this app spawns (git, a
        // later pty's shell) inherits a master fd and keeps a pty alive.
        // SAFETY: F_DUPFD_CLOEXEC returns a fresh fd that we then own.
        let pty = unsafe { libc::fcntl(master_fd, libc::F_DUPFD_CLOEXEC, 0) };
        if pty < 0 {
            return Err(io::Error::last_os_error());
        }
        let pty = unsafe { File::from_raw_fd(pty) };

        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: `fds` has room for the two fds pipe(2) writes.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: pipe(2) succeeded, so both are fresh fds that we now own.
        let (stop, wake) = unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) };
        for f in [&stop, &wake] {
            unsafe { libc::fcntl(f.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
        }

        Ok(PtyReader {
            reader: ReadHalf { pty, stop },
            wake,
        })
    }
}

/// Reads the pty master until EOF or until told to stop, handing raw chunks to
/// the pump thread. Pauses before each read while `flow` says the page is too
/// far behind.
fn read_loop(mut half: ReadHalf, tx: &Sender<Vec<u8>>, flow: &Flow) {
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        // Before the poll, so a paused reader leaves the bytes in the kernel
        // and the child blocks on its write. Never waits once the child has
        // exited, which is the only time the stop pipe below is closed.
        flow.wait_for_room();
        let mut fds = [
            libc::pollfd {
                fd: half.pty.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: half.stop.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: `fds` is a valid array of two pollfds.
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        // Stop wins over pending data: a grandchild that never stops writing
        // must not be able to keep the reader alive.
        if fds[1].revents != 0 {
            return;
        }
        if fds[0].revents == 0 {
            continue;
        }
        match half.pty.read(&mut buf) {
            // EOF on Linux/macOS once the child and the slave fd are gone.
            Ok(0) => return,
            Ok(n) => {
                flow.read(n);
                if tx.send(buf[..n].to_vec()).is_err() {
                    return; // pump thread gone; nobody left to deliver to
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // Includes EIO, which is how a closed slave end reports itself on
            // some platforms. Treat every other error as end of stream: the
            // child is about to be reaped and reported as an exit.
            Err(_) => return,
        }
    }
}

/// Drains the input queue into the master. Ends when the session is dropped
/// (the queue's sender goes with it) or a write fails because the child is
/// gone -- either way the exit is reported elsewhere.
fn write_loop(mut writer: Box<dyn Write + Send>, rx: &Receiver<Vec<u8>>) {
    while let Ok(bytes) = rx.recv() {
        if writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

/// Coalesces chunks from the reader and sends them as output.
///
/// Returns once the reader thread has dropped its sender and the buffer has
/// been drained.
fn pump_loop(sink: &impl Sink, rx: &Receiver<Vec<u8>>) {
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES + READ_BUF_BYTES);
    // When the current buffer must go out at the latest. Only meaningful while
    // `buf` is non-empty.
    let mut deadline = Instant::now();

    loop {
        if buf.is_empty() {
            // Nothing pending, so block indefinitely -- an idle pty should cost
            // nothing.
            match rx.recv() {
                Ok(chunk) => {
                    buf.extend_from_slice(&chunk);
                    deadline = Instant::now() + FLUSH_INTERVAL;
                }
                Err(_) => return, // reader finished
            }
            continue;
        }

        let now = Instant::now();
        if buf.len() >= FLUSH_BYTES || now >= deadline {
            sink.output(&buf);
            buf.clear();
            continue;
        }

        match rx.recv_timeout(deadline - now) {
            Ok(chunk) => buf.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout) => {
                sink.output(&buf);
                buf.clear();
            }
            Err(RecvTimeoutError::Disconnected) => {
                // Flush the tail before reporting the exit.
                sink.output(&buf);
                return;
            }
        }
    }
}

/// Named threads so a stuck pty is identifiable in a debugger or a crash dump.
fn spawn_named<F: FnOnce() + Send + 'static>(name: String, f: F) {
    if let Err(e) = std::thread::Builder::new().name(name.clone()).spawn(f) {
        // Nothing sensible to do but say so: without the reader the pty is
        // inert, and the caller will notice no output arriving.
        eprintln!("albedo: failed to start thread {name}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(command: &str, args: &[&str], cwd: &str) -> SpawnOptions {
        SpawnOptions {
            cwd: cwd.to_string(),
            command: command.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cols: 80,
            rows: 24,
            env: None,
        }
    }

    #[test]
    fn quotes_plain_values() {
        assert_eq!(shell_quote("claude"), "'claude'");
        assert_eq!(
            shell_quote("/Users/me/agents/repo/slug"),
            "'/Users/me/agents/repo/slug'"
        );
    }

    /// Asks a real `/bin/sh` what one quoted argument expands to.
    ///
    /// Checking the quoted *string* against a hand-written expectation only
    /// tests that the code does what it already does. Handing it to an actual
    /// shell tests the property that matters: the argument the command receives
    /// is byte-for-byte the one Albedo passed in.
    fn expand_through_sh(quoted: &str) -> String {
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf %s {quoted}"))
            .output()
            .expect("run /bin/sh");
        String::from_utf8(out.stdout).expect("utf-8 output")
    }

    #[test]
    fn quoting_survives_a_real_shell_unchanged() {
        // A worktree path or a task title is user input. None of this may be
        // expanded, split, or -- for the last few -- executed.
        for raw in [
            "claude",
            "a b",
            "it's",
            "$HOME",
            "${HOME}",
            "`whoami`",
            "$(id -u)",
            "a\"b",
            "back\\slash",
            "tab\there",
            "x; echo pwned",
            "x && echo pwned",
            "x | echo pwned",
            "*",
            "~",
            "--flag=a b's \"c\"",
        ] {
            assert_eq!(expand_through_sh(&shell_quote(raw)), raw, "raw: {raw}");
        }
    }

    #[test]
    fn an_injected_command_is_not_run() {
        // The classic shape: a value that tries to close the quote and append a
        // second command. It must come back as literal text.
        let raw = "'; echo pwned; :'";
        assert_eq!(expand_through_sh(&shell_quote(raw)), raw);
    }

    #[test]
    fn embedded_single_quote_closes_and_reopens() {
        assert_eq!(shell_quote("it's"), r#"'it'\''s'"#);
    }

    #[test]
    fn script_cds_unsets_then_execs_in_that_order() {
        let script = shell_script("/bin/zsh", &opts("claude", &["--foo"], "/tmp/wt"));
        assert_eq!(
            script,
            "cd '/tmp/wt' || exit 1; \
             unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL; \
             exec 'claude' '--foo'"
        );

        let cd = script.find("cd ").expect("cd");
        let unset = script.find("unset ").expect("unset");
        let exec = script.find("exec ").expect("exec");
        // The unset must land after the profile has been sourced and before the
        // command runs. Reordering these reintroduces the billing bug.
        assert!(cd < unset && unset < exec);
    }

    #[test]
    fn an_empty_command_execs_the_login_shell_after_the_unset() {
        let script = shell_script("/bin/zsh", &opts("", &[], "/tmp/repo"));
        assert_eq!(
            script,
            "cd '/tmp/repo' || exit 1; \
             unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL; \
             exec '/bin/zsh' -l"
        );
    }

    #[test]
    fn script_uses_fish_syntax_for_fish() {
        let script = shell_script("/opt/homebrew/bin/fish", &opts("claude", &[], "/tmp/wt"));
        assert!(script.contains("set -e ANTHROPIC_API_KEY"), "{script}");
        assert!(!script.contains("unset "), "{script}");
    }

    #[test]
    fn script_quotes_every_part() {
        let script = shell_script("/bin/zsh", &opts("my cmd", &["a b", "it's"], "/tmp/a dir"));
        assert!(script.contains("cd '/tmp/a dir'"), "{script}");
        assert!(
            script.ends_with(r#"exec 'my cmd' 'a b' 'it'\''s'"#),
            "{script}"
        );
    }

    #[test]
    fn pty_size_never_reaches_the_kernel_as_zero() {
        let size = pty_size(0, 0);
        assert_eq!((size.cols, size.rows), (1, 1));
        let size = pty_size(120, 40);
        assert_eq!((size.cols, size.rows), (120, 40));
    }

    // --- lifecycle, on a real pty -------------------------------------------

    enum Ev {
        Out(Vec<u8>),
        Exit(Option<i32>),
    }

    struct TestSink(Sender<Ev>);

    impl Sink for TestSink {
        fn output(&self, bytes: &[u8]) {
            let _ = self.0.send(Ev::Out(bytes.to_vec()));
        }
        fn exit(&self, code: Option<i32>) {
            let _ = self.0.send(Ev::Exit(code));
        }
    }

    fn launch_sh(
        sessions: &Sessions,
        id: &str,
        page: &str,
        script: &str,
    ) -> (libc::pid_t, Receiver<Ev>) {
        launch_sh_with(sessions, id, page, script, FLOW_LIMITS)
    }

    fn launch_sh_with(
        sessions: &Sessions,
        id: &str,
        page: &str,
        script: &str,
        limits: FlowLimits,
    ) -> (libc::pid_t, Receiver<Ev>) {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(script);
        let (tx, rx) = mpsc::channel();
        let owner = Owner {
            webview: "main".into(),
            page: page.into(),
        };
        let pgid = launch(
            sessions,
            id.into(),
            owner,
            cmd,
            pty_size(80, 24),
            limits,
            "sh",
            TestSink(tx),
        )
        .expect("launch");
        (pgid, rx)
    }

    /// Output until (and including) the exit, or a panic after `within`.
    /// Reading the bytes is fine here: this is a test of the bridge, not the
    /// app looking at what Claude Code renders.
    fn until_exit(rx: &Receiver<Ev>, within: Duration) -> (String, Option<i32>) {
        let deadline = Instant::now() + within;
        let mut out = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(Ev::Out(b)) => out.extend(b),
                Ok(Ev::Exit(code)) => return (String::from_utf8_lossy(&out).into_owned(), code),
                Err(_) => panic!(
                    "no exit within {within:?}; output so far: {:?}",
                    String::from_utf8_lossy(&out)
                ),
            }
        }
    }

    fn until_output(rx: &Receiver<Ev>, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::new();
        while !String::from_utf8_lossy(&out).contains(needle) {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Ev::Out(b)) => out.extend(b),
                Ok(Ev::Exit(_)) | Err(_) => panic!("never saw {needle:?}"),
            }
        }
    }

    fn group_is_gone(pgid: libc::pid_t) -> bool {
        // Signal 0 checks existence only. Killed members are reparented and
        // reaped asynchronously, so allow a moment.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if unsafe { libc::killpg(pgid, 0) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn input_reaches_the_child_and_the_exit_follows_all_output() {
        let sessions = Sessions::default();
        let (_, rx) = launch_sh(&sessions, "a", "p", "read line; echo \"got:$line\"; exit 3");
        sessions.lock()["a"].input.send(b"abc\n".to_vec()).unwrap();

        let (out, code) = until_exit(&rx, Duration::from_secs(5));
        assert!(out.contains("got:abc"), "{out:?}");
        assert_eq!(code, Some(3));
        assert!(
            sessions.lock().is_empty(),
            "deregistered before the exit is reported"
        );
    }

    #[test]
    fn a_grandchild_holding_the_pty_does_not_hide_the_exit() {
        // The `npm run dev &` case: the backgrounded process inherits the
        // slave, so the master never reaches EOF while it lives.
        let sessions = Sessions::default();
        let started = Instant::now();
        let (pgid, rx) = launch_sh(&sessions, "a", "p", "sleep 30 & echo up; exit 4");

        let (out, code) = until_exit(&rx, Duration::from_secs(3));
        assert!(out.contains("up"), "{out:?}");
        assert_eq!(code, Some(4));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert!(sessions.lock().is_empty());

        signal_group(pgid, libc::SIGKILL);
    }

    #[test]
    fn kill_takes_down_the_whole_group_even_when_sighup_is_ignored() {
        let sessions = Sessions::default();
        let (pgid, rx) = launch_sh(&sessions, "a", "p", "trap '' HUP; sleep 30 & echo up; wait");
        until_output(&rx, "up");

        terminate("a", &sessions.lock()["a"]);
        let (_, code) = until_exit(&rx, KILL_GRACE + Duration::from_secs(3));
        assert!(code.is_some_and(|c| c != 0), "{code:?}");
        assert!(
            group_is_gone(pgid),
            "something in group {pgid} survived the kill"
        );
    }

    #[test]
    fn shutdown_ends_every_group_including_what_ignores_sighup() {
        let sessions = Sessions::default();
        let (polite, polite_rx) = launch_sh(&sessions, "a", "p", "sleep 30 & echo up; wait");
        let (stubborn, stubborn_rx) =
            launch_sh(&sessions, "b", "p", "trap '' HUP; sleep 30 & echo up; wait");
        until_output(&polite_rx, "up");
        until_output(&stubborn_rx, "up");

        let started = Instant::now();
        shutdown(&sessions, Duration::from_millis(300));
        let took = started.elapsed();
        // Never longer than the grace (plus scheduling), unlike terminate's 2 s.
        assert!(took < Duration::from_millis(1000), "{took:?}");

        assert!(group_is_gone(polite), "group {polite} survived the quit");
        assert!(
            group_is_gone(stubborn),
            "group {stubborn} survived the quit"
        );
        let (_, code) = until_exit(&stubborn_rx, Duration::from_secs(3));
        assert!(code.is_some_and(|c| c != 0), "{code:?}");
    }

    #[test]
    fn shutdown_returns_at_once_when_every_group_leaves_on_sighup() {
        let sessions = Sessions::default();
        let (pgid, rx) = launch_sh(&sessions, "a", "p", "echo up; exec sleep 30");
        until_output(&rx, "up");

        let started = Instant::now();
        shutdown(&sessions, Duration::from_secs(5));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "waited the whole grace: {:?}",
            started.elapsed()
        );
        assert!(group_is_gone(pgid));
    }

    #[test]
    fn shutdown_with_no_sessions_does_nothing() {
        let started = Instant::now();
        shutdown(&Sessions::default(), Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    // The next three pin what portable-pty does for us on spawn and resize,
    // so a version bump that changes it fails here (#206: 0.8 -> 0.9).

    #[test]
    fn a_resize_reaches_the_child() {
        let sessions = Sessions::default();
        let (pgid, rx) = launch_sh(&sessions, "a", "p", "echo up; read x; stty size");
        until_output(&rx, "up");
        {
            let sessions = sessions.lock();
            let session = &sessions["a"];
            session.master.resize(pty_size(101, 33)).expect("resize");
            session.input.send(b"\n".to_vec()).unwrap();
        }
        let (out, code) = until_exit(&rx, Duration::from_secs(5));
        assert!(out.contains("33 101"), "{out:?}");
        assert_eq!(code, Some(0));
        signal_group(pgid, libc::SIGKILL);
    }

    #[test]
    fn the_child_leads_its_own_group_on_the_pty() {
        // `pty_kill` signals the group whose id is the child's pid, so the child
        // must be a session (and group) leader with the pty as its terminal.
        let sessions = Sessions::default();
        let (pgid, rx) = launch_sh(
            &sessions,
            "a",
            "p",
            "echo \"pgid:$(ps -o pgid= -p $$ | tr -d ' ')\"; test -t 0 && echo tty:yes",
        );
        let (out, code) = until_exit(&rx, Duration::from_secs(5));
        assert!(out.contains(&format!("pgid:{pgid}")), "{pgid} {out:?}");
        assert!(out.contains("tty:yes"), "{out:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn the_api_key_never_reaches_the_child() {
        let mut o = opts(
            "/bin/sh",
            &["-c", "echo \"key:${ANTHROPIC_API_KEY-none}\""],
            "/tmp",
        );
        o.env = Some(HashMap::from([(
            "ANTHROPIC_API_KEY".to_string(),
            "sk-from-the-caller".to_string(),
        )]));
        let cmd = build_command("/bin/sh", &o);
        // Layer 1 alone: the builder no longer carries it.
        assert!(cmd.get_env("ANTHROPIC_API_KEY").is_none());

        let sessions = Sessions::default();
        let (tx, rx) = mpsc::channel();
        let owner = Owner {
            webview: "main".into(),
            page: "p".into(),
        };
        launch(
            &sessions,
            "a".into(),
            owner,
            cmd,
            pty_size(80, 24),
            FLOW_LIMITS,
            "sh",
            TestSink(tx),
        )
        .expect("launch");
        let (out, code) = until_exit(&rx, Duration::from_secs(10));
        assert!(out.contains("key:none"), "{out:?}");
        assert!(!out.contains("sk-from-the-caller"), "{out:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn the_stale_sweep_spares_the_calling_page() {
        let sessions = Sessions::default();
        let (_, old_rx) = launch_sh(&sessions, "old", "page-1", "echo up; exec sleep 30");
        let (new_pgid, new_rx) = launch_sh(&sessions, "new", "page-2", "echo up; exec sleep 30");
        until_output(&old_rx, "up");
        until_output(&new_rx, "up");

        let stale = kill_stale(&sessions, "main", "page-2");
        assert_eq!(stale.len(), 1);
        assert!(stale[0].wait(KILL_GRACE), "stale session did not exit");
        until_exit(&old_rx, Duration::from_secs(3));

        // Another webview's sessions are not this page's to sweep either.
        assert!(kill_stale(&sessions, "other", "page-3").is_empty());
        assert!(sessions.lock().contains_key("new"));
        assert!(
            new_rx.try_recv().is_err(),
            "the calling page's session was touched"
        );

        signal_group(new_pgid, libc::SIGKILL);
        until_exit(&new_rx, Duration::from_secs(3));
    }

    // --- output pacing (#366) ------------------------------------------------

    const NO_STALL: Duration = Duration::from_secs(600);

    fn limits(high_water: u64, stall: Duration) -> FlowLimits {
        FlowLimits { high_water, stall }
    }

    /// Runs `wait_for_room` on a thread; true if it returned within `within`.
    fn waits_return(flow: &Arc<Flow>, within: Duration) -> (bool, std::thread::JoinHandle<()>) {
        let (tx, rx) = mpsc::channel();
        let f = Arc::clone(flow);
        let handle = std::thread::spawn(move || {
            f.wait_for_room();
            let _ = tx.send(());
        });
        (rx.recv_timeout(within).is_ok(), handle)
    }

    #[test]
    fn the_reader_waits_only_at_the_mark_and_an_ack_lets_it_go() {
        let flow = Arc::new(Flow::new(limits(100, NO_STALL)));
        flow.read(99);
        assert!(
            waits_return(&flow, Duration::from_millis(500)).0,
            "below the mark"
        );

        flow.read(1);
        let (returned, handle) = waits_return(&flow, Duration::from_millis(200));
        assert!(!returned, "did not pause at the mark");
        flow.ack(1);
        handle.join().unwrap();
        assert_eq!(flow.unacked(), 99);

        // Saturating: an ack can never wrap the count.
        flow.ack(1_000);
        assert_eq!(flow.unacked(), 0);
    }

    #[test]
    fn a_page_that_stops_acking_holds_the_reader_for_one_stall_only() {
        let flow = Arc::new(Flow::new(limits(10, Duration::from_millis(150))));
        flow.read(50);
        let started = Instant::now();
        flow.wait_for_room();
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(140), "{took:?}");

        // Stalled: no more waiting, however much is read, until an ack.
        flow.read(1_000_000);
        let started = Instant::now();
        flow.wait_for_room();
        assert!(started.elapsed() < Duration::from_millis(50));

        // An ack proves the page is back, and pacing resumes.
        flow.ack(1);
        let (returned, handle) = waits_return(&flow, Duration::from_millis(50));
        assert!(!returned, "an ack did not re-arm the pause");
        handle.join().unwrap(); // ends on the next stall
    }

    #[test]
    fn a_slow_page_that_keeps_acking_keeps_the_reader_paced() {
        // Each ack restarts the stall clock, so acks spaced under the stall
        // never let the reader run unpaced.
        let flow = Arc::new(Flow::new(limits(10, Duration::from_millis(200))));
        flow.read(1_000);
        let (returned, handle) = waits_return(&flow, Duration::from_millis(10));
        assert!(!returned);
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(120));
            flow.ack(1);
        }
        assert!(!flow.state.lock().stalled, "stalled despite acks");
        handle.join().unwrap();
    }

    #[test]
    fn the_childs_exit_releases_the_reader_for_good() {
        let flow = Arc::new(Flow::new(limits(10, NO_STALL)));
        flow.read(10);
        let (returned, handle) = waits_return(&flow, Duration::from_millis(100));
        assert!(!returned);
        flow.release();
        handle.join().unwrap();
        flow.read(1_000_000);
        assert!(waits_return(&flow, Duration::from_millis(500)).0);
    }

    #[test]
    fn an_ack_for_a_gone_session_is_ignored() {
        ack(&Sessions::default(), "nope", 123);
    }

    /// Checks `seq 1 N` output, one number per line, and counts the lines.
    /// Panics on the first line out of place, so lost, repeated or reordered
    /// bytes fail. The flood scripts turn off the terminal's `\n` -> `\r\n`
    /// translation (`stty -onlcr`): under output pressure macOS's tty
    /// occasionally emits a second `\r`, which is the kernel's doing, not
    /// the bridge's.
    struct SeqCheck {
        next: u64,
        line: Vec<u8>,
        bytes: u64,
    }

    impl SeqCheck {
        fn new() -> Self {
            SeqCheck {
                next: 1,
                line: Vec::new(),
                bytes: 0,
            }
        }

        fn feed(&mut self, chunk: &[u8]) {
            for &b in chunk {
                self.bytes += 1;
                if b != b'\n' {
                    self.line.push(b);
                    continue;
                }
                let got = std::str::from_utf8(&self.line)
                    .ok()
                    .and_then(|l| l.parse::<u64>().ok());
                assert_eq!(got, Some(self.next), "out of order at byte {}", self.bytes);
                self.next += 1;
                self.line.clear();
            }
        }

        fn lines(&self) -> u64 {
            assert!(self.line.is_empty(), "ends mid-line");
            self.next - 1
        }
    }

    fn seq_script(n: u64) -> String {
        // BSD seq prints 1000000 as 1e+06 unless told otherwise.
        format!("stty -onlcr; seq -f %.0f 1 {n}")
    }

    /// Drains `rx` as the page would: checks each output chunk and acks it,
    /// but stops for 500 ms after every 8 MB, as a webview's main thread does
    /// when something else holds it. Returns the lines seen, the exit code and
    /// the highest unacknowledged count seen.
    fn slow_page(
        sessions: &Sessions,
        id: &str,
        rx: &Receiver<Ev>,
        within: Duration,
    ) -> (u64, Option<i32>, u64) {
        let deadline = Instant::now() + within;
        let mut check = SeqCheck::new();
        let mut peak = 0;
        let mut since_jank = 0;
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Ev::Out(b)) => {
                    if let Some(s) = sessions.lock().get(id) {
                        peak = peak.max(s.flow.unacked());
                    }
                    check.feed(&b);
                    since_jank += b.len();
                    if since_jank >= 8 * 1024 * 1024 {
                        since_jank = 0;
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    ack(sessions, id, b.len() as u64);
                }
                Ok(Ev::Exit(code)) => return (check.lines(), code, peak),
                Err(_) => panic!("no exit within {within:?}; {} bytes so far", check.bytes),
            }
        }
    }

    /// `seq 1 6500000` is 51 MB.
    const FLOOD: u64 = 6_500_000;

    #[test]
    fn a_flood_arrives_whole_and_in_order_with_bounded_buffering() {
        let sessions = Sessions::default();
        let (_, rx) = launch_sh(&sessions, "a", "p", &seq_script(FLOOD));
        let (lines, code, peak) = slow_page(&sessions, "a", &rx, Duration::from_secs(60));
        assert_eq!(lines, FLOOD, "lost or extra output");
        assert_eq!(code, Some(0));
        // Everything read and not yet acknowledged: the reader's channel, the
        // pump's buffer and what the page holds. One read may land past the
        // mark before the reader checks again.
        assert!(
            peak <= HIGH_WATER + READ_BUF_BYTES as u64,
            "{peak} bytes outstanding"
        );
        // And the pause was reached, or the bound above proves nothing.
        assert!(peak >= HIGH_WATER / 2, "never paced: peak {peak}");
        eprintln!("paced flood: peak unacknowledged {peak} bytes");
    }

    /// Not a check: prints the numbers for the PR. `cargo test -- --ignored
    /// --nocapture flood_buffering`.
    #[test]
    #[ignore]
    fn flood_buffering_with_and_without_pacing() {
        for (name, lim) in [
            ("unpaced", limits(u64::MAX, NO_STALL)),
            ("paced", FLOW_LIMITS),
        ] {
            let sessions = Sessions::default();
            let started = Instant::now();
            let (_, rx) = launch_sh_with(&sessions, "a", "p", &seq_script(FLOOD), lim);
            let (lines, _, peak) = slow_page(&sessions, "a", &rx, Duration::from_secs(120));
            eprintln!(
                "{name}: {lines} lines, peak unacknowledged {peak} bytes, {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn a_page_that_never_acks_pauses_the_child_and_ends_it_on_kill() {
        // No stall, so nothing but the kill can free the reader: proves the
        // pause holds, and that terminate does not depend on the page.
        let sessions = Sessions::default();
        let (pgid, rx) = launch_sh_with(
            &sessions,
            "a",
            "p",
            "trap '' HUP; yes",
            limits(64 * 1024, NO_STALL),
        );
        let flow = Arc::clone(&sessions.lock()["a"].flow);
        let deadline = Instant::now() + Duration::from_secs(5);
        while flow.unacked() < 64 * 1024 {
            assert!(Instant::now() < deadline, "never reached the mark");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(200));
        let paused = flow.unacked();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(flow.unacked(), paused, "kept reading past the mark");
        assert!(paused <= 64 * 1024 + READ_BUF_BYTES as u64, "{paused}");

        terminate("a", &sessions.lock()["a"]);
        let (_, code) = until_exit(&rx, KILL_GRACE + Duration::from_secs(3));
        assert!(code.is_some_and(|c| c != 0), "{code:?}");
        assert!(group_is_gone(pgid), "group {pgid} survived the kill");
        assert!(sessions.lock().is_empty());
    }

    #[test]
    fn quitting_ends_a_session_paused_on_a_page_that_never_acks() {
        let sessions = Sessions::default();
        let (pgid, rx) = launch_sh_with(&sessions, "a", "p", "yes", limits(64 * 1024, NO_STALL));
        let flow = Arc::clone(&sessions.lock()["a"].flow);
        let deadline = Instant::now() + Duration::from_secs(5);
        while flow.unacked() < 64 * 1024 {
            assert!(Instant::now() < deadline, "never reached the mark");
            std::thread::sleep(Duration::from_millis(10));
        }

        let started = Instant::now();
        shutdown(&sessions, Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_millis(1000));
        assert!(group_is_gone(pgid));
        until_exit(&rx, Duration::from_secs(3));
    }

    #[test]
    fn lost_acks_cost_one_stall_never_the_output_or_the_exit() {
        // The page never acks (reloaded, suspended, IPC failing): with the
        // app's own limits the flood still completes, whole, and exits.
        let sessions = Sessions::default();
        let n = 700_000; // 4.7 MB
        let started = Instant::now();
        let (_, rx) = launch_sh(&sessions, "a", "p", &seq_script(n));
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut check = SeqCheck::new();
        let code = loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Ev::Out(b)) => check.feed(&b),
                Ok(Ev::Exit(code)) => break code,
                Err(_) => panic!("hung with {} bytes delivered", check.bytes),
            }
        };
        assert_eq!(check.lines(), n);
        assert_eq!(code, Some(0));
        assert!(started.elapsed() >= ACK_STALL, "never paused");
    }

    #[test]
    fn a_reader_paused_when_the_child_exits_still_ends_with_the_grace() {
        // The reader pauses after "first" with no stall to rescue it; the
        // child exits while a grandchild holds the terminal, so there is no
        // EOF and only the grace can end the reader. Paused, it never sees
        // the stop pipe: the waiter's release is what lets the exit through.
        let sessions = Sessions::default();
        let started = Instant::now();
        let (pgid, rx) = launch_sh_with(
            &sessions,
            "a",
            "p",
            "sleep 30 & printf first; sleep 0.2; exit 7",
            limits(1, NO_STALL),
        );
        let (out, code) = until_exit(&rx, Duration::from_secs(5));
        assert_eq!(out, "first");
        assert_eq!(code, Some(7));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        signal_group(pgid, libc::SIGKILL);
    }
}
