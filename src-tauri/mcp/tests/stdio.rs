//! The built binary, driven the way Claude Code drives it: a session's worth
//! of JSON-RPC lines on stdin, one reply per request on stdout, and the inbox
//! line on disk under the HOME it was given.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("albedo-mcp-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Run the server over `input`, with `env` on top of a cleared environment.
fn run(input: &[Value], env: &[(&str, &str)]) -> Vec<Value> {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_albedo-mcp"));
    cmd.env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        for msg in input {
            writeln!(stdin, "{msg}").unwrap();
        }
    } // closing stdin ends the server
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "exit: {:?}", out.status);
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).expect("every stdout line is JSON"))
        .collect()
}

#[test]
fn a_legacy_session_initializes_lists_and_calls() {
    let home = scratch("legacy");
    let replies = run(
        &[
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2"}}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "request_session", "arguments": {"title": "Fix flaky test", "prompt": "The test X fails one run in five.", "reason": "Unrelated to this task"}}}),
        ],
        &[("HOME", home.to_str().unwrap()), ("ALBEDO_TASK_ID", "31")],
    );
    assert_eq!(
        replies.len(),
        3,
        "no reply to the notification: {replies:?}"
    );
    assert_eq!(replies[0]["id"], 0);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
    let names: Vec<_> = replies[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].clone())
        .collect();
    assert_eq!(
        names,
        [
            json!("create_reminder"),
            json!("request_session"),
            json!("notify_blocked"),
            json!("set_task_summary"),
            json!("show_preview")
        ]
    );
    assert_eq!(replies[2]["result"]["isError"], false);
    assert!(replies[2]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Queued for the user's approval"));

    let inbox = std::fs::read_to_string(home.join(".albedo/inbox/task-31.jsonl")).unwrap();
    let lines: Vec<Value> = inbox
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["task"], 31);
    assert_eq!(lines[0]["tool"], "request_session");
    assert_eq!(lines[0]["args"]["title"], "Fix flaky test");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_modern_client_discovers_then_calls_with_meta() {
    let home = scratch("modern");
    let meta = json!({"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}});
    let replies = run(
        &[
            json!({"jsonrpc": "2.0", "id": "d", "method": "server/discover", "params": {"_meta": meta}}),
            json!({"jsonrpc": "2.0", "id": "c", "method": "tools/call", "params": {"_meta": meta, "name": "notify_blocked", "arguments": {"message": "Need VPN access"}}}),
        ],
        &[("HOME", home.to_str().unwrap()), ("ALBEDO_TASK_ID", "8")],
    );
    assert_eq!(replies[0]["result"]["resultType"], "complete");
    assert_eq!(replies[1]["result"]["resultType"], "complete");
    assert_eq!(
        replies[1]["result"]["content"][0]["text"],
        "The user has been notified."
    );
    assert!(home.join(".albedo/inbox/task-8.jsonl").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn without_albedo_s_environment_calls_fail_and_nothing_is_written() {
    let home = scratch("bare");
    let replies = run(
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "notify_blocked", "arguments": {"message": "x"}}}),
        ],
        &[("HOME", home.to_str().unwrap())],
    );
    assert_eq!(replies[0]["result"]["isError"], true);
    assert!(!home.join(".albedo").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn garbage_lines_get_errors_and_the_server_keeps_going() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_albedo-mcp"))
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(b"not json\n\n{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"ping\"}\n")
            .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["error"]["code"], -32700);
    assert_eq!(replies[1], json!({"jsonrpc": "2.0", "id": 5, "result": {}}));
}

// ---------------------------------------------------------------------------
// show_preview (#348): the call that waits
// ---------------------------------------------------------------------------

/// A server kept running: lines in as they are sent, replies read as they come.
struct Live {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: Receiver<Value>,
}

impl Live {
    fn start(home: &Path, task: &str) -> Live {
        let mut child = Command::new(env!("CARGO_BIN_EXE_albedo-mcp"))
            .env_clear()
            .env("HOME", home)
            .env("ALBEDO_TASK_ID", task)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if tx
                    .send(serde_json::from_str::<Value>(&line).unwrap())
                    .is_err()
                {
                    return;
                }
            }
        });
        let stdin = child.stdin.take();
        Live {
            child,
            stdin,
            replies: rx,
        }
    }

    fn send(&mut self, msg: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
    }

    fn reply(&self, within: Duration) -> Option<Value> {
        self.replies.recv_timeout(within).ok()
    }

    fn close(mut self) {
        drop(self.stdin.take());
        assert!(self.child.wait().unwrap().success());
    }
}

fn inbox_lines(home: &Path, task: &str) -> Vec<Value> {
    std::fs::read_to_string(home.join(format!(".albedo/inbox/task-{task}.jsonl")))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// Wait until `f` holds, or fail after a few seconds.
fn until(what: &str, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn preview_call(id: i64, path: &Path) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {
        "_meta": {"claudecode/toolUseId": "toolu_01ABC"},
        "name": "show_preview",
        "arguments": {"path": path, "title": "Proposed row", "question": "Does it read?"}
    }})
}

