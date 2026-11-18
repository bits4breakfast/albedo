//! One-shot `claude -p` for the Review Guide (#186), and nothing else: the
//! guide's own run, and its Context step (#444, below).
//!
//! The narrow channel CLAUDE.md records (owner decision 2026-11-02): Albedo may
//! run Claude Code once, non-interactively, with no tools, on Haiku, and read
//! its single JSON result from stdout. It never touches a task's own session,
//! never runs in a pty, and its output is a structured JSON document -- never
//! terminal bytes. What that document means is `src/guide/writer.ts`'s
//! business alone; this file hands back stdout, stderr and the exit code
//! untouched.
//!
//! Every flag is fixed here rather than passed from the page, so the frontend
//! can choose the words (system prompt, schema, input) but not the shape of
//! the run: it cannot ask for tools, another model, a session that persists,
//! or the user's MCP servers. Measured on Claude Code 2.1.316:
//!
//! - `--tools ""` leaves no built-in tools; `--json-schema` still works (it is
//!   answered through Claude Code's own structured-output tool, so the result
//!   reports `num_turns: 2`) and the parsed object is `structured_output`.
//! - `--strict-mcp-config` (no `--mcp-config`): the user's MCP servers are not
//!   loaded. Without it the tiniest call cost ~181k input tokens here.
//! - `--system-prompt` replaces Claude Code's own (~3.8k -> ~1k tokens).
//! - `--settings {"disableAllHooks":true}`: a project's `UserPromptSubmit`
//!   hook otherwise adds text to the prompt (verified: it did).
//! - `--no-session-persistence`: no transcript is written, so capture never
//!   sees this run. Claude Code still creates an empty
//!   `~/.claude/projects/<dir>/memory/` for the folder, and adds no trust entry
//!   to `~/.claude.json` in print mode.
//! - The project's CLAUDE.md IS loaded from the working folder (verified), so
//!   the run happens in `~/.albedo/guide`, a folder of Albedo's own with none:
//!   the model needs nothing from the worktree that the prompt does not carry.
//! - A failure (e.g. an unknown model) still prints one JSON line with
//!   `is_error: true`, and exits 1. A missing `claude` is the shell's 127.
//!
//! ## The Context step (#444), a second, separately fixed run
//!
//! By the owner's decision (2026-11-18, issue #444), the Review Guide may run
//! one more one-shot before it is written: the user's own instructions, per
//! project, to pull background (a ticket, the support conversations behind
//! it) from their own MCP tools. `claude_context_oneshot` is that run, and
//! the widening is exactly this: it loads the user's MCP servers; built-in
//! tools stay off (`--tools ""`); the model is one of haiku, sonnet, opus; the
//! time limit is 5 minutes at most; it runs in `~/.albedo/guide`, persists no
//! session, has hooks disabled, and never touches a task's session. The page
//! chooses only the model, the names, the time limit and the words.
//! `claude_args` above is untouched by it: the guide's own run is still no
//! tools, Haiku, `--strict-mcp-config`.
//!
//! What is enforced about tools, and nothing more:
//!
//! 1. Each name must match `^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$`
//!    (`valid_tool_name`): no built-in can be named.
//! 2. A listing run, stopped at its first line, names every tool and server
//!    the run would load. `resolve` turns the user's names into the tools
//!    present then: a server's name into the tools it has at that moment (one
//!    it adds later is not allowed). A name that matches nothing is an error;
//!    so is a server not connected, after listing again (up to 3 times, 3 s
//!    apart) while it is `pending`. Never quietly dropped: a run without its
//!    tools would answer "found nothing".
//! 3. Only those tools go in `--allowedTools`, with `--permission-mode
//!    dontAsk`; every other tool and every server none of them belong to goes
//!    in `--disallowedTools` (`deny_list`).
//! 4. The run's own first line (`init`) must be in the shape measured
//!    (`tools` a list of names, `mcp_servers` a list with a name and status
//!    each: `parse_init` rejects anything else rather than filtering it),
//!    name no tool beyond those and `StructuredOutput` (`unexpected_tools`),
//!    and name no server that is neither one those tools belong to nor shut
//!    out by name (`unexpected_servers`: one that turned up after the
//!    listing). Any JSON line before that check has passed -- a turn, a
//!    tool's result, an answer -- stops the run too. Stopped, its answer is
//!    never used.
//!
//! A server name still allows every tool it had when listed, writing ones
//! included: the sheet says so. The listing and a run stopped early are asked
//! to end first (SIGTERM to the group, 1.5 s, then SIGKILL): Claude Code may
//! be writing a refreshed OAuth token.
//!
//! Measured on Claude Code 2.1.327, with read-only tools only (a claude.ai
//! connector's tool, and a whole read-only connector):
//!
//! - Without `--strict-mcp-config`, `-p` loads the user's servers, claude.ai
//!   connectors included (27 servers, 308 tools here) -- but only with the
//!   `user` setting source: `--setting-sources ""` or `project` loads none.
//!   So the run has `--setting-sources user`.
//! - `--tools ""` removes the built-ins only; every MCP tool stays. `--tools`
//!   with an MCP name changes nothing.
//! - With `dontAsk`, a tool not in `--allowedTools` is denied at once, no
//!   prompt -- unless a standing allow rule in the user's own settings names
//!   it: then it ran (verified with a rule passed through `--settings`). And
//!   all 308 definitions are sent on every request: a one-line answer cost
//!   ~400k input tokens and $0.40 on Haiku. With the deny list, a denied tool
//!   is gone from the run ("isn't available in this session"), a standing
//!   allow rule no longer reaches it (verified), and its definition is not
//!   sent. Bash reports as missing.
//! - The listing's `init` line comes ~2.5-3.8 s in; 0 to 2 claude.ai
//!   connectors were `pending` per listing, a different count each time, so
//!   one is listed again. A tool on a `needs-auth` connector fails at once,
//!   naming it; a misspelt tool fails naming its server. Stopped with SIGTERM,
//!   the listing ended in ~1 s (exit 143), never needing SIGKILL.
//! - `--json-schema` still works alongside MCP calls, with `stream-json`:
//!   the final `result` line carries `structured_output`.
//! - Cost and time, listing included, one tool call: Haiku ~$0.002 and
//!   ~12 s, Sonnet ~$0.04 and ~10 s; a whole read-only connector (14 tools,
//!   expanded at listing) ~$0.004 and ~19 s on Haiku. A tool's own answer can
//!   add ~40k tokens a request.
//! - Not enforced, recorded: `dontAsk` and the listed tools are what keep a
//!   tool from running; nothing here can tell a reading tool from a writing
//!   one.
//!
//! It goes through the user's login shell, exactly as `pty.rs` does, for the
//! same two reasons: a Finder-launched app's PATH does not reach `claude`, and
//! the `unset` of the Anthropic variables must run after the profile (hard
//! rule 3). The prompt goes in on stdin, so no argv limit applies to it.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::pty::{login_shell, login_shell_invocation, strip_env, SpawnOptions};

