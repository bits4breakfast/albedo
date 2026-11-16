//! Albedo's MCP server (#157): the five things a session can ask Albedo for
//! (the fourth, `set_task_summary`, from #262; the fifth, `show_preview`,
//! from #348).
//!
//! Claude Code starts this binary for every session Albedo spawns
//! (`--mcp-config`, with `ALBEDO_TASK_ID` in its environment) and talks
//! JSON-RPC to it over stdin/stdout. It answers `tools/list` and `tools/call`;
//! a call that passes validation is appended as one line to
//! `~/.albedo/inbox/task-<id>.jsonl`. Acting on it -- showing it, queueing it
//! for approval -- is the app's job.
//!
//! Four of the tools are answered at once. `show_preview` is not: it copies
//! the page the session names into `~/.albedo/previews`, writes its line, and
//! then waits for `answer-<task>-<request>.json`, which the app writes only
//! from a click on the "waiting on you" card (`preview.rs`). The answer is
//! the call's result. `notifications/cancelled` (Esc in the terminal, or
//! Claude Code's own timeout) ends the wait: it is recorded in the inbox so
//! the app retires the card, and the answer file's name is never read again.
//! The stdio loop (`main.rs`) calls [`Server::poll`] while anything waits.
//!
//! No network. Nothing read back but the page named and its answer. The
//! caller's identity is the task id Albedo put in the environment, never
//! anything in a request.
//!
//! ## Protocol versions
//!
//! Dual-era, as the MCP specification describes it
//! (<https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>):
//!
//! - **Legacy** (2025-11-25 and earlier): an `initialize` handshake picks the
//!   version (<https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>).
//!   The requested version is echoed when supported, else the latest one here.
//! - **Modern** (2026-07-28): no handshake; every request names its version in
//!   `_meta["io.modelcontextprotocol/protocolVersion"]`, `server/discover`
//!   lists the versions, an unsupported one gets `UnsupportedProtocolVersionError`
//!   (-32022), results carry `resultType: "complete"`, and the two cacheable
//!   ones carry `ttlMs`/`cacheScope`. Claude Code 2.1.314 connects this way.
//!
//! A request without that `_meta` key is served as legacy.

pub mod due;
pub mod inbox;
pub mod preview;
pub mod tools;

use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::PathBuf;

pub const SERVER_NAME: &str = "albedo";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Per-request-metadata versions this server speaks, newest first.
pub const MODERN_VERSIONS: &[&str] = &["2026-07-28"];
/// `initialize`-handshake versions this server speaks, newest first.
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// How long a modern client may keep `tools/list` and `server/discover`.
pub const CACHE_TTL_MS: u64 = 3_600_000;

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";

/// JSON-RPC and MCP error codes.
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const UNSUPPORTED_VERSION: i64 = -32022;

/// At most this many tool calls in any [`RATE_WINDOW_MS`], per process (one
/// process per session). Well above anything a session asks for honestly; a
/// loop gets an error it can read instead of filling the user's queue.
pub const RATE_LIMIT: usize = 20;
pub const RATE_WINDOW_MS: i64 = 60_000;

