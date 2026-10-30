//! The three tools: what Claude is told about them, and what a call must hold.
//!
//! Every limit here is repeated in `src/capture/inbox.ts`, which checks each
//! line again: this process runs inside the session, so the app never takes
//! its word for anything.

use serde_json::{json, Map, Value};

/// Longest values, in characters. Generous for what each field is for, and
/// small enough that a whole line stays one write (see `inbox::MAX_LINE_BYTES`).
pub const MAX_REMINDER_TEXT: usize = 500;
pub const MAX_REMINDER_SUMMARY: usize = 4_000;
pub const MAX_DUE: usize = 64;
pub const MAX_TITLE: usize = 120;
pub const MAX_PROMPT: usize = 16_000;
pub const MAX_REASON: usize = 1_000;
pub const MAX_PROJECT: usize = 200;
pub const MAX_BRANCH: usize = 200;
pub const MAX_MESSAGE: usize = 1_000;

/// A reminder further out than this is a typo more often than a plan.
pub const MAX_DUE_AHEAD_MS: i64 = 366 * 24 * 60 * 60 * 1000;
/// A little slack for a due time computed a moment ago and sent late.
pub const DUE_PAST_SLACK_MS: i64 = 5 * 60 * 1000;

pub const CREATE_REMINDER: &str = "create_reminder";
pub const REQUEST_SESSION: &str = "request_session";
pub const NOTIFY_BLOCKED: &str = "notify_blocked";

/// The `tools/list` result's `tools`, in a fixed order.
pub fn definitions() -> Value {
    json!([
        {
            "name": CREATE_REMINDER,
            "title": "Ask Albedo for a reminder",
            "description": "Ask Albedo to remind the user about this task at a given time. Use it when the work has to \
                continue later (waiting on a deploy, a review, a colleague) and the user should come back to it. \
                `due` must be an ISO 8601 date-time WITH a UTC offset, e.g. 2026-11-03T09:00:00+01:00; relative \
                times like \"in 2h\" are refused, so run `date` first and compute it. `summary` is your own brief \
                for whoever picks this up later, possibly a fresh session with none of this context: what was done, \
                what is left, where to look. The reminder belongs to this task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "What to remind the user of, one line.", "maxLength": MAX_REMINDER_TEXT},
                    "due": {"type": "string", "description": "ISO 8601 date-time with offset, e.g. 2026-11-03T09:00:00+01:00.", "maxLength": MAX_DUE},
                    "summary": {"type": "string", "description": "Brief for a future session: state, next steps, pointers.", "maxLength": MAX_REMINDER_SUMMARY}
                },
                "required": ["text", "due", "summary"],
                "additionalProperties": false
            }
        },
        {
            "name": REQUEST_SESSION,
            "title": "Ask the user to start a new session",
            "description": "Ask the user to start a separate Albedo task for work that does not belong in this session \
                (a follow-up, an unrelated bug you found, work in another project). Nothing starts on its own: the \
                request waits in Albedo until the user approves or denies it, and you are not told which. If they \
                approve, `prompt` becomes the new task's first message, unsent, for them to edit. Write `prompt` so \
                that it stands alone -- the new session has none of this conversation. Do not use it to hand off the \
                work of this session, and do not ask twice for the same thing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The new task's title, short.", "maxLength": MAX_TITLE},
                    "prompt": {"type": "string", "description": "The new session's opening message, self-contained.", "maxLength": MAX_PROMPT},
                    "reason": {"type": "string", "description": "Why it should be a separate session, for the user deciding.", "maxLength": MAX_REASON},
                    "project": {"type": "string", "description": "Albedo project name, if not this task's project.", "maxLength": MAX_PROJECT},
                    "branch": {"type": "string", "description": "A branch to suggest for the new task.", "maxLength": MAX_BRANCH}
                },
                "required": ["title", "prompt", "reason"],
                "additionalProperties": false
            }
        },
        {
            "name": NOTIFY_BLOCKED,
            "title": "Tell the user you are blocked",
            "description": "Tell the user, through Albedo, that this session cannot go on without them, for a reason \
                Claude Code does not show as a prompt: a credential or access only they have, a decision outside \
                this session, something to do by hand. Albedo marks the task and may show a notification. Do NOT \
                use it for permission prompts or for questions you ask in the conversation -- Albedo already sees \
                those. Say in `message` exactly what you need.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "What you need from the user, one or two sentences.", "maxLength": MAX_MESSAGE}
                },
                "required": ["message"],
                "additionalProperties": false
            }
        }
    ])
}

/// A validated call: the arguments exactly as they will be written, and what
/// the agent is told once they are.
#[derive(Debug, PartialEq)]
pub struct Accepted {
    pub tool: &'static str,
    pub args: Map<String, Value>,
    pub reply: String,
}