/// The longest a caller may ask to wait. A guide call is minutes at most.
const MAX_TIMEOUT_MS: u64 = 15 * 60 * 1000;
/// Kept from each stream; a guide's JSON is a few kilobytes.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OneshotResult {
    /// The process's exit code; None when it was killed (timeout) or signalled.
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    /// The Context step's tools as the run was given them (#444): the user's
    /// names, a server's expanded to its tools. Never set for the guide's run.
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed: Option<Vec<String>>,
}

/// The fixed argv after `claude`. The page supplies only the words.
pub(crate) fn claude_args(system_prompt: &str, json_schema: &str) -> Vec<String> {
    [
        "-p",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--system-prompt",
        system_prompt,
        "--json-schema",
        json_schema,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Run `claude -p` once with `prompt` on stdin. Never a pty, never a session.
#[tauri::command]
pub async fn claude_oneshot(
    app: tauri::AppHandle,
    system_prompt: String,
    json_schema: String,
    prompt: String,
    timeout_ms: u64,
) -> Result<OneshotResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home folder: {e}"))?;
    let dir = home.join(".albedo").join("guide");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, MAX_TIMEOUT_MS));
    let args = claude_args(&system_prompt, &json_schema);
    tauri::async_runtime::spawn_blocking(move || run(dir, args, prompt, Instant::now() + timeout))
        .await
        .map_err(|e| format!("one-shot run failed: {e}"))?
}

// ---------------------------------------------------------------------------
// The Context step (#444): a second, separately fixed run
// ---------------------------------------------------------------------------

/// The models the Context step may run on: Claude Code's aliases, nothing else.
pub(crate) const CONTEXT_MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
/// The longest the Context step may take, listing the tools included.
pub(crate) const CONTEXT_MAX_TIMEOUT_MS: u64 = 5 * 60 * 1000;
/// More tool names than this is not a list someone typed.
pub(crate) const CONTEXT_MAX_TOOLS: usize = 32;
/// Claude Code's own tool for `--json-schema`: the only tool that is not MCP.
const STRUCTURED_OUTPUT_TOOL: &str = "StructuredOutput";
/// A server still connecting when listed is listed again after this, at most
/// [`LISTING_ATTEMPTS`] times in all.
const LISTING_RETRY: Duration = Duration::from_secs(3);
const LISTING_ATTEMPTS: usize = 3;
/// Between asking a run to end (SIGTERM) and making it (SIGKILL): room for
/// Claude Code to finish writing, say, a refreshed OAuth token.
const STOP_GRACE: Duration = Duration::from_millis(1500);

/// `^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$`: an MCP server (`mcp__tracker`)
/// or one of its tools (`mcp__tracker__get_issue`). Nothing else -- so no
/// built-in (`Bash`, `Read`, `WebFetch`, `Write`), no rule with a pattern in
/// parentheses, no space or comma that would split into a second entry.
pub(crate) fn valid_tool_name(name: &str) -> bool {
    match name.strip_prefix("mcp__") {
        Some(rest) => {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        }
        None => false,
    }
}

/// The checks on what the page may choose; the timeout to use when they pass.
pub(crate) fn check_context_request(
    model: &str,
    tools: &[String],
    timeout_ms: u64,
) -> Result<Duration, String> {
    if !CONTEXT_MODELS.contains(&model) {
        return Err(format!("model {model:?} is not one of haiku, sonnet, opus"));
    }
    if tools.is_empty() {
        return Err("no tools listed".into());
    }
    if tools.len() > CONTEXT_MAX_TOOLS {
        return Err(format!("more than {CONTEXT_MAX_TOOLS} tools listed"));
    }
    if let Some(bad) = tools.iter().find(|t| !valid_tool_name(t)) {
        return Err(format!("{bad:?} is not an MCP tool or server name"));
    }
    if timeout_ms > CONTEXT_MAX_TIMEOUT_MS {
        return Err("the time limit is over 5 minutes".into());
    }
    Ok(Duration::from_millis(timeout_ms.max(1_000)))
}