const INSTRUCTIONS: &str = "This session runs inside Albedo, the user's desktop cockpit for Claude Code sessions. \
These tools ask Albedo for things only it can do: a reminder on this task, a new session (only ever started with \
the user's approval), telling the user you are blocked on them, a one-line summary of what this task is about, \
shown beside its title, or an HTML mockup shown to the user for approval. Every call is delivered to Albedo and \
answered at once, except `show_preview`: it waits until the user answers, and their answer is its result. \
Whenever you would show the user a UI mockup or HTML preview for their approval, write it as one self-contained \
HTML file and call `show_preview` with its path, instead of linking to it or describing it; do not build what it \
shows until it comes back approved. Its description is not shown until the tool is loaded, so this is the \
reminder. \
As soon as you know what this task is about -- typically right after reading the ticket or issue it is named \
after -- call `set_task_summary` once with a plain one-line summary (no ticket key), and again only if the task's \
purpose changes. Its description is not shown until the tool is loaded, so this is the reminder. \
Likewise for `request_session`: when the conversation turns to a new piece of work that is not this task's -- \
another ticket or case, a code fix that needs its own branch and PR, a different system or project -- call it \
right then, so the user can move it to its own task. That moment is when you would otherwise offer to do it \
here (\"I can branch and fix this\", \"want me to open a PR?\") or start doing it: call `request_session` \
instead of offering, and say in your reply that you did. Investigating or answering a question still belongs \
here; making a change for it, or taking on a separate ticket, does not. It is only a proposal: nothing \
starts unless they approve, and declining costs them one click. Write `prompt` as a brief that stands alone: what \
was already found, links and identifiers, what was checked, what is left. Ask once per piece of work, and never \
for the work this task was started for.";

/// What the server needs from the outside world, so tests can supply it.
pub struct Env {
    /// `ALBEDO_TASK_ID`, when it is a positive integer.
    pub task: Option<u64>,
    /// `~/.albedo/inbox`, when `HOME` is known.
    pub inbox_dir: Option<PathBuf>,
    /// `~/.albedo/previews`, when `HOME` is known (`show_preview`, #348).
    pub previews_dir: Option<PathBuf>,
    /// Where a relative `show_preview` path is read from: the directory
    /// Claude Code started this server in.
    pub cwd: Option<PathBuf>,
    pub now_ms: Box<dyn FnMut() -> i64>,
}

impl Env {
    /// From the process environment and the system clock.
    pub fn from_process() -> Env {
        let task = std::env::var("ALBEDO_TASK_ID")
            .ok()
            .and_then(|s| parse_task_id(&s));
        let home = std::env::var_os("HOME").filter(|h| !h.is_empty());
        let inbox_dir = home
            .as_ref()
            .map(|h| inbox::dir_under(std::path::Path::new(h)));
        let previews_dir = home
            .as_ref()
            .map(|h| preview::dir_under(std::path::Path::new(h)));
        Env {
            task,
            inbox_dir,
            previews_dir,
            cwd: std::env::current_dir().ok(),
            now_ms: Box::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            }),
        }
    }
}

/// A task id: digits only, not zero. Anything else means "not started by Albedo".
pub fn parse_task_id(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|&n| n > 0)
}

/// A `show_preview` call waiting for the user's answer.
struct Wait {
    /// The JSON-RPC id the answer goes back under.
    rpc_id: Value,
    /// The inbox line's id: the request's name in the answer file.
    request: String,
    task: u64,
    answer: PathBuf,
    modern: bool,
}

/// What a `tools/call` came to: an answer now, or a wait (`show_preview`).
enum Called {
    Now(Result<Value, Value>),
    Waiting,
}

pub struct Server {
    env: Env,
    calls: VecDeque<i64>,
    seq: u64,
    waits: Vec<Wait>,
}

impl Server {
    pub fn new(env: Env) -> Server {
        if let Some(dir) = env.previews_dir.as_deref() {
            preview::sweep(dir, std::time::SystemTime::now());
        }
        Server {
            env,
            calls: VecDeque::new(),
            seq: 0,
            waits: Vec::new(),
        }
    }

    /// Whether a `show_preview` call is waiting, so the loop should poll.
    pub fn waiting(&self) -> bool {
        !self.waits.is_empty()
    }

    /// The answers that arrived since the last poll, as JSON-RPC responses.
    /// Each wait ends with its answer; a malformed answer file is removed and
    /// the call keeps waiting.
    pub fn poll(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < self.waits.len() {
            match preview::take_answer(&self.waits[i].answer) {
                Some(preview::Answer::Text(text)) => {
                    let w = self.waits.remove(i);
                    let result =
                        json!({"content": [{"type": "text", "text": text}], "isError": false});
                    out.push(respond(w.rpc_id, "tools/call", Ok(result), w.modern));
                }
                Some(preview::Answer::Malformed) => {
                    eprintln!(
                        "albedo-mcp: ignored a malformed answer for {}",
                        self.waits[i].request
                    );
                    i += 1;
                }
                None => i += 1,
            }
        }
        out
    }