/// Check one call. `Err` is a sentence for the model, so it can correct itself.
pub fn validate(name: &str, args: Option<&Value>, now_ms: i64) -> Result<Accepted, String> {
    let empty = Map::new();
    let args = match args {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(m)) => m,
        Some(_) => return Err("`arguments` must be an object.".into()),
    };
    match name {
        CREATE_REMINDER => {
            only(args, &["text", "due", "summary"])?;
            let text = field(args, "text", MAX_REMINDER_TEXT, Lines::One)?;
            let due = field(args, "due", MAX_DUE, Lines::One)?;
            let summary = field(args, "summary", MAX_REMINDER_SUMMARY, Lines::Many)?;
            let due_ms = crate::due::parse_due(&due)?;
            if due_ms < now_ms - DUE_PAST_SLACK_MS {
                return Err(format!(
                    "`due` ({due}) is in the past. Run `date` for the current time."
                ));
            }
            if due_ms > now_ms + MAX_DUE_AHEAD_MS {
                return Err(format!("`due` ({due}) is more than a year away."));
            }
            let reply = format!(
                "Reminder requested for {due}. It is Albedo's to set and show; you do not need to track it."
            );
            let mut out = Map::new();
            out.insert("text".into(), text.into());
            out.insert("due".into(), due.into());
            out.insert("dueMs".into(), due_ms.into());
            out.insert("summary".into(), summary.into());
            Ok(Accepted {
                tool: CREATE_REMINDER,
                args: out,
                reply,
            })
        }
        REQUEST_SESSION => {
            only(args, &["title", "prompt", "reason", "project", "branch"])?;
            let mut out = Map::new();
            out.insert(
                "title".into(),
                field(args, "title", MAX_TITLE, Lines::One)?.into(),
            );
            out.insert(
                "prompt".into(),
                field(args, "prompt", MAX_PROMPT, Lines::Many)?.into(),
            );
            out.insert(
                "reason".into(),
                field(args, "reason", MAX_REASON, Lines::Many)?.into(),
            );
            if let Some(p) = optional(args, "project", MAX_PROJECT)? {
                out.insert("project".into(), p.into());
            }
            if let Some(b) = optional(args, "branch", MAX_BRANCH)? {
                check_branch(&b)?;
                out.insert("branch".into(), b.into());
            }
            Ok(Accepted {
                tool: REQUEST_SESSION,
                args: out,
                reply: "Queued for the user's approval. Nothing starts unless they approve it in Albedo, and you \
                        will not be told the outcome; carry on with this session's own work."
                    .into(),
            })
        }
        NOTIFY_BLOCKED => {
            only(args, &["message"])?;
            let mut out = Map::new();
            out.insert(
                "message".into(),
                field(args, "message", MAX_MESSAGE, Lines::Many)?.into(),
            );
            Ok(Accepted {
                tool: NOTIFY_BLOCKED,
                args: out,
                reply: "The user has been notified.".into(),
            })
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Lines {
    One,
    Many,
}

fn only(args: &Map<String, Value>, known: &[&str]) -> Result<(), String> {
    match args.keys().find(|k| !known.contains(&k.as_str())) {
        Some(k) => Err(format!(
            "Unknown argument `{k}`. Accepted: {}.",
            known.join(", ")
        )),
        None => Ok(()),
    }
}

/// A required string, trimmed, non-empty, within `max` characters, with no
/// control characters (newlines and tabs only where several lines make sense).
fn field(args: &Map<String, Value>, key: &str, max: usize, lines: Lines) -> Result<String, String> {
    match args.get(key) {
        None | Some(Value::Null) => Err(format!("`{key}` is required.")),
        Some(Value::String(s)) => clean(key, s, max, lines),
        Some(_) => Err(format!("`{key}` must be a string.")),
    }
}

fn optional(args: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => clean(key, s, max, Lines::One).map(Some),
        Some(_) => Err(format!("`{key}` must be a string.")),
    }
}

fn clean(key: &str, s: &str, max: usize, lines: Lines) -> Result<String, String> {
    let t = s.trim();
    if t.is_empty() {
        return Err(format!("`{key}` is empty."));
    }
    let n = t.chars().count();
    if n > max {
        return Err(format!("`{key}` is {n} characters; at most {max}."));
    }
    let allowed = |c: char| lines == Lines::Many && matches!(c, '\n' | '\t');
    if t.chars().any(|c| c.is_control() && !allowed(c)) {
        return Err(format!(
            "`{key}` contains control characters{}.",
            if lines == Lines::One {
                " (it is one line)"
            } else {
                ""
            }
        ));
    }
    Ok(t.to_string())
}

/// A suggestion only -- the user picks the real branch -- but it is shown in
/// Albedo's UI, so it is held to a plain, safe shape.
fn check_branch(b: &str) -> Result<(), String> {
    let ok = !b.starts_with(['-', '/', '.'])
        && !b.ends_with(['/', '.'])
        && !b.contains("..")
        && !b.contains("//")
        && b.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "`branch` {b:?} is not a plain branch name (letters, digits, - _ . /; no leading -)."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_692_800_000; // 2026-11-03T08:00:00Z

    #[test]
    fn definitions_list_the_three_tools_in_order_with_strict_schemas() {
        let defs = definitions();
        let names: Vec<_> = defs
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, [CREATE_REMINDER, REQUEST_SESSION, NOTIFY_BLOCKED]);
        for t in defs.as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert_eq!(t["inputSchema"]["additionalProperties"], false);
        }
    }

    #[test]
    fn a_reminder_keeps_its_due_as_given_and_as_milliseconds() {
        let a = validate(
            CREATE_REMINDER,
            Some(&json!({"text": " Check the deploy ", "due": "2026-11-03T10:00:00+01:00", "summary": "Deployed\nnext: verify"})),
            NOW,
        )
        .unwrap();
        assert_eq!(a.args["text"], "Check the deploy");
        assert_eq!(a.args["due"], "2026-11-03T10:00:00+01:00");
        assert_eq!(a.args["dueMs"], NOW + 3_600_000);
        assert_eq!(a.args["summary"], "Deployed\nnext: verify");
        assert!(a
            .reply
            .starts_with("Reminder requested for 2026-11-03T10:00:00+01:00"));
    }

    #[test]
    fn a_reminder_in_the_past_or_years_away_is_refused() {
        let call = |due: &str| {
            validate(
                CREATE_REMINDER,
                Some(&json!({"text": "x", "due": due, "summary": "y"})),
                NOW,
            )
        };
        assert!(call("2026-11-03T07:00:00Z").unwrap_err().contains("past"));
        assert!(call("2026-11-03T07:58:00Z").is_ok(), "inside the slack");
        assert!(call("2028-11-03T08:00:00Z").unwrap_err().contains("year"));
        assert!(call("in 2h").unwrap_err().contains("ISO 8601"));
    }

    #[test]
    fn required_fields_types_and_unknown_arguments() {
        assert_eq!(
            validate(NOTIFY_BLOCKED, None, NOW).unwrap_err(),
            "`message` is required."
        );
        assert_eq!(
            validate(NOTIFY_BLOCKED, Some(&json!({"message": 3})), NOW).unwrap_err(),
            "`message` must be a string."
        );
        assert_eq!(
            validate(NOTIFY_BLOCKED, Some(&json!({"message": "   "})), NOW).unwrap_err(),
            "`message` is empty."
        );
        assert!(validate(
            NOTIFY_BLOCKED,
            Some(&json!({"message": "m", "task": 7})),
            NOW
        )
        .unwrap_err()
        .starts_with("Unknown argument `task`"));
        assert_eq!(
            validate(NOTIFY_BLOCKED, Some(&json!("m")), NOW).unwrap_err(),
            "`arguments` must be an object."
        );
        assert_eq!(
            validate("delete_everything", None, NOW).unwrap_err(),
            "Unknown tool: delete_everything"
        );
    }

    #[test]
    fn caps_count_characters_not_bytes() {
        let at_cap = "é".repeat(MAX_MESSAGE);
        assert!(validate(NOTIFY_BLOCKED, Some(&json!({"message": at_cap})), NOW).is_ok());
        let over = "a".repeat(MAX_MESSAGE + 1);
        let err = validate(NOTIFY_BLOCKED, Some(&json!({"message": over})), NOW).unwrap_err();
        assert!(err.contains("at most 1000"), "{err}");
    }

    #[test]
    fn one_line_fields_refuse_newlines_and_every_field_refuses_escapes() {
        let base = json!({"title": "a\nb", "prompt": "p", "reason": "r"});
        assert!(validate(REQUEST_SESSION, Some(&base), NOW)
            .unwrap_err()
            .contains("control"));
        let esc = json!({"title": "t", "prompt": "p \u{1b}[31m", "reason": "r"});
        assert!(validate(REQUEST_SESSION, Some(&esc), NOW)
            .unwrap_err()
            .contains("control"));
        let ok = json!({"title": "t", "prompt": "line 1\n\tline 2", "reason": "r"});
        assert!(validate(REQUEST_SESSION, Some(&ok), NOW).is_ok());
    }

    #[test]
    fn a_session_request_keeps_optional_fields_only_when_given() {
        let a = validate(REQUEST_SESSION, Some(&json!({"title": "T", "prompt": "P", "reason": "R", "project": " ", "branch": null})), NOW).unwrap();
        assert!(!a.args.contains_key("project") && !a.args.contains_key("branch"));
        let b = validate(REQUEST_SESSION, Some(&json!({"title": "T", "prompt": "P", "reason": "R", "project": "albedo", "branch": "fix/login-2"})), NOW).unwrap();
        assert_eq!(b.args["project"], "albedo");
        assert_eq!(b.args["branch"], "fix/login-2");
        assert!(b.reply.starts_with("Queued for the user's approval"));
    }

    #[test]
    fn branch_suggestions_are_plain_names() {
        for bad in ["-rf", "a b", "a..b", "x/", "/x", "feat;rm", "ü"] {
            let r = validate(
                REQUEST_SESSION,
                Some(&json!({"title": "T", "prompt": "P", "reason": "R", "branch": bad})),
                NOW,
            );
            assert!(r.is_err(), "{bad} should be refused");
        }
    }
}
