//! The line format is shared with the app: `src/capture/inbox.ts` reads what
//! this crate writes. `src/capture/fixtures/mcp-inbox.jsonl` holds lines made
//! here, and `inbox.test.ts` parses the same file, so a change on either side
//! that the other does not follow fails a test.
//!
//! Regenerate after a deliberate format change:
//!   ALBEDO_WRITE_FIXTURE=1 cargo test -p albedo-mcp --test contract

use albedo_mcp::{inbox, tools};
use serde_json::json;

const NOW: i64 = 1_793_692_800_000; // 2026-11-03T08:00:00Z
const TASK: u64 = 12;

fn lines() -> String {
    let calls = [
        (
            "create_reminder",
            json!({"text": "Check the staging deploy", "due": "2026-11-03T10:30:00+01:00", "summary": "Deployed build 41.\nNext: smoke test /checkout, then close the PR."}),
        ),
        (
            "request_session",
            json!({"title": "Fix the flaky export test", "prompt": "ExportTest::testCsv fails about one run in five.\n\nFind out why and fix it.", "reason": "Unrelated to this task.", "project": "albedo", "branch": "fix/flaky-export", "start": "fork"}),
        ),
        (
            "request_session",
            json!({"title": "Short one", "prompt": "Do it.", "reason": "Because."}),
        ),
        (
            "notify_blocked",
            json!({"message": "I need the staging database password to go on."}),
        ),
        (
            "set_task_summary",
            json!({"summary": "Import pictures from a URL"}),
        ),
    ];
    let mut out = String::new();
    for (i, (tool, args)) in calls.iter().enumerate() {
        let a = tools::validate(tool, Some(args), NOW).expect("fixture calls are valid");
        let bytes = inbox::line(TASK, a.tool, a.args, NOW, &format!("fixture-{}", i + 1)).unwrap();
        out.push_str(std::str::from_utf8(&bytes).unwrap());
    }
    out
}

#[test]
fn the_apps_fixture_is_exactly_what_this_crate_writes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/capture/fixtures/mcp-inbox.jsonl");
    let expected = lines();
    if std::env::var_os("ALBEDO_WRITE_FIXTURE").is_some() {
        std::fs::write(&path, &expected).unwrap();
    }
    let actual = std::fs::read_to_string(&path).expect("fixture present");
    assert_eq!(
        actual, expected,
        "regenerate with ALBEDO_WRITE_FIXTURE=1 if the change is deliberate"
    );
}

/// `show_preview` (#348): its line as `Server::call` writes it (the session's
/// path taken out, Claude Code's tool_use id put in), and the cancel record
/// as `Server::cancel` writes it. `inbox.test.ts` reads `mcp-preview.jsonl`.
fn preview_lines() -> String {
    let mut a = tools::validate(
        tools::SHOW_PREVIEW,
        Some(&json!({"path": "/tmp/row.html", "title": "Proposed row", "question": "Does the popover read as attached to the row?\nBe blunt.", "note": "Buttons moved onto the row"})),
        NOW,
    )
    .expect("a valid call");
    a.args.remove("path");
    a.args.insert("toolUseId".into(), "toolu_01ABCdef".into());
    let mut out = String::new();
    let call = inbox::line(TASK, a.tool, a.args, NOW, "fixture-p1").unwrap();
    out.push_str(std::str::from_utf8(&call).unwrap());
    let mut c = serde_json::Map::new();
    c.insert("request".into(), "fixture-p1".into());
    c.insert(
        "reason".into(),
        albedo_mcp::preview::clean_reason(Some("AbortError: user-cancel")).into(),
    );
    let cancel = inbox::line(TASK, inbox::PREVIEW_CANCELLED, c, NOW + 1, "fixture-p2").unwrap();
    out.push_str(std::str::from_utf8(&cancel).unwrap());
    out
}

#[test]
fn the_apps_preview_fixture_is_exactly_what_this_crate_writes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/capture/fixtures/mcp-preview.jsonl");
    let expected = preview_lines();
    if std::env::var_os("ALBEDO_WRITE_FIXTURE").is_some() {
        std::fs::write(&path, &expected).unwrap();
    }
    let actual = std::fs::read_to_string(&path).expect("fixture present");
    assert_eq!(
        actual, expected,
        "regenerate with ALBEDO_WRITE_FIXTURE=1 if the change is deliberate"
    );
}

/// The GitHub tools (#427): each line as `Server::call` writes it, and the
/// cancel record. `inbox.test.ts` reads `mcp-github.jsonl`.
fn github_lines() -> String {
    let calls = [
        (tools::LIST_GITHUB_DRAFTS, json!({})),
        (
            tools::DELETE_GITHUB_DRAFT,
            json!({"id": 41, "reason": "Same point as the draft on line 58"}),
        ),
        (tools::DELETE_GITHUB_DRAFT, json!({"id": "42"})),
        (tools::LIST_POSTED_COMMENTS, json!({})),
        (
            tools::DELETE_POSTED_COMMENT,
            json!({"id": 1834567890u64, "reason": "Already fixed in the latest commit"}),
        ),
    ];
    const TOKEN: &str = "0f1e2d3c4b5a69788796a5b4";
    let mut out = String::new();
    for (i, (tool, args)) in calls.iter().enumerate() {
        let mut a = tools::validate(tool, Some(args), NOW).expect("fixture calls are valid");
        // As `Server::call` adds it for a posted comment's deletion.
        if a.tool == tools::DELETE_POSTED_COMMENT {
            a.args.insert("toolUseId".into(), "toolu_01DEL".into());
        }
        let bytes = inbox::line_with_token(
            TASK,
            a.tool,
            a.args,
            NOW,
            &format!("fixture-g{}", i + 1),
            Some(TOKEN),
        )
        .unwrap();
        out.push_str(std::str::from_utf8(&bytes).unwrap());
    }
    let mut c = serde_json::Map::new();
    c.insert("request".into(), "fixture-g5".into());
    c.insert(
        "reason".into(),
        albedo_mcp::preview::clean_reason(Some("AbortError: user-cancel")).into(),
    );
    let cancel = inbox::line_with_token(
        TASK,
        inbox::GITHUB_CANCELLED,
        c,
        NOW + 1,
        "fixture-g6",
        Some(TOKEN),
    )
    .unwrap();
    out.push_str(std::str::from_utf8(&cancel).unwrap());
    out
}

#[test]
fn the_apps_github_fixture_is_exactly_what_this_crate_writes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/capture/fixtures/mcp-github.jsonl");
    let expected = github_lines();
    if std::env::var_os("ALBEDO_WRITE_FIXTURE").is_some() {
        std::fs::write(&path, &expected).unwrap();
    }
    let actual = std::fs::read_to_string(&path).expect("fixture present");
    assert_eq!(
        actual, expected,
        "regenerate with ALBEDO_WRITE_FIXTURE=1 if the change is deliberate"
    );
}
