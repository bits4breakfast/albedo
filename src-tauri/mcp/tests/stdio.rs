//! The built binary, driven the way Claude Code drives it: a session's worth
//! of JSON-RPC lines on stdin, one reply per request on stdout, and the inbox
//! line on disk under the HOME it was given.

use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

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
            json!("notify_blocked")
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