#[test]
fn a_preview_waits_and_its_answer_is_the_result() {
    let home = scratch("preview-answer");
    let page = home.join("row.html");
    std::fs::write(&page, "<p>v1</p>").unwrap();
    let mut s = Live::start(&home, "12");
    s.send(preview_call(7, &page));

    // The line names the request; the copy is frozen under its id.
    until("the inbox line", || !inbox_lines(&home, "12").is_empty());
    let line = inbox_lines(&home, "12").remove(0);
    assert_eq!(line["tool"], "show_preview");
    assert_eq!(line["args"]["title"], "Proposed row");
    assert_eq!(line["args"]["question"], "Does it read?");
    assert_eq!(line["args"]["toolUseId"], "toolu_01ABC");
    assert!(
        line["args"].get("path").is_none(),
        "the session's path is not passed on"
    );
    let req = line["id"].as_str().unwrap().to_string();
    let previews = home.join(".albedo/previews");
    let copy = previews.join(format!("copy-12-{req}.html"));
    assert_eq!(std::fs::read_to_string(&copy).unwrap(), "<p>v1</p>");
    // Editing the session's file now changes nothing the user reviews.
    std::fs::write(&page, "<p>v2</p>").unwrap();
    assert_eq!(std::fs::read_to_string(&copy).unwrap(), "<p>v1</p>");

    // It waits, and keeps serving other requests meanwhile.
    assert!(
        s.reply(Duration::from_millis(600)).is_none(),
        "no answer yet"
    );
    s.send(json!({"jsonrpc": "2.0", "id": 8, "method": "ping"}));
    assert_eq!(s.reply(Duration::from_secs(2)).unwrap()["id"], 8);

    // The app's answer: written under a scratch name, then renamed.
    let answer = previews.join(format!("answer-12-{req}.json"));
    std::fs::write(
        &answer,
        r#"{"text":"changes requested on v1:\n- Make Approve the primary button."}"#,
    )
    .unwrap();
    let r = s.reply(Duration::from_secs(3)).expect("the answer");
    assert_eq!(r["id"], 7);
    assert_eq!(r["result"]["isError"], false);
    assert_eq!(
        r["result"]["content"][0]["text"],
        "changes requested on v1:\n- Make Approve the primary button."
    );
    until("the answer to be taken", || !answer.exists());
    s.close();
    assert_eq!(
        inbox_lines(&home, "12").len(),
        1,
        "an answered call records no cancel"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_cancel_ends_the_wait_and_a_late_answer_is_never_read() {
    let home = scratch("preview-cancel");
    let page = home.join("row.html");
    std::fs::write(&page, "<p>v1</p>").unwrap();
    let mut s = Live::start(&home, "5");
    s.send(preview_call(3, &page));
    until("the inbox line", || !inbox_lines(&home, "5").is_empty());
    let req = inbox_lines(&home, "5")[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Esc in the terminal, as measured on Claude Code 2.1.322.
    s.send(json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 3, "reason": "AbortError: user-cancel"}}));
    until("the cancel record", || inbox_lines(&home, "5").len() == 2);
    let cancel = &inbox_lines(&home, "5")[1];
    assert_eq!(cancel["tool"], "preview_cancelled");
    assert_eq!(cancel["args"]["request"], req.as_str());
    assert_eq!(cancel["args"]["reason"], "AbortError: user-cancel");

    // A click that lands now finds nobody reading: no reply, file untouched.
    let answer = home.join(format!(".albedo/previews/answer-5-{req}.json"));
    std::fs::write(&answer, r#"{"text":"approved"}"#).unwrap();
    assert!(
        s.reply(Duration::from_millis(800)).is_none(),
        "a cancelled request gets no response"
    );
    assert!(answer.exists(), "a late answer is never taken");
    s.close();
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn closing_the_session_cancels_what_waits() {
    let home = scratch("preview-eof");
    let page = home.join("row.html");
    std::fs::write(&page, "<p>v1</p>").unwrap();
    let mut s = Live::start(&home, "9");
    s.send(preview_call(1, &page));
    until("the inbox line", || !inbox_lines(&home, "9").is_empty());
    s.close();
    let lines = inbox_lines(&home, "9");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["tool"], "preview_cancelled");
    assert_eq!(lines[1]["args"]["reason"], "session ended");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_preview_that_cannot_be_read_is_refused_at_once() {
    let home = scratch("preview-missing");
    let replies = run(
        &[preview_call(1, &home.join("nope.html"))],
        &[("HOME", home.to_str().unwrap()), ("ALBEDO_TASK_ID", "2")],
    );
    assert_eq!(replies[0]["result"]["isError"], true);
    assert!(replies[0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Could not read"));
    assert!(!home.join(".albedo/inbox").exists(), "nothing is delivered");
    let _ = std::fs::remove_dir_all(&home);
}