/// The flags every Context run has, the listing included: the user's MCP
/// servers (no `--strict-mcp-config`), no built-in tools, only the user's
/// settings file, nothing asked (anything not allowed is denied), no session,
/// no hooks, no slash commands, and a stream whose first line names what the
/// run loaded.
fn context_base(model: &str) -> Vec<String> {
    [
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--setting-sources",
        "user",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// The fixed argv of the Context run. The page supplies the model (from
/// [`CONTEXT_MODELS`]) and the words; `allowed` is the user's names as
/// [`resolve`] found them (single tools, never a server), `denied` is
/// [`deny_list`]'s.
pub(crate) fn context_args(
    model: &str,
    allowed: &[String],
    denied: &[String],
    system_prompt: &str,
    json_schema: &str,
) -> Vec<String> {
    let mut args = context_base(model);
    args.extend(["--allowedTools".into(), allowed.join(",")]);
    if !denied.is_empty() {
        args.extend(["--disallowedTools".into(), denied.join(",")]);
    }
    args.extend([
        "--system-prompt".into(),
        system_prompt.to_string(),
        "--json-schema".into(),
        json_schema.to_string(),
    ]);
    args
}

/// The listing: the same run, stopped at its first line (`system`/`init`),
/// which names every tool and server it loaded. On Haiku, whatever the
/// Context step's model, so a request that slips out before the stop is the
/// cheapest one.
fn listing_args() -> Vec<String> {
    let mut args = context_base("haiku");
    args.extend(
        [
            "--max-turns",
            "1",
            "--system-prompt",
            "Reply with one word.",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args
}

/// What the listing found: every tool, and every server with its status.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Listing {
    pub tools: Vec<String>,
    pub servers: Vec<(String, String)>,
}

/// The `system`/`init` line, if this is it: `None` for any other line,
/// `Some(Err)` for an init line not in the shape measured -- `tools` missing
/// or holding anything but strings, `mcp_servers` missing or an entry
/// without a string name and status. Nothing is filtered out: what cannot be
/// read is not trusted.
pub(crate) fn parse_init(line: &str) -> Option<Result<Listing, String>> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "system" || v.get("subtype")?.as_str()? != "init" {
        return None;
    }
    Some(init_listing(&v))
}

fn init_listing(v: &serde_json::Value) -> Result<Listing, String> {
    let tools = v
        .get("tools")
        .and_then(|t| t.as_array())
        .ok_or("its init line has no tools list")?
        .iter()
        .map(|t| t.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
        .ok_or("its init line lists a tool that is not a name")?;
    let servers = v
        .get("mcp_servers")
        .and_then(|s| s.as_array())
        .ok_or("its init line has no server list")?
        .iter()
        .map(|s| {
            Some((
                s.get("name")?.as_str()?.to_string(),
                s.get("status")?.as_str()?.to_string(),
            ))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or("its init line lists a server without a name and status")?;
    Ok(Listing { tools, servers })
}

/// A server's tool prefix, as Claude Code names them: `claude.ai Tracker`
/// -> `mcp__claude_ai_Tracker`.
pub(crate) fn server_prefix(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("mcp__{safe}")
}

fn under(name: &str, prefix: &str) -> bool {
    name == prefix
        || name
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with("__"))
}

/// What the user's names come to in a listing.
#[derive(Debug, PartialEq)]
pub(crate) enum Resolution {
    /// Single tools, each in the listing: a server name is expanded to the
    /// tools it had then, so a tool it adds later is not allowed.
    Ready(Vec<String>),
    /// A server one of the names needs was not connected: its name and status.
    NotConnected(String, String),
}

/// The user's names against a listing. A name that matches nothing -- no
/// server, or a server without that tool -- is an error, never quietly
/// dropped: a run without its tools would answer "found nothing".
pub(crate) fn resolve(listed: &[String], listing: &Listing) -> Result<Resolution, String> {
    let mut out: Vec<String> = Vec::new();
    for name in listed {
        let server = listing
            .servers
            .iter()
            .find(|(n, _)| under(name, &server_prefix(n)));
        if let Some((server, status)) = server {
            if status != "connected" {
                return Ok(Resolution::NotConnected(server.clone(), status.clone()));
            }
        }
        if listing
            .servers
            .iter()
            .any(|(n, _)| server_prefix(n) == *name)
        {
            let tools: Vec<&String> = listing.tools.iter().filter(|t| under(t, name)).collect();
            if tools.is_empty() {
                return Err(format!("the server {name} offers no tools"));
            }
            out.extend(tools.into_iter().cloned());
        } else if listing.tools.contains(name) {
            out.push(name.clone());
        } else if let Some((server, _)) = server {
            return Err(format!("{name} is not a tool of the server \"{server}\""));
        } else {
            return Err(format!("no MCP server offers {name}"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|t| seen.insert(t.clone()));
    Ok(Resolution::Ready(out))
}

/// Everything the run must not see, given the single tools it may use: every
/// other tool in the listing, every server none of them belong to, and every
/// server not connected. `--allowedTools` only spares a tool a prompt;
/// denying the rest takes them out of the run altogether, so a standing allow
/// rule in the user's own settings cannot reach them, and their definitions
/// are not sent (300 tools cost ~200k input tokens a request, measured). Errs
/// on a tool whose name could not be denied exactly.
pub(crate) fn deny_list(allowed: &[String], listing: &Listing) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for tool in &listing.tools {
        if tool == STRUCTURED_OUTPUT_TOOL || allowed.contains(tool) {
            continue;
        }
        if !tool
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!("a tool named {tool:?} cannot be shut out"));
        }
        out.push(tool.clone());
    }
    for (name, status) in &listing.servers {
        let prefix = server_prefix(name);
        let wanted = allowed.iter().any(|a| under(a, &prefix));
        if status != "connected" || !wanted {
            out.push(prefix);
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// The tools a run's own `init` line names that it was not given: anything
/// past these makes the run stop before its first turn.
pub(crate) fn unexpected_tools(init: &Listing, allowed: &[String]) -> Vec<String> {
    init.tools
        .iter()
        .filter(|t| *t != STRUCTURED_OUTPUT_TOOL && !allowed.contains(t))
        .cloned()
        .collect()
}

/// The servers a run's own `init` line names that are neither one the
/// allowed tools belong to nor shut out by name: a server that turned up after
/// the listing. Anything here makes the run stop before its first turn.
pub(crate) fn unexpected_servers(
    init: &Listing,
    allowed: &[String],
    denied: &[String],
) -> Vec<String> {
    init.servers
        .iter()
        .map(|(name, _)| server_prefix(name))
        .filter(|prefix| !allowed.iter().any(|a| under(a, prefix)) && !denied.contains(prefix))
        .collect()
}

/// Run the Context step once (#444): list what the user's MCP servers offer,
/// then run with only the listed tools, checking what the run itself loaded.
/// Never a pty, never a session.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn claude_context_oneshot(
    app: tauri::AppHandle,
    model: String,
    tools: Vec<String>,
    system_prompt: String,
    json_schema: String,
    prompt: String,
    timeout_ms: u64,
) -> Result<OneshotResult, String> {
    let timeout = check_context_request(&model, &tools, timeout_ms)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home folder: {e}"))?;
    let dir = home.join(".albedo").join("guide");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let deadline = Instant::now() + timeout;
    tauri::async_runtime::spawn_blocking(move || {
        let shell = login_shell();
        let mut attempt = 0;
        let (listing, allowed) = loop {
            attempt += 1;
            let cmd = build_command(&shell, &dir, listing_args());
            let listing = match list_tools(cmd, deadline)? {
                Listed::Found(l) => l,
                Listed::Ended(out) => return Ok(out),
                Listed::TimedOut => return Ok(timed_out_result()),
            };
            match resolve(&tools, &listing)? {
                Resolution::Ready(allowed) => break (listing, allowed),
                Resolution::NotConnected(server, status) => {
                    // Only a server still connecting is worth waiting for.
                    let again = status == "pending"
                        && attempt < LISTING_ATTEMPTS
                        && Instant::now() + LISTING_RETRY < deadline;
                    if !again {
                        return Err(format!(
                            "the server \"{server}\" was not connected ({status})"
                        ));
                    }
                    thread::sleep(LISTING_RETRY);
                }
            }
        };
        let denied = deny_list(&allowed, &listing)?;
        let args = context_args(&model, &allowed, &denied, &system_prompt, &json_schema);
        let mut out = run_context(
            build_command(&shell, &dir, args),
            prompt,
            deadline,
            &allowed,
            &denied,
        )?;
        out.allowed = Some(allowed);
        Ok(out)
    })
    .await
    .map_err(|e| format!("one-shot run failed: {e}"))?
}

fn timed_out_result() -> OneshotResult {
    OneshotResult {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: true,
        allowed: None,
    }
}

/// How the listing went.
#[derive(Debug)]
enum Listed {
    Found(Listing),
    /// The deadline came first.
    TimedOut,
    /// It ended without an `init` line (`claude` missing, not signed in, ...):
    /// its output, for the page to read as it reads any failed run.
    Ended(OneshotResult),
}

/// A spawned run's stdout, a line at a time, on a channel. Never joined: on
/// macOS a process spawned at the same moment elsewhere in the app can
/// inherit the pipe's write end, so its end of file may come long after the
/// run is over. The callers watch the run itself instead.
fn line_reader(stdout: std::process::ChildStdout) -> std::sync::mpsc::Receiver<String> {
    use std::io::BufRead;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        let mut kept = 0usize;
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            kept += line.len();
            // Keep draining past the cap (and once nobody listens), or the
            // child blocks on a full pipe.
            if kept <= MAX_OUTPUT_BYTES {
                let _ = tx.send(line);
            }
        }
    });
    rx
}

/// A run's stderr, read in the background, for a failure's message: waited
/// for briefly, never for good (see [`line_reader`]).
fn stderr_reader(stderr: std::process::ChildStderr) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        let _ = tx.send(read_capped(stderr));
    });
    rx
}

