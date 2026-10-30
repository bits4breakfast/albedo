//! stdio transport: one JSON-RPC message per line in, one per line out.
//! Logs, if any, go to stderr; stdout carries MCP messages only. Exits when
//! stdin closes, which is how Claude Code ends a stdio server.

use albedo_mcp::{Env, Server, PARSE_ERROR};
use serde_json::json;
use std::io::{self, BufRead, Write};

/// The longest request line read. A tool call is a few KB; anything this long
/// is skipped and answered with a parse error instead of being buffered.
const MAX_REQUEST_BYTES: usize = 1 << 20;

fn main() {
    let mut server = Server::new(Env::from_process());
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut out = io::stdout().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        let reply = match read_capped_line(&mut input, &mut line, MAX_REQUEST_BYTES) {
            Ok(Read::Eof) => return,
            Ok(Read::Line) => server.handle_line(&line),
            Ok(Read::TooLong) => Some(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {"code": PARSE_ERROR, "message": format!("Message longer than {MAX_REQUEST_BYTES} bytes")},
            })),
            Err(e) => {
                eprintln!("albedo-mcp: stdin: {e}");
                return;
            }
        };
        if let Some(reply) = reply {
            let mut bytes = match serde_json::to_vec(&reply) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("albedo-mcp: could not encode a reply: {e}");
                    continue;
                }
            };
            bytes.push(b'\n');
            if out.write_all(&bytes).and_then(|()| out.flush()).is_err() {
                return; // the client is gone
            }
        }
    }
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
