//! stdio transport: one JSON-RPC message per line in, one per line out.
//! Logs, if any, go to stderr; stdout carries MCP messages only. Exits when
//! stdin closes, which is how Claude Code ends a stdio server.
//!
//! stdin is read on a thread of its own, so the loop here never blocks on it:
//! a `show_preview` call (#348) waits for the user, and meanwhile the loop
//! must still take a `notifications/cancelled`, a ping or another call, and
//! look for the answer file every [`POLL`].

use albedo_mcp::{Env, Server, PARSE_ERROR};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

/// The longest request line read. A tool call is a few KB; anything this long
/// is skipped and answered with a parse error instead of being buffered.
const MAX_REQUEST_BYTES: usize = 1 << 20;

/// How often a waiting call looks for its answer. The app waits up to three
/// seconds for an answer to be taken before saying it was not.
const POLL: Duration = Duration::from_millis(250);

enum Incoming {
    Line(Vec<u8>),
    TooLong,
    Closed,
}

fn main() {
    let mut server = Server::new(Env::from_process());
    let (tx, rx) = mpsc::channel::<Incoming>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut line = Vec::new();
            let msg = match read_capped_line(&mut input, &mut line, MAX_REQUEST_BYTES) {
                Ok(Read::Eof) => Incoming::Closed,
                Ok(Read::Line) => Incoming::Line(line),
                Ok(Read::TooLong) => Incoming::TooLong,
                Err(e) => {
                    eprintln!("albedo-mcp: stdin: {e}");
                    Incoming::Closed
                }
            };
            let closed = matches!(msg, Incoming::Closed);
            if tx.send(msg).is_err() || closed {
                return;
            }
        }
    });

    let mut out = io::stdout().lock();
    loop {
        let reply = match rx.recv_timeout(POLL) {
            Ok(Incoming::Line(line)) => server.handle_line(&line),
            Ok(Incoming::TooLong) => Some(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {"code": PARSE_ERROR, "message": format!("Message longer than {MAX_REQUEST_BYTES} bytes")},
            })),
            Ok(Incoming::Closed) | Err(RecvTimeoutError::Disconnected) => {
                // Claude Code is gone: record every waiting call as cancelled.
                server.shutdown();
                return;
            }
            Err(RecvTimeoutError::Timeout) => None,
        };
        let answers = if server.waiting() {
            server.poll()
        } else {
            Vec::new()
        };
        for r in reply.into_iter().chain(answers) {
            if !write_line(&mut out, &r) {
                server.shutdown();
                return; // the client is gone
            }
        }
    }
}

/// One message, one line. False when stdout is closed.
fn write_line(out: &mut impl Write, msg: &Value) -> bool {
    let mut bytes = match serde_json::to_vec(msg) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("albedo-mcp: could not encode a reply: {e}");
            return true;
        }
    };
    bytes.push(b'\n');
    out.write_all(&bytes).and_then(|()| out.flush()).is_ok()
}

enum Read {
    Line,
    TooLong,
    Eof,
}

/// Read up to and including the next `\n` into `buf` (without it). A line over
/// `cap` is consumed to its end and reported as too long, never kept whole.
fn read_capped_line(r: &mut impl BufRead, buf: &mut Vec<u8>, cap: usize) -> io::Result<Read> {
    let mut too_long = false;
    let mut any = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if !any {
                Read::Eof
            } else if too_long {
                Read::TooLong
            } else {
                Read::Line
            });
        }
        any = true;
        let (take, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        let body = &chunk[..if done { take - 1 } else { take }];
        if !too_long {
            if buf.len() + body.len() > cap {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(body);
            }
        }
        r.consume(take);
        if done {
            return Ok(if too_long { Read::TooLong } else { Read::Line });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_split_and_long_ones_skipped_whole() {
        let data = b"short\n0123456789abcdef\nok".to_vec();
        let mut r = io::BufReader::with_capacity(4, &data[..]);
        let mut buf = Vec::new();
        assert!(matches!(
            read_capped_line(&mut r, &mut buf, 8).unwrap(),
            Read::Line
        ));
        assert_eq!(buf, b"short");
        buf.clear();
        assert!(matches!(
            read_capped_line(&mut r, &mut buf, 8).unwrap(),
            Read::TooLong
        ));
        buf.clear();
        assert!(matches!(
            read_capped_line(&mut r, &mut buf, 8).unwrap(),
            Read::Line
        ));
        assert_eq!(buf, b"ok");
        buf.clear();
        assert!(matches!(
            read_capped_line(&mut r, &mut buf, 8).unwrap(),
            Read::Eof
        ));
    }
}
