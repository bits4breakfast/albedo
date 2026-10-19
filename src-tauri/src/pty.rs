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
//!   reader   poll(master, wake pipe), read  --->  Vec<u8> chunks
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
fn login_shell() -> String {
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
fn shell_script(shell: &str, opts: &SpawnOptions) -> String {
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

    let mut exec = String::from("exec ");
    exec.push_str(&shell_quote(&opts.command));
    for arg in &opts.args {
        exec.push(' ');
        exec.push_str(&shell_quote(arg));
    }

    format!("cd {} || exit 1; {unset}; {exec}", shell_quote(&opts.cwd))
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
    cmd.arg("-l");
    cmd.arg("-i");
    cmd.arg("-c");
    cmd.arg(shell_script(shell, opts));
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
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }

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
        // Names the shell as well as the command: if the spawn fails it is
        // almost always the shell that is missing, and "failed to spawn
        // claude" would send whoever reads it looking in the wrong place.
        &format!("{} via {shell}", opts.command),
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
/// `what` names the command in the spawn error.
fn launch(
    sessions: &Sessions,
    pty_id: String,
    owner: Owner,
    cmd: CommandBuilder,
    size: PtySize,
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
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    sessions.lock().insert(
        pty_id.clone(),
        PtySession {
            master: pair.master,
            input: input_tx,
            pgid,
            exited: Arc::clone(&exited),
            owner,
        },
    );

    let PtyReader { reader, wake } = reader;
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    // Never sent on: the reader dropping it is the "I am done" signal.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    spawn_named(format!("pty-read-{pty_id}"), move || {
        read_loop(reader, &out_tx);
        drop(done_tx);
    });

    spawn_named(format!("pty-write-{pty_id}"), move || {
        write_loop(writer, &input_rx)
    });

    let (code_tx, code_rx) = mpsc::channel::<Option<i32>>();
    spawn_named(format!("pty-wait-{pty_id}"), move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        exited.set();
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
/// the pump thread.
fn read_loop(mut half: ReadHalf, tx: &Sender<Vec<u8>>) {
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
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
}
