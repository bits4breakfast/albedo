//! Navigation stays inside the app (#348).
//!
//! The webview shows model-written HTML mockups in a sandboxed iframe
//! (`src/ui/preview/frameDoc.ts`). Their CSP blocks every fetch, but no CSP
//! governs a frame navigating itself: measured in WKWebView, a sandboxed
//! `srcdoc` frame's `location.href = …`, `<meta http-equiv="refresh">` and a
//! link click each reach the webview's navigation policy as a sub-frame
//! navigation to the remote URL, and Tauri allows every navigation unless told
//! otherwise. That is a way out to the network.
//!
//! So every navigation, in any frame, must stay on the app's own pages: the
//! bundled app (`tauri://`), the dev server on this machine, and the
//! documents a frame is made of (`about:srcdoc`, `about:blank`, `data:`,
//! `blob:`). The app's own window never navigates anywhere else -- links open
//! in the browser through the shell -- so this changes nothing for it.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// Whether a navigation to `url` may go ahead.
pub fn allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "tauri.localhost")
        ),
        _ => false,
    }
}

/// The plugin that applies [`allowed`] to every webview's navigations.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let ok = allowed(url);
            if !ok {
                eprintln!("albedo: refused a navigation to {url}");
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        allowed(&Url::parse(s).unwrap())
    }

    #[test]
    fn the_app_and_a_frames_own_documents_are_allowed() {
        assert!(ok("tauri://localhost/"));
        assert!(ok("tauri://localhost/index.html#task=3"));
        assert!(ok("http://localhost:1420/"));
        assert!(ok("http://127.0.0.1:1420/src/main.tsx"));
        assert!(ok("about:srcdoc"));
        assert!(ok("about:blank"));
        assert!(ok("data:text/html,<p>x</p>"));
    }

    #[test]
    fn anywhere_else_is_refused() {
        assert!(!ok("https://example.com/?leak=1"));
        assert!(!ok("http://example.com/"));
        assert!(!ok("https://localhost.example.com/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("ftp://example.com/"));
        assert!(!ok("javascript:alert(1)"));
    }
}