    /// stdin closed: Claude Code is gone, and so is every call that waited.
    /// Each is recorded as cancelled, so the app retires its card.
    pub fn shutdown(&mut self) {
        for w in std::mem::take(&mut self.waits) {
            self.record_cancel(&w, "session ended");
        }
    }

    /// `notifications/cancelled`: stop waiting for that request, and say so.
    /// Per the protocol, a cancelled request gets no response.
    fn cancel(&mut self, params: Option<&Value>) {
        let Some(rid) = params.and_then(|p| p.get("requestId")) else {
            return;
        };
        let reason = params.and_then(|p| p.get("reason")).and_then(Value::as_str);
        if let Some(i) = self.waits.iter().position(|w| &w.rpc_id == rid) {
            let w = self.waits.remove(i);
            self.record_cancel(&w, &preview::clean_reason(reason));
        }
    }

    fn record_cancel(&mut self, w: &Wait, reason: &str) {
        let Some(dir) = self.env.inbox_dir.clone() else {
            return;
        };
        let now = (self.env.now_ms)();
        self.seq += 1;
        let id = format!("{}-{}-{}", std::process::id(), now, self.seq);
        let mut args = Map::new();
        args.insert("request".into(), w.request.clone().into());
        args.insert("reason".into(), reason.into());
        match inbox::line(w.task, inbox::PREVIEW_CANCELLED, args, now, &id) {
            Ok(bytes) => {
                if let Err(e) = inbox::append(&inbox::file_for(&dir, w.task), &bytes) {
                    eprintln!("albedo-mcp: could not record a cancelled preview: {e}");
                }
            }
            Err(e) => eprintln!("albedo-mcp: could not record a cancelled preview: {e}"),
        }
    }

