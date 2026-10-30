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
            json!({"title": "Fix the flaky export test", "prompt": "ExportTest::testCsv fails about one run in five.\n\nFind out why and fix it.", "reason": "Unrelated to this task.", "project": "albedo", "branch": "fix/flaky-export"}),
        ),
        (
            "request_session",
            json!({"title": "Short one", "prompt": "Do it.", "reason": "Because."}),
        ),
        (
            "notify_blocked",
            json!({"message": "I need the staging database password to go on."}),
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