fn stderr_of(rx: &std::sync::mpsc::Receiver<String>) -> String {
    rx.recv_timeout(Duration::from_millis(500))
        .unwrap_or_default()
}

/// The next line of a run, or why there is none: the deadline, or the run
/// having ended (its output closed, or the process gone and nothing more
/// written for a moment).
enum Next {
    Line(String),
    Deadline,
    Ended,
}

struct Lines {
    rx: std::sync::mpsc::Receiver<String>,
    exited_at: Option<Instant>,
}

impl Lines {
    fn next(&mut self, child: &mut std::process::Child, deadline: Instant) -> Next {
        use std::sync::mpsc::RecvTimeoutError;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Next::Deadline;
            }
            match self.rx.recv_timeout(left.min(Duration::from_millis(100))) {
                Ok(line) => return Next::Line(line),
                Err(RecvTimeoutError::Disconnected) => return Next::Ended,
                Err(RecvTimeoutError::Timeout) => {
                    if self.exited_at.is_none() && matches!(child.try_wait(), Ok(Some(_))) {
                        self.exited_at = Some(Instant::now());
                    }
                    if self
                        .exited_at
                        .is_some_and(|at| at.elapsed() > Duration::from_millis(300))
                    {
                        return Next::Ended;
                    }
                }
            }
        }
    }
}

/// Ask a process group to end (SIGTERM), give it `grace`, then make it
/// (SIGKILL). Never signals a group whose leader was already reaped.
fn stop_group(
    child: &mut std::process::Child,
    grace: Duration,
) -> Option<std::process::ExitStatus> {
    let pid = child.id();
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status);
    }
    term_group(pid);
    let until = Instant::now() + grace;
    while Instant::now() < until {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    kill_group(pid);
    let _ = child.kill();
    child.wait().ok()
}

/// The listing's `init` line, read and then the run stopped: asked first
/// (SIGTERM), since it may be writing a refreshed OAuth token, then made to.
fn list_tools(mut cmd: Command, deadline: Instant) -> Result<Listed, String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the listing: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // Dropped here, so the prompt ends.
        let _ = stdin.write_all(b".");
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = stderr_reader(child.stderr.take().ok_or("no stderr")?);
    let mut lines = Lines {
        rx: line_reader(stdout),
        exited_at: None,
    };
    let mut seen = String::new();
    let found = loop {
        match lines.next(&mut child, deadline) {
            Next::Line(line) => match parse_init(&line) {
                Some(Ok(l)) => break Ok(l),
                Some(Err(why)) => {
                    stop_group(&mut child, STOP_GRACE);
                    return Err(format!("the listing could not be read: {why}"));
                }
                None => {
                    seen.push_str(&line);
                    seen.push('\n');
                }
            },
            Next::Deadline => break Err(true),
            Next::Ended => break Err(false),
        }
    };
    let ended = matches!(found, Err(false));
    let status = stop_group(
        &mut child,
        if ended {
            Duration::from_secs(2)
        } else {
            STOP_GRACE
        },
    );
    Ok(match found {
        Ok(l) => Listed::Found(l),
        Err(true) => Listed::TimedOut,
        Err(false) => Listed::Ended(OneshotResult {
            code: status.and_then(|s| s.code()),
            stdout: seen,
            stderr: stderr_of(&stderr),
            timed_out: false,
            allowed: None,
        }),
    })
}