    /// One incoming line: the line to write back, or None (a notification, a
    /// response from the client, or a blank line).
    pub fn handle_line(&mut self, line: &[u8]) -> Option<Value> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return None;
        }
        match serde_json::from_slice::<Value>(line) {
            Ok(msg) => self.handle(&msg),
            Err(e) => Some(error(
                Value::Null,
                PARSE_ERROR,
                &format!("Parse error: {e}"),
                None,
            )),
        }
    }

    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let Some(obj) = msg.as_object() else {
            // Batches were removed from the protocol in 2025-06-18.
            return Some(error(
                Value::Null,
                INVALID_REQUEST,
                "Invalid request: expected one JSON-RPC object",
                None,
            ));
        };
        let id = obj.get("id").cloned();
        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            // A response to something we never sent, or junk without an id.
            return id
                .filter(|_| !obj.contains_key("result") && !obj.contains_key("error"))
                .map(|id| error(id, INVALID_REQUEST, "Invalid request: no method", None));
        };
        // A cancel ends a `show_preview` wait (#348); other notifications
        // (`notifications/initialized`) need nothing.
        if id.is_none() && method == "notifications/cancelled" {
            self.cancel(obj.get("params"));
            return None;
        }
        let id = id?;
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(error(
                id,
                INVALID_REQUEST,
                "Invalid request: jsonrpc must be \"2.0\"",
                None,
            ));
        }
        let params = obj.get("params");

        let requested = params
            .and_then(|p| p.get("_meta"))
            .and_then(|m| m.get(META_VERSION))
            .and_then(Value::as_str);
        let modern = match requested {
            Some(v) if MODERN_VERSIONS.contains(&v) => true,
            Some(v) if method != "initialize" => return Some(unsupported(id, v)),
            _ => false,
        };

        let result = match method {
            "initialize" => Ok(self.initialize(params)),
            "server/discover" => Ok(discover()),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tools::definitions()})),
            "tools/call" => match self.call(params, &id, modern) {
                Called::Now(r) => r,
                Called::Waiting => return None,
            },
            _ => Err(error(
                id.clone(),
                METHOD_NOT_FOUND,
                &format!("Method not found: {method}"),
                None,
            )),
        };
        Some(respond(id, method, result, modern))
    }

    fn initialize(&self, params: Option<&Value>) -> Value {
        let asked = params
            .and_then(|p| p.get("protocolVersion"))
            .and_then(Value::as_str);
        // Echo a version we speak; otherwise offer our latest and let the
        // client decide (2025-11-25 lifecycle, "Version Negotiation").
        let version = asked
            .filter(|v| LEGACY_VERSIONS.contains(v))
            .unwrap_or(LEGACY_VERSIONS[0]);
        json!({
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": SERVER_NAME, "title": "Albedo", "version": SERVER_VERSION},
            "instructions": INSTRUCTIONS,
        })
    }

    fn call(&mut self, params: Option<&Value>, rpc_id: &Value, modern: bool) -> Called {
        let now_result = |r: Value| Called::Now(Ok(r));
        let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
            return Called::Now(Err(error(
                Value::Null,
                INVALID_PARAMS,
                "tools/call needs a tool `name`",
                None,
            )));
        };
        if !tools::NAMES.contains(&name) {
            return Called::Now(Err(error(
                Value::Null,
                INVALID_PARAMS,
                &format!("Unknown tool: {name}"),
                None,
            )));
        }
        let now = (self.env.now_ms)();
        if !self.admit(now) {
            return now_result(tool_error(&format!(
                "Too many requests: at most {RATE_LIMIT} a minute from one session. Nothing was sent; try again later."
            )));
        }
        let Some(task) = self.env.task else {
            return now_result(tool_error(
                "Albedo did not start this session (ALBEDO_TASK_ID is missing), so there is no task to deliver this to.",
            ));
        };
        let Some(dir) = self.env.inbox_dir.clone() else {
            return now_result(tool_error(
                "HOME is not set, so Albedo's inbox cannot be found.",
            ));
        };
        let mut accepted = match tools::validate(name, params.and_then(|p| p.get("arguments")), now)
        {
            Ok(a) => a,
            Err(msg) => return now_result(tool_error(&msg)),
        };
        self.seq += 1;
        let id = format!("{}-{}-{}", std::process::id(), now, self.seq);

        // show_preview: freeze the page before anything is written, so the
        // line never names a version that does not exist.
        let mut wait = None;
        if accepted.tool == tools::SHOW_PREVIEW {
            let Some(previews) = self.env.previews_dir.clone() else {
                return now_result(tool_error(
                    "HOME is not set, so Albedo's previews folder cannot be found.",
                ));
            };
            let path = accepted
                .args
                .remove("path")
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            let Some(full) = preview::resolve(&path, self.env.cwd.as_deref()) else {
                return now_result(tool_error(&format!(
                    "`path` ({path}) is relative; give the absolute path."
                )));
            };
            let page = match preview::read_page(&full) {
                Ok(p) => p,
                Err(msg) => return now_result(tool_error(&msg)),
            };
            if let Err(e) = preview::write_copy(&previews, task, &id, &page) {
                return now_result(tool_error(&format!(
                    "Could not copy the page for Albedo: {e}"
                )));
            }
            // The call's own id in the transcript, so the app can retire the
            // card when the transcript records this call's result.
            if let Some(t) = tool_use_id(params) {
                accepted.args.insert("toolUseId".into(), t.into());
            }
            wait = Some(Wait {
                rpc_id: rpc_id.clone(),
                request: id.clone(),
                task,
                answer: previews.join(preview::answer_name(task, &id)),
                modern,
            });
        }

        let bytes = match inbox::line(task, accepted.tool, accepted.args, now, &id) {
            Ok(b) => b,
            Err(msg) => return now_result(tool_error(&msg)),
        };
        if let Err(e) = inbox::append(&inbox::file_for(&dir, task), &bytes) {
            return now_result(tool_error(&format!(
                "Could not deliver this to Albedo: {e}"
            )));
        }
        match wait {
            Some(w) => {
                self.waits.push(w);
                Called::Waiting
            }
            None => now_result(
                json!({"content": [{"type": "text", "text": accepted.reply}], "isError": false}),
            ),
        }
    }

    /// Sliding window over the last [`RATE_WINDOW_MS`].
    fn admit(&mut self, now: i64) -> bool {
        while self
            .calls
            .front()
            .is_some_and(|&t| now - t >= RATE_WINDOW_MS)
        {
            self.calls.pop_front();
        }
        if self.calls.len() >= RATE_LIMIT {
            return false;
        }
        self.calls.push_back(now);
        true
    }
}

