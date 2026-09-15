//! The pty bridge: the one piece of Rust in Albedo.
//!
//! Responsibility is deliberately narrow. This module runs a child process on a
//! real pty and shuttles **opaque bytes** between it and the webview. It never
//! looks at what those bytes mean -- all structured data comes from the
//! transcript JSONL, never from here (see CLAUDE.md, "Two channels").
//!
//! Threading model, per pty (two threads, so that coalescing can have a
//! deadline while a read is blocked):
//!
//! ```text
//!   reader thread            channel            pump thread
//!   ------------             -------            -----------
//!   read(2) on master  --->  Vec<u8> chunks ---> coalesce ~4KB / ~8ms
//!   loop until EOF                               emit pty://output (base64)
//!   drop(tx)                                     on disconnect: child.wait()
//!                                                emit pty://exit, deregister
//! ```
//!
//! The pump thread is the one that finishes last, which is why it -- and not
//! the reader -- owns the child handle and emits `pty://exit`. That ordering
//! guarantees every byte the child produced is delivered before the frontend is
//! told the child is gone.
//!
//! Both threads are detached rather than joined: `pty_kill` signals the child
//! and returns immediately, and the threads wind themselves down when the pty
//! reaches EOF. Nothing in the registry is needed to shut them down, so there
//! is no handle to leak and no way for a kill to block the UI thread.
//!
//! The requested command is not spawned directly -- it runs through the user's
//! login shell, so that it sees the same environment it would in a terminal
//! tab. See [`build_command`], which is where the reasoning and the measurement
//! behind that live.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Size of a single `read(2)` from the pty master.
const READ_BUF_BYTES: usize = 8 * 1024;

/// Coalescing thresholds. A busy TUI render (Claude Code repainting a spinner,
/// say) produces hundreds of tiny writes per second; forwarding each one as its
/// own Tauri event floods the webview's event queue and makes xterm.js janky.
/// So the pump thread accumulates bytes and emits when *either* limit is hit:
/// enough bytes to be worth a round trip, or enough time that a human would
/// notice the latency. 8ms is comfortably under one 60Hz frame, so coalescing
/// is invisible while still collapsing a render storm into a handful of events.
const FLUSH_BYTES: usize = 4 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

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

/// Payload of the `pty://output` event. Mirrors `PtyOutputEvent` in src/types.ts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    pty_id: String,
    /// Raw pty bytes, base64 encoded.
    ///
    /// Base64 is not decoration: a pty hands back arbitrary bytes, and a read
    /// can split a UTF-8 codepoint or an escape sequence straight down the
    /// middle. Interpreting those bytes as a String here would corrupt them
    /// (lossy conversion) or fail. Encoding the raw buffer keeps the byte
    /// stream exact; src/lib/pty.ts decodes it back to a Uint8Array.
    data: String,
}

/// Payload of the `pty://exit` event. Mirrors `PtyExitEvent` in src/types.ts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    pty_id: String,
    /// `null` when the exit status could not be determined.
    code: Option<i32>,
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

/// The writer is shared so `pty_write` can clone it out and release the
/// registry lock before doing a (potentially blocking) write.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Everything we keep for a live pty. Dropping it closes the master and the
/// writer; the detached threads notice via EOF and clean themselves up.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    /// Split out from the child at spawn time so we can signal it while the
    /// pump thread is parked in `child.wait()`.
    killer: Box<dyn ChildKiller + Send + Sync>,
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
///    Code: `pty_kill` signals Claude Code directly, and the code reported by
///    `pty://exit` is the command's own rather than a shell's.
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
    app: AppHandle,
    registry: tauri::State<'_, PtyRegistry>,
    opts: SpawnOptions,
) -> Result<String, String> {
    // Checked up front: a missing cwd otherwise surfaces as an opaque spawn
    // failure several layers down.
    if !Path::new(&opts.cwd).is_dir() {
        return Err(format!("cwd is not a directory: {}", opts.cwd));
    }

    let size = pty_size(opts.cols, opts.rows);
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = login_shell();
    let mut child = pair
        .slave
        .spawn_command(build_command(&shell, &opts))
        // Names the shell as well as the command: if this fails it is almost
        // always the shell that is missing, and "failed to spawn claude" would
        // send whoever reads it looking in the wrong place.
        .map_err(|e| format!("failed to spawn {} via {shell}: {e}", opts.command))?;

    // The slave fd must go now. While we hold it open the kernel considers the
    // pty to still have a writer, so the reader thread would never see EOF
    // after the child exits and `pty://exit` would never fire.
    drop(pair.slave);

    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read from pty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to pty: {e}"))?;

    let pty_id = registry.new_id();
    registry.sessions.lock().insert(
        pty_id.clone(),
        PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer,
        },
    );

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    spawn_named(format!("pty-read-{pty_id}"), move || read_loop(reader, &tx));

    let sessions = Arc::clone(&registry.sessions);
    let pump_id = pty_id.clone();
    spawn_named(format!("pty-pump-{pty_id}"), move || {
        pump_loop(&app, &pump_id, &rx);
        // Output is fully drained at this point, so it is safe to announce the
        // exit. Reaping the child also keeps it from lingering as a zombie.
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        sessions.lock().remove(&pump_id);
        let _ = app.emit(
            "pty://exit",
            ExitEvent {
                pty_id: pump_id.clone(),
                code,
            },
        );
    });

    Ok(pty_id)
}