/// The Context run itself, failing closed on what it loaded: its own `init`
/// line must name no tool past `allowed` (and `StructuredOutput`), or it is
/// stopped there and this errs. A `result` line before any `init` line errs
/// too. Hands back the final `result` line as stdout -- the one line the page
/// reads, as from `--output-format json` -- after any non-JSON lines (a login
/// profile's), never the stream's own (tool results among them).
fn run_context(
    mut cmd: Command,
    prompt: String,
    deadline: Instant,
    allowed: &[String],
    denied: &[String],
) -> Result<OneshotResult, String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the run: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    thread::spawn(move || {
        // A child that exits early closes the pipe; that is its answer.
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = stderr_reader(child.stderr.take().ok_or("no stderr")?);
    let mut lines = Lines {
        rx: line_reader(stdout),
        exited_at: None,
    };

    let mut checked = false;
    let mut result: Option<String> = None;
    let mut other = String::new();
    let mut refused: Option<String> = None;
    let mut timed_out = false;
    loop {
        let line = match lines.next(&mut child, deadline) {
            Next::Line(line) => line,
            Next::Deadline => {
                timed_out = true;
                break;
            }
            Next::Ended => break,
        };
        match parse_init(&line) {
            Some(Err(why)) => {
                refused = Some(format!("{why}, so the run was stopped"));
                break;
            }
            Some(Ok(init)) => {
                let extra = unexpected_tools(&init, allowed);
                let servers = unexpected_servers(&init, allowed, denied);
                if !extra.is_empty() || !servers.is_empty() {
                    let all: Vec<String> = extra.into_iter().chain(servers).collect();
                    let shown: Vec<_> = all.iter().take(5).cloned().collect();
                    refused = Some(format!(
                        "the run loaded tools it was not given ({}{}), so it was stopped",
                        shown.join(", "),
                        if all.len() > 5 { ", …" } else { "" }
                    ));
                    break;
                }
                checked = true;
                continue;
            }
            None => {}
        }
        let json = line.trim_start().starts_with('{')
            && serde_json::from_str::<serde_json::Value>(line.trim()).is_ok();
        if json && !checked {
            // Anything the run says before its tools are checked -- an
            // answer, a turn, a tool's result -- stops it there.
            refused = Some(
                "the run went on before saying which tools it had loaded, so it was stopped".into(),
            );
            break;
        }
        let is_result = json
            && serde_json::from_str::<serde_json::Value>(line.trim())
                .ok()
                .is_some_and(|v| v.get("type").and_then(|t| t.as_str()) == Some("result"));
        if is_result {
            result = Some(line);
        } else if !line.trim_start().starts_with('{') && other.len() < 64 * 1024 {
            other.push_str(&line);
            other.push('\n');
        }
    }
    let ended = refused.is_none() && !timed_out;
    let status = stop_group(
        &mut child,
        if ended {
            Duration::from_secs(2)
        } else {
            STOP_GRACE
        },
    );
    if let Some(why) = refused {
        return Err(why);
    }
    Ok(OneshotResult {
        code: if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        stdout: match result {
            Some(line) => format!("{other}{line}\n"),
            None => other,
        },
        stderr: stderr_of(&stderr),
        timed_out,
        allowed: None,
    })
}

fn run(
    dir: PathBuf,
    args: Vec<String>,
    prompt: String,
    deadline: Instant,
) -> Result<OneshotResult, String> {
    let shell = login_shell();
    let mut cmd = build_command(&shell, &dir, args);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {shell}: {e}"))?;
    let pid = child.id();

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let writer = thread::spawn(move || {
        // A child that exits early closes the pipe; that is its answer, not ours.
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let out_reader = thread::spawn(move || read_capped(stdout));
    let err_reader = thread::spawn(move || read_capped(stderr));

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(format!("waiting on claude failed: {e}")),
        }
        if Instant::now() >= deadline {
            timed_out = true;
            kill_group(pid);
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(100));
    };

    let _ = writer.join();
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(OneshotResult {
        code: if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        stdout,
        stderr,
        timed_out,
        allowed: None,
    })
}

/// The login shell running `claude` with the fixed argv, in `dir`, with the
/// Anthropic variables stripped -- the same invocation and strip as the ptys.
fn build_command(shell: &str, dir: &Path, args: Vec<String>) -> Command {
    let opts = SpawnOptions {
        cwd: dir.to_string_lossy().into_owned(),
        command: "claude".to_string(),
        args,
        cols: 80,
        rows: 24,
        env: None,
    };
    let mut cmd = Command::new(shell);
    cmd.args(login_shell_invocation(shell, &opts))
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Layer 1 of the strip (layer 2 is the `unset` in the script).
    strip_env(|key| {
        cmd.env_remove(key);
    });
    // Its own process group, so a timeout ends Claude Code and anything it
    // started, not only the first process.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    if let Ok(pgid) = i32::try_from(pid) {
        // SAFETY: plain syscall on a group we created; no memory involved.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

#[cfg(unix)]
fn term_group(pid: u32) {
    if let Ok(pgid) = i32::try_from(pid) {
        // SAFETY: plain syscall on a group we created; no memory involved.
        unsafe { libc::killpg(pgid, libc::SIGTERM) };
    }
}

#[cfg(not(unix))]
fn term_group(_pid: u32) {}

fn read_capped(mut r: impl Read) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < MAX_OUTPUT_BYTES {
                    let take = n.min(MAX_OUTPUT_BYTES - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
                // Keep draining past the cap, or the child blocks on a full pipe.
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::shell_script;

    #[test]
    fn the_run_is_fixed_no_tools_haiku_json_nothing_persisted() {
        let args = claude_args("sys", "{}");
        let joined = args.join(" ");
        assert_eq!(args[0], "-p");
        assert!(joined.contains("--model haiku"));
        assert!(joined.contains("--output-format json"));
        let tools = args.iter().position(|a| a == "--tools").expect("--tools");
        assert_eq!(args[tools + 1], "", "tools must be the empty list");
        for flag in [
            "--no-session-persistence",
            "--strict-mcp-config",
            "--disable-slash-commands",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
    }

    #[test]
    fn the_guide_run_is_unchanged_byte_for_byte() {
        // #444 added a second mode; the guide's own argv must not move.
        let expected: Vec<String> = [
            "-p",
            "--model",
            "haiku",
            "--output-format",
            "json",
            "--tools",
            "",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--settings",
            r#"{"disableAllHooks":true}"#,
            "--system-prompt",
            "sys",
            "--json-schema",
            "{}",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(claude_args("sys", "{}"), expected);
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_context_run_is_fixed_listed_mcp_tools_only_nothing_persisted() {
        let allowed = names(&["mcp__tracker__get_issue", "mcp__support"]);
        let denied = names(&["mcp__tracker__save_issue", "mcp__mail"]);
        let args = context_args("sonnet", &allowed, &denied, "sys", "{}");
        let joined = args.join(" ");
        assert_eq!(args[0], "-p");
        assert!(joined.contains("--model sonnet"));
        assert!(joined.contains("--output-format stream-json --verbose"));
        let at = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .unwrap_or_else(|| panic!("{flag}"))
        };
        assert_eq!(args[at("--tools") + 1], "", "no built-in tools");
        assert_eq!(args[at("--setting-sources") + 1], "user");
        assert_eq!(args[at("--permission-mode") + 1], "dontAsk");
        assert_eq!(
            args[at("--allowedTools") + 1],
            "mcp__tracker__get_issue,mcp__support"
        );
        assert_eq!(
            args[at("--disallowedTools") + 1],
            "mcp__tracker__save_issue,mcp__mail"
        );
        assert_eq!(args[at("--settings") + 1], r#"{"disableAllHooks":true}"#);
        for flag in ["--no-session-persistence", "--disable-slash-commands"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        // The user's servers load: neither of these, ever.
        assert!(!args.iter().any(|a| a == "--strict-mcp-config"));
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
        assert!(!args.iter().any(|a| a == "bypassPermissions"));
        // Nothing denied: no empty flag.
        let none = context_args("haiku", &allowed, &[], "sys", "{}");
        assert!(!none.iter().any(|a| a == "--disallowedTools"));
    }

    #[test]
    fn the_listing_is_the_same_run_on_haiku_stopped_at_its_first_line() {
        let args = listing_args();
        let joined = args.join(" ");
        assert!(joined.contains("--model haiku"));
        assert!(joined.contains("--output-format stream-json --verbose"));
        assert!(joined.contains("--setting-sources user --permission-mode dontAsk"));
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "");
        assert!(!args.iter().any(|a| a == "--allowedTools"));
        assert!(!args.iter().any(|a| a == "--strict-mcp-config"));
    }

    #[test]
    fn only_mcp_names_pass() {
        for ok in [
            "mcp__tracker",
            "mcp__tracker__get_issue",
            "mcp__claude_ai_Tracker__list_teams",
            "mcp__shop-api__find",
        ] {
            assert!(valid_tool_name(ok), "{ok}");
        }
        for bad in [
            "Bash",
            "Read",
            "WebFetch",
            "Write",
            "Edit",
            "Bash(git *)",
            "mcp__",
            "mcp_tracker",
            "MCP__tracker",
            "mcp__tracker__get issue",
            "mcp__tracker,Bash",
            "mcp__tracker Bash",
            "mcp__tracker(*)",
            "mcp__tracker__*",
            " mcp__tracker",
            "",
        ] {
            assert!(!valid_tool_name(bad), "{bad:?} passed");
        }
    }

    #[test]
    fn the_request_is_checked_model_tools_and_time() {
        let tools = names(&["mcp__tracker__get_issue"]);
        assert!(check_context_request("sonnet", &tools, 120_000).is_ok());
        assert!(check_context_request("haiku", &tools, 300_000).is_ok());
        assert!(check_context_request("opus", &tools, 1).is_ok());
        assert!(check_context_request("fable", &tools, 120_000).is_err());
        assert!(check_context_request("claude-sonnet-4-5", &tools, 120_000).is_err());
        assert!(check_context_request("sonnet", &tools, 300_001).is_err());
        assert!(check_context_request("sonnet", &[], 120_000).is_err());
        assert!(check_context_request("sonnet", &names(&["Bash"]), 120_000).is_err());
        assert!(check_context_request(
            "sonnet",
            &names(&["mcp__tracker__get_issue", "WebFetch"]),
            120_000
        )
        .is_err());
        let many: Vec<String> = (0..=CONTEXT_MAX_TOOLS)
            .map(|i| format!("mcp__s__t{i}"))
            .collect();
        assert!(check_context_request("sonnet", &many, 120_000).is_err());
    }

    #[test]
    fn the_init_line_is_read_and_nothing_else() {
        let line = r#"{"type":"system","subtype":"init","tools":["mcp__tracker__get_issue","StructuredOutput"],"mcp_servers":[{"name":"claude.ai Tracker","status":"connected"},{"name":"mail","status":"needs-auth"}]}"#;
        let got = parse_init(line).expect("init").expect("well formed");
        assert_eq!(
            got.tools,
            names(&["mcp__tracker__get_issue", "StructuredOutput"])
        );
        assert_eq!(
            got.servers,
            vec![
                ("claude.ai Tracker".to_string(), "connected".to_string()),
                ("mail".to_string(), "needs-auth".to_string())
            ]
        );
        assert!(parse_init(r#"{"type":"assistant"}"#).is_none());
        assert!(parse_init("Last login: today").is_none());
    }

    #[test]
    fn server_prefixes_follow_claude_codes_names() {
        assert_eq!(server_prefix("claude.ai Tracker"), "mcp__claude_ai_Tracker");
        assert_eq!(server_prefix("plugin:shop:api"), "mcp__plugin_shop_api");
        assert_eq!(server_prefix("support-desk"), "mcp__support-desk");
    }

    fn listing() -> Listing {
        Listing {
            tools: names(&[
                "mcp__tracker__get_issue",
                "mcp__tracker__save_issue",
                "mcp__support__search",
                "mcp__support__read",
                "mcp__mail__send",
                "StructuredOutput",
            ]),
            servers: vec![
                ("tracker".into(), "connected".into()),
                ("support".into(), "connected".into()),
                ("mail".into(), "connected".into()),
                ("calendar".into(), "needs-auth".into()),
                ("docs".into(), "pending".into()),
            ],
        }
    }

    #[test]
    fn a_server_name_becomes_the_tools_it_has_when_listed() {
        let got = resolve(
            &names(&["mcp__tracker__get_issue", "mcp__support"]),
            &listing(),
        )
        .unwrap();
        assert_eq!(
            got,
            Resolution::Ready(names(&[
                "mcp__tracker__get_issue",
                "mcp__support__search",
                "mcp__support__read",
            ]))
        );
    }

    #[test]
    fn a_name_that_matches_nothing_is_an_error_never_dropped() {
        let typo = resolve(&names(&["mcp__tracker__get_isue"]), &listing()).unwrap_err();
        assert_eq!(
            typo,
            r#"mcp__tracker__get_isue is not a tool of the server "tracker""#
        );
        let missing = resolve(&names(&["mcp__wiki__read"]), &listing()).unwrap_err();
        assert_eq!(missing, "no MCP server offers mcp__wiki__read");
        let missing_server = resolve(&names(&["mcp__wiki"]), &listing()).unwrap_err();
        assert_eq!(missing_server, "no MCP server offers mcp__wiki");
    }

    #[test]
    fn a_listed_tool_on_a_server_not_connected_waits_or_fails_it_is_never_dropped() {
        assert_eq!(
            resolve(&names(&["mcp__docs__read"]), &listing()).unwrap(),
            Resolution::NotConnected("docs".into(), "pending".into())
        );
        assert_eq!(
            resolve(
                &names(&["mcp__tracker__get_issue", "mcp__calendar"]),
                &listing()
            )
            .unwrap(),
            Resolution::NotConnected("calendar".into(), "needs-auth".into())
        );
    }

    #[test]
    fn everything_not_given_is_shut_out() {
        let allowed = names(&[
            "mcp__tracker__get_issue",
            "mcp__support__search",
            "mcp__support__read",
        ]);
        let denied = deny_list(&allowed, &listing()).unwrap();
        assert_eq!(
            denied,
            names(&[
                "mcp__calendar",
                "mcp__docs",
                "mcp__mail",
                "mcp__mail__send",
                "mcp__tracker__save_issue",
            ])
        );
        let odd = Listing {
            tools: names(&["Bash"]),
            servers: vec![],
        };
        assert_eq!(deny_list(&allowed, &odd).unwrap(), names(&["Bash"]));
        let unsafe_name = Listing {
            tools: names(&["mcp__x__a,b"]),
            servers: vec![],
        };
        assert!(deny_list(&allowed, &unsafe_name).is_err());
    }

    #[test]
    fn a_tool_the_run_loaded_past_what_it_was_given_is_found() {
        let init = Listing {
            tools: names(&[
                "mcp__tracker__get_issue",
                "StructuredOutput",
                "mcp__wiki__read",
            ]),
            servers: vec![],
        };
        assert_eq!(
            unexpected_tools(&init, &names(&["mcp__tracker__get_issue"])),
            names(&["mcp__wiki__read"])
        );
        assert!(unexpected_tools(
            &init,
            &names(&["mcp__tracker__get_issue", "mcp__wiki__read"])
        )
        .is_empty());
    }

    // --- the runs, with a stand-in for `claude` --------------------------

    #[cfg(unix)]
    fn fake(script: &str) -> Command {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.process_group(0);
        cmd
    }

    const INIT: &str = r#"{"type":"system","subtype":"init","tools":["mcp__tracker__get_issue","StructuredOutput"],"mcp_servers":[{"name":"tracker","status":"connected"}]}"#;

    #[cfg(unix)]
    #[test]
    fn the_listing_reads_the_init_line_then_stops_the_run() {
        let started = Instant::now();
        let script = format!("echo 'Last login: today'; echo '{INIT}'; sleep 30");
        let got = list_tools(fake(&script), Instant::now() + Duration::from_secs(20)).unwrap();
        let Listed::Found(l) = got else {
            panic!("{got:?}")
        };
        assert_eq!(
            l.tools,
            names(&["mcp__tracker__get_issue", "StructuredOutput"])
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "stopped, not waited out"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_listing_that_ends_without_init_hands_back_its_exit() {
        let got = list_tools(
            fake("echo 'claude: command not found' >&2; exit 127"),
            Instant::now() + Duration::from_secs(20),
        )
        .unwrap();
        let Listed::Ended(out) = got else {
            panic!("{got:?}")
        };
        assert_eq!(out.code, Some(127));
        assert!(out.stderr.contains("not found"));
    }

    #[cfg(unix)]
    #[test]
    fn stopping_asks_first_then_makes_it_end() {
        // A run that ignores SIGTERM: it gets the grace, then SIGKILL.
        let dir = std::env::temp_dir().join(format!("albedo-stop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("term");
        let _ = std::fs::remove_file(&marker);
        let script = format!(
            "trap 'touch {}' TERM; echo ready; while true; do sleep 0.05; done",
            marker.display()
        );
        let mut child = fake(&script).spawn().unwrap();
        let mut out = child.stdout.take().unwrap();
        let mut b = [0u8; 6];
        out.read_exact(&mut b).unwrap();
        let started = Instant::now();
        let status = stop_group(&mut child, Duration::from_millis(600)).unwrap();
        let took = started.elapsed();
        assert!(marker.exists(), "SIGTERM came first");
        assert!(
            took >= Duration::from_millis(550),
            "the grace was given: {took:?}"
        );
        assert!(took < Duration::from_secs(4));
        assert!(status.code().is_none(), "killed in the end");
        // One that goes on SIGTERM is not waited for.
        let mut quick = fake("echo ready; sleep 30").spawn().unwrap();
        let mut q = quick.stdout.take().unwrap();
        q.read_exact(&mut b).unwrap();
        let started = Instant::now();
        stop_group(&mut quick, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn the_run_hands_back_its_result_line_once_its_tools_are_checked() {
        let script = format!(
            r#"echo '{INIT}'; echo '{{"type":"assistant","message":{{"content":[]}}}}'; echo '{{"type":"result","is_error":false,"structured_output":{{"summary":"S","sources":[]}}}}'"#
        );
        let out = run_context(
            fake(&script),
            "prompt".into(),
            Instant::now() + Duration::from_secs(20),
            &names(&["mcp__tracker__get_issue"]),
            &[],
        )
        .unwrap();
        assert_eq!(out.code, Some(0));
        assert!(!out.timed_out);
        assert_eq!(out.stdout.lines().count(), 1, "{}", out.stdout);
        assert!(out.stdout.starts_with(r#"{"type":"result""#));
    }

    #[cfg(unix)]
    #[test]
    fn a_run_that_loaded_more_than_it_was_given_is_stopped_before_its_answer() {
        let dir = std::env::temp_dir().join(format!("albedo-init-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("answered");
        let _ = std::fs::remove_file(&marker);
        let init = r#"{"type":"system","subtype":"init","tools":["mcp__tracker__get_issue","mcp__wiki__read"],"mcp_servers":[]}"#;
        let script = format!(
            "echo '{init}'; sleep 3; touch {}; echo '{{\"type\":\"result\"}}'",
            marker.display()
        );
        let started = Instant::now();
        let err = run_context(
            fake(&script),
            "p".into(),
            Instant::now() + Duration::from_secs(20),
            &names(&["mcp__tracker__get_issue"]),
            &[],
        )
        .unwrap_err();
        assert!(err.contains("mcp__wiki__read"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3));
        thread::sleep(Duration::from_millis(3500));
        assert!(!marker.exists(), "it never got further");
    }

    #[cfg(unix)]
    #[test]
    fn a_result_before_any_init_line_is_not_used() {
        let err = run_context(
            fake(r#"echo '{"type":"result","structured_output":{}}'"#),
            "p".into(),
            Instant::now() + Duration::from_secs(20),
            &names(&["mcp__tracker__get_issue"]),
            &[],
        )
        .unwrap_err();
        assert!(err.contains("before saying which tools"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_deadline_is_stopped_and_says_so() {
        let script = format!("echo '{INIT}'; sleep 30");
        let started = Instant::now();
        let out = run_context(
            fake(&script),
            "p".into(),
            Instant::now() + Duration::from_millis(500),
            &names(&["mcp__tracker__get_issue"]),
            &[],
        )
        .unwrap();
        assert!(out.timed_out);
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    fn refused(script: &str, denied: &[String]) -> String {
        run_context(
            fake(script),
            "p".into(),
            Instant::now() + Duration::from_secs(20),
            &names(&["mcp__tracker__get_issue"]),
            denied,
        )
        .unwrap_err()
    }

    #[test]
    fn an_init_line_not_in_the_measured_shape_is_not_trusted() {
        let no_tools = r#"{"type":"system","subtype":"init","mcp_servers":[]}"#;
        assert_eq!(
            parse_init(no_tools),
            Some(Err("its init line has no tools list".into()))
        );
        let objects = r#"{"type":"system","subtype":"init","tools":[{"name":"mcp__wiki__read"}],"mcp_servers":[]}"#;
        assert_eq!(
            parse_init(objects),
            Some(Err("its init line lists a tool that is not a name".into()))
        );
        let mixed = r#"{"type":"system","subtype":"init","tools":["mcp__tracker__get_issue",7],"mcp_servers":[]}"#;
        assert!(matches!(parse_init(mixed), Some(Err(_))));
        let no_servers = r#"{"type":"system","subtype":"init","tools":[]}"#;
        assert!(matches!(parse_init(no_servers), Some(Err(_))));
        let bad_server =
            r#"{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"x"}]}"#;
        assert!(matches!(parse_init(bad_server), Some(Err(_))));
    }

    #[cfg(unix)]
    #[test]
    fn the_run_stops_on_an_init_it_cannot_read() {
        let no_tools = r#"{"type":"system","subtype":"init","mcp_servers":[]}"#;
        let err = refused(&format!("echo '{no_tools}'; sleep 30"), &[]);
        assert!(err.contains("no tools list"), "{err}");
        let objects = r#"{"type":"system","subtype":"init","tools":[{"name":"mcp__wiki__read"}],"mcp_servers":[]}"#;
        let err = refused(&format!("echo '{objects}'; sleep 30"), &[]);
        assert!(err.contains("not a name"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn the_run_stops_on_anything_said_before_its_init() {
        let started = Instant::now();
        let err = refused(
            &format!(
                r#"echo '{{"type":"assistant","message":{{"content":[]}}}}'; echo '{INIT}'; sleep 30"#
            ),
            &[],
        );
        assert!(err.contains("before saying which tools"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
        // No init at all, only an answer: not used.
        let err = refused(r#"echo '{"type":"user","message":{}}'"#, &[]);
        assert!(err.contains("before saying which tools"), "{err}");
    }

    #[test]
    fn a_server_that_turned_up_after_the_listing_is_found() {
        let init = Listing {
            tools: names(&["mcp__tracker__get_issue"]),
            servers: vec![
                ("tracker".into(), "connected".into()),
                ("mail".into(), "connected".into()),
                ("wiki".into(), "pending".into()),
            ],
        };
        let allowed = names(&["mcp__tracker__get_issue"]);
        assert_eq!(
            unexpected_servers(&init, &allowed, &names(&["mcp__mail"])),
            names(&["mcp__wiki"])
        );
        assert!(
            unexpected_servers(&init, &allowed, &names(&["mcp__mail", "mcp__wiki"])).is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_run_stops_when_its_init_names_a_server_neither_wanted_nor_shut_out() {
        let init = r#"{"type":"system","subtype":"init","tools":["mcp__tracker__get_issue"],"mcp_servers":[{"name":"tracker","status":"connected"},{"name":"wiki","status":"pending"}]}"#;
        let err = refused(&format!("echo '{init}'; sleep 30"), &names(&["mcp__mail"]));
        assert!(err.contains("mcp__wiki"), "{err}");
    }

    /// The measurement in the module doc, against the real `claude`:
    /// `ALBEDO_MEASURE_TOOLS=mcp__<server>__<a read-only tool>[,...] cargo
    /// test measure_the_context_run -- --ignored --nocapture`. Runs the same
    /// path as the command (listing, resolve with its retries, deny list,
    /// checked run) and prints counts, cost, turns, denials and outcomes --
    /// never what a tool returned.
    #[test]
    #[ignore]
    fn measure_the_context_run() {
        let tools: Vec<String> = std::env::var("ALBEDO_MEASURE_TOOLS")
            .expect("ALBEDO_MEASURE_TOOLS")
            .split(',')
            .map(str::to_string)
            .collect();
        let model = std::env::var("ALBEDO_MEASURE_MODEL").unwrap_or_else(|_| "haiku".into());
        let dir = std::env::temp_dir().join("albedo-measure-context");
        std::fs::create_dir_all(&dir).unwrap();
        let shell = login_shell();
        let deadline = Instant::now() + Duration::from_secs(300);
        let started = Instant::now();
        let mut attempt = 0;
        let (listing, allowed) = loop {
            attempt += 1;
            let t = Instant::now();
            let got = list_tools(build_command(&shell, &dir, listing_args()), deadline).unwrap();
            let Listed::Found(listing) = got else {
                panic!("{got:?}")
            };
            let pending = listing
                .servers
                .iter()
                .filter(|(_, s)| s == "pending")
                .count();
            println!(
                "listing {attempt}: {} tools, {} servers ({pending} pending), {:?}",
                listing.tools.len(),
                listing.servers.len(),
                t.elapsed()
            );
            match resolve(&tools, &listing) {
                Ok(Resolution::Ready(a)) => break (listing, a),
                Ok(Resolution::NotConnected(s, st)) => {
                    println!("not connected: {s} ({st})");
                    if st != "pending" || attempt >= LISTING_ATTEMPTS {
                        println!("-> fails: the server \"{s}\" was not connected ({st})");
                        return;
                    }
                    thread::sleep(LISTING_RETRY);
                }
                Err(e) => {
                    println!("-> fails: {e}");
                    return;
                }
            }
        };
        let denied = deny_list(&allowed, &listing).unwrap();
        println!(
            "allowed: {} tools, denied: {} entries",
            allowed.len(),
            denied.len()
        );
        let schema = r#"{"type":"object","properties":{"calls":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"outcome":{"type":"string","enum":["ok","denied","missing"]}},"required":["tool","outcome"]}}},"required":["calls"]}"#;
        let prompt = format!(
            "Call {} once. Then try to call any other tool you have, and Bash. Report each call's outcome only: no data.",
            allowed[0]
        );
        let args = context_args(
            &model,
            &allowed,
            &denied,
            "You test which tools you may call.",
            schema,
        );
        match run_context(
            build_command(&shell, &dir, args),
            prompt,
            deadline,
            &allowed,
            &denied,
        ) {
            Err(e) => println!("-> refused: {e}"),
            Ok(out) => {
                let line = out
                    .stdout
                    .lines()
                    .rev()
                    .find(|l| l.starts_with('{'))
                    .unwrap_or("{}");
                let v: serde_json::Value = serde_json::from_str(line).unwrap_or_default();
                println!(
                    "code {:?} total {:?} turns {} cost {} denials {} structured {}",
                    out.code,
                    started.elapsed(),
                    v["num_turns"],
                    v["total_cost_usd"],
                    v["permission_denials"],
                    v["structured_output"]
                );
            }
        }
    }

    #[test]
    fn the_command_is_the_login_shell_with_the_anthropic_variables_removed() {
        let cmd = build_command("/bin/zsh", Path::new("/tmp/g"), claude_args("sys", "{}"));
        assert_eq!(cmd.get_program(), "/bin/zsh");
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..3], ["-l", "-i", "-c"]);
        assert_eq!(args.len(), 4);
        assert!(
            args[3].starts_with("cd '/tmp/g' || exit 1; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL; exec 'claude' '-p'"),
            "{}",
            args[3]
        );
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp/g")));
        let removed: Vec<_> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
        ] {
            assert!(removed.iter().any(|k| k == key), "{key} not removed");
        }
    }

    #[test]
    fn the_script_unsets_the_anthropic_variables_before_claude() {
        let opts = SpawnOptions {
            cwd: "/tmp/g".into(),
            command: "claude".into(),
            args: claude_args("it's", "{}"),
            cols: 80,
            rows: 24,
            env: None,
        };
        let script = shell_script("/bin/zsh", &opts);
        let unset = script.find("unset ANTHROPIC_API_KEY").expect("unset");
        let exec = script.find("exec 'claude'").expect("exec");
        assert!(unset < exec);
        assert!(
            script.contains(r#"'it'\''s'"#),
            "the prompt words are quoted: {script}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kill_group_ends_a_child_in_its_own_group_at_once() {
        // Not claude: `sleep` stands in for a run that never answers, killed
        // the way `run` kills one at its deadline.
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 30")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let started = Instant::now();
        kill_group(child.id());
        let status = child.wait().unwrap();
        assert!(status.code().is_none(), "killed, not exited");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