/// Claude Code's id for the call in its transcript, from the request's
/// `_meta`: plain characters only, or none.
fn tool_use_id(params: Option<&Value>) -> Option<&str> {
    let t = params?
        .get("_meta")?
        .get("claudecode/toolUseId")?
        .as_str()?;
    let ok = !t.is_empty()
        && t.len() <= 100
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then_some(t)
}

/// The response line for one request.
fn respond(id: Value, method: &str, result: Result<Value, Value>, modern: bool) -> Value {
    match result {
        Ok(mut r) => {
            if modern {
                if let Some(o) = r.as_object_mut() {
                    o.insert("resultType".into(), "complete".into());
                    // Required on these two from 2026-07-28 (server/utilities/caching).
                    // The list is fixed for the process and the same for everyone.
                    if matches!(method, "tools/list" | "server/discover") {
                        o.insert("ttlMs".into(), CACHE_TTL_MS.into());
                        o.insert("cacheScope".into(), "public".into());
                    }
                }
            }
            json!({"jsonrpc": "2.0", "id": id, "result": r})
        }
        Err(mut e) => {
            e["id"] = id;
            e
        }
    }
}

fn discover() -> Value {
    let supported: Vec<&str> = MODERN_VERSIONS
        .iter()
        .chain(LEGACY_VERSIONS)
        .copied()
        .collect();
    json!({
        "supportedVersions": supported,
        "capabilities": {"tools": {}},
        "_meta": {"io.modelcontextprotocol/serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}},
        "instructions": INSTRUCTIONS,
    })
}

fn unsupported(id: Value, requested: &str) -> Value {
    let supported: Vec<&str> = MODERN_VERSIONS
        .iter()
        .chain(LEGACY_VERSIONS)
        .copied()
        .collect();
    error(
        id,
        UNSUPPORTED_VERSION,
        "Unsupported protocol version",
        Some(json!({"supported": supported, "requested": requested})),
    )
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut e = Map::new();
    e.insert("code".into(), code.into());
    e.insert("message".into(), message.into());
    if let Some(d) = data {
        e.insert("data".into(), d);
    }
    json!({"jsonrpc": "2.0", "id": id, "error": e})
}

fn tool_error(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    const NOW: i64 = 1_793_692_800_000;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("albedo-mcp-lib-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn server(task: Option<u64>, dir: Option<PathBuf>, clock: Rc<Cell<i64>>) -> Server {
        Server::new(Env {
            task,
            inbox_dir: dir,
            previews_dir: None,
            cwd: None,
            now_ms: Box::new(move || clock.get()),
        })
    }

    fn req(id: i64, method: &str, params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    }

    fn notify_call(message: &str) -> Value {
        json!({"name": "notify_blocked", "arguments": {"message": message}})
    }

    #[test]
    fn initialize_echoes_a_known_version_and_offers_the_latest_otherwise() {
        let mut s = server(Some(1), None, Rc::new(Cell::new(NOW)));
        let r = s
            .handle(&req(
                1,
                "initialize",
                json!({"protocolVersion": "2025-06-18", "capabilities": {}}),
            ))
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(
            r["result"]["capabilities"]["tools"],
            json!({"listChanged": false})
        );
        assert_eq!(r["result"]["serverInfo"]["name"], "albedo");
        // Tool descriptions are deferred in Claude Code; the instructions are
        // what every session reads, so they carry the ask (#270).
        let said = r["result"]["instructions"].as_str().unwrap();
        assert!(said.contains("call `set_task_summary` once"), "{said}");
        // request_session too (#332): a session that never loads it never
        // learns when to offer a spin-out.
        assert!(said.contains("`request_session`"), "{said}");
        assert!(said.contains("a new piece of work"), "{said}");
        // The moment it is for: where a session would offer to do it here.
        assert!(said.contains("instead of offering"), "{said}");
        // show_preview (#348): deferred too, so the instructions name its
        // moment, and say honestly that it is the one call that waits.
        assert!(said.contains("`show_preview`"), "{said}");
        assert!(
            said.contains("UI mockup or HTML preview for their approval"),
            "{said}"
        );
        assert!(said.contains("it waits until the user answers"), "{said}");
        assert!(!said.contains("none of them waits"), "{said}");
        assert!(
            r["result"].get("resultType").is_none(),
            "legacy results carry no resultType"
        );
        let r = s
            .handle(&req(
                2,
                "initialize",
                json!({"protocolVersion": "1999-01-01"}),
            ))
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], LEGACY_VERSIONS[0]);
    }

    #[test]
    fn notifications_and_client_responses_get_no_reply() {
        let mut s = server(Some(1), None, Rc::new(Cell::new(NOW)));
        assert!(s
            .handle(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .is_none());
        assert!(s.handle(&json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 3}})).is_none());
        assert!(s
            .handle(&json!({"jsonrpc": "2.0", "id": 9, "result": {}}))
            .is_none());
        assert!(s.handle_line(b"   \n").is_none());
    }

    #[test]
    fn malformed_input_gets_json_rpc_errors() {
        let mut s = server(Some(1), None, Rc::new(Cell::new(NOW)));
        assert_eq!(
            s.handle_line(b"{not json").unwrap()["error"]["code"],
            PARSE_ERROR
        );
        assert_eq!(
            s.handle(&json!([req(1, "ping", json!({}))])).unwrap()["error"]["code"],
            INVALID_REQUEST
        );
        assert_eq!(
            s.handle(&json!({"jsonrpc": "1.0", "id": 1, "method": "ping"}))
                .unwrap()["error"]["code"],
            INVALID_REQUEST
        );
        let r = s.handle(&req(4, "resources/list", json!({}))).unwrap();
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(r["id"], 4);
    }

    #[test]
    fn modern_requests_are_served_with_result_type_and_discover_lists_versions() {
        let mut s = server(Some(1), None, Rc::new(Cell::new(NOW)));
        let meta = json!({"_meta": {META_VERSION: "2026-07-28", "io.modelcontextprotocol/clientInfo": {"name": "t", "version": "1"}}});
        let d = s.handle(&req(1, "server/discover", meta.clone())).unwrap();
        assert_eq!(d["result"]["resultType"], "complete");
        assert_eq!(d["result"]["supportedVersions"][0], "2026-07-28");
        assert!(d["result"]["supportedVersions"]
            .as_array()
            .unwrap()
            .contains(&json!("2025-11-25")));
        let l = s.handle(&req(2, "tools/list", meta)).unwrap();
        assert_eq!(l["result"]["resultType"], "complete");
        assert_eq!(l["result"]["tools"].as_array().unwrap().len(), 5);
        for r in [&d, &l] {
            assert_eq!(r["result"]["ttlMs"], CACHE_TTL_MS);
            assert_eq!(r["result"]["cacheScope"], "public");
        }
    }

    #[test]
    fn an_unknown_modern_version_is_refused_with_the_supported_list() {
        let mut s = server(Some(1), None, Rc::new(Cell::new(NOW)));
        let r = s
            .handle(&req(
                1,
                "tools/list",
                json!({"_meta": {META_VERSION: "2099-01-01"}}),
            ))
            .unwrap();
        assert_eq!(r["error"]["code"], UNSUPPORTED_VERSION);
        assert_eq!(r["error"]["data"]["requested"], "2099-01-01");
        assert_eq!(r["error"]["data"]["supported"][0], "2026-07-28");
    }

    #[test]
    fn unknown_tools_are_protocol_errors_and_bad_arguments_are_tool_errors() {
        let home = scratch("errors");
        let mut s = server(Some(5), Some(home.clone()), Rc::new(Cell::new(NOW)));
        let r = s
            .handle(&req(1, "tools/call", json!({"name": "rm_rf"})))
            .unwrap();
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = s
            .handle(&req(
                2,
                "tools/call",
                json!({"name": "notify_blocked", "arguments": {}}),
            ))
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "`message` is required.");
        assert!(!home.exists(), "nothing is written for a refused call");
    }

    #[test]
    fn an_accepted_call_appends_one_line_to_its_own_tasks_file() {
        let dir = scratch("accept");
        let mut s = server(Some(12), Some(dir.clone()), Rc::new(Cell::new(NOW)));
        let r = s
            .handle(&req(
                1,
                "tools/call",
                notify_call("I need the staging password"),
            ))
            .unwrap();
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(
            r["result"]["content"][0]["text"],
            "The user has been notified."
        );
        let text = std::fs::read_to_string(dir.join("task-12.jsonl")).unwrap();
        let line: Value = serde_json::from_str(text.trim_end()).unwrap();
        assert_eq!(line["v"], 1);
        assert_eq!(line["task"], 12);
        assert_eq!(line["tool"], "notify_blocked");
        assert_eq!(
            line["args"],
            json!({"message": "I need the staging password"})
        );
        assert_eq!(line["at"], NOW);
        assert!(line["id"].as_str().unwrap().ends_with(&format!("-{NOW}-1")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_task_id_nothing_is_written() {
        let dir = scratch("notask");
        let mut s = server(None, Some(dir.clone()), Rc::new(Cell::new(NOW)));
        let r = s.handle(&req(1, "tools/call", notify_call("x"))).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("ALBEDO_TASK_ID"));
        assert!(!dir.exists());
    }

    #[test]
    fn the_rate_limit_slides_with_the_clock() {
        let dir = scratch("rate");
        let clock = Rc::new(Cell::new(NOW));
        let mut s = server(Some(3), Some(dir.clone()), clock.clone());
        for i in 0..RATE_LIMIT {
            let r = s
                .handle(&req(i as i64, "tools/call", notify_call("m")))
                .unwrap();
            assert_eq!(r["result"]["isError"], false, "call {i}");
        }
        let r = s.handle(&req(99, "tools/call", notify_call("m"))).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Too many requests"));
        clock.set(NOW + RATE_WINDOW_MS);
        let r = s.handle(&req(100, "tools/call", notify_call("m"))).unwrap();
        assert_eq!(r["result"]["isError"], false);
        let lines = std::fs::read_to_string(dir.join("task-3.jsonl")).unwrap();
        assert_eq!(lines.lines().count(), RATE_LIMIT + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn task_ids_are_positive_integers_only() {
        assert_eq!(parse_task_id("42"), Some(42));
        for bad in [
            "",
            "0",
            "-1",
            "4 2",
            "../1",
            "1e3",
            "99999999999999999999999",
        ] {
            assert_eq!(parse_task_id(bad), None, "{bad}");
        }
    }
}