#[tauri::command]
pub async fn pty_write(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    // Clone the handle out, then drop the registry lock: a write to a pty whose
    // child has stopped reading can block, and it must not block every other
    // pty while it does.
    let writer = {
        let sessions = registry.sessions.lock();
        let session = sessions
            .get(&pty_id)
            .ok_or_else(|| format!("unknown pty: {pty_id}"))?;
        Arc::clone(&session.writer)
    };

    let mut writer = writer.lock();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write to {pty_id} failed: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("flush of {pty_id} failed: {e}"))
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

#[tauri::command]
pub async fn pty_kill(
    registry: tauri::State<'_, PtyRegistry>,
    pty_id: String,
) -> Result<(), String> {
    // Take the session out under the lock, then act on it with the lock
    // released. Dropping it here closes the master and the writer, which is
    // also what makes the reader thread see EOF if the signal is ignored.
    let mut session = {
        let mut sessions = registry.sessions.lock();
        sessions
            .remove(&pty_id)
            .ok_or_else(|| format!("unknown pty: {pty_id}"))?
    };

    let result = session
        .killer
        .kill()
        .map_err(|e| format!("kill of {pty_id} failed: {e}"));

    // The pump thread still owns the child, so it reaps it and emits
    // `pty://exit` on its own. Nothing to join here.
    drop(session);
    result
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

/// Reads the pty master until EOF, handing raw chunks to the pump thread.
fn read_loop(mut reader: Box<dyn Read + Send>, tx: &Sender<Vec<u8>>) {
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        match reader.read(&mut buf) {
            // EOF on Linux/macOS once the child and the slave fd are gone.
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break; // pump thread gone; nobody left to deliver to
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // Includes EIO, which is how a closed slave end reports itself on
            // some platforms. Treat every other error as end of stream: the
            // child is about to be reaped and reported through pty://exit.
            Err(_) => break,
        }
    }
}

/// Coalesces chunks from the reader and emits them as `pty://output`.
///
/// Returns once the reader thread has dropped its sender and the buffer has
/// been drained.
fn pump_loop(app: &AppHandle, pty_id: &str, rx: &Receiver<Vec<u8>>) {
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES * 2);
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
            if !emit_output(app, pty_id, &buf) {
                return; // webview is gone
            }
            buf.clear();
            continue;
        }

        match rx.recv_timeout(deadline - now) {
            Ok(chunk) => buf.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout) => {
                if !emit_output(app, pty_id, &buf) {
                    return;
                }
                buf.clear();
            }
            Err(RecvTimeoutError::Disconnected) => {
                // Flush the tail before reporting the exit.
                emit_output(app, pty_id, &buf);
                return;
            }
        }
    }
}

/// Emits one chunk. Returns false if the event could not be delivered, which in
/// practice means the window is gone and the pump should stop.
fn emit_output(app: &AppHandle, pty_id: &str, bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    app.emit(
        "pty://output",
        OutputEvent {
            pty_id: pty_id.to_string(),
            data: BASE64.encode(bytes),
        },
    )
    .is_ok()
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
}
