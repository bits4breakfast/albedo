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
//! bundled app (`tauri://`), and the documents a frame is made of
//! (`about:srcdoc`, `about:blank`, `data:`, `blob:`). The app's own window
//! never navigates anywhere else -- links open in the browser through the
//! shell -- so this changes nothing for it.
//!
//! http(s) is allowed only to the dev server, and only in a debug build
//! (#360): its origin is `build.devUrl` in tauri.conf.json, so a mockup cannot
//! reach anything else listening on this machine -- another dev server, a
//! Docker API, an admin panel. A release build loads only `tauri://` and
//! allows no http at all. `http(s)://tauri.localhost` is the app's own origin
//! only on Windows, where it is served by the webview, not the network;
//! anywhere else it is an ordinary loopback host and stays refused.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// Whether a navigation to `url` may go ahead. `dev_server` is the dev
/// server's URL in a debug build and `None` in a release build.
pub fn allowed(url: &Url, dev_server: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            (cfg!(windows) && url.host_str() == Some("tauri.localhost"))
                || dev_server.is_some_and(|dev| same_origin(url, dev))
        }
        _ => false,
    }
}

/// Same scheme, host and port. `localhost`, `127.0.0.1` and `[::1]` count as
/// one host: the dev server answers on whichever loopback name the page uses.
fn same_origin(a: &Url, b: &Url) -> bool {
    fn loopback(host: Option<&str>) -> bool {
        matches!(host, Some("localhost" | "127.0.0.1" | "[::1]"))
    }
    a.scheme() == b.scheme()
        && a.port_or_known_default() == b.port_or_known_default()
        && (a.host_str() == b.host_str() || (loopback(a.host_str()) && loopback(b.host_str())))
}

/// The dev server's URL in a debug build; `None` in a release build, which
/// never loads one.
fn dev_server<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// The plugin that applies [`allowed`] to every webview's navigations.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let ok = allowed(url, dev_server(webview.app_handle()).as_ref());
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

    fn dev() -> Url {
        Url::parse("http://localhost:1420").unwrap()
    }

    /// As a release build sees it: no dev server.
    fn ok(s: &str) -> bool {
        allowed(&Url::parse(s).unwrap(), None)
    }

    /// As a debug build sees it, with tauri.conf.json's devUrl.
    fn ok_in_dev(s: &str) -> bool {
        allowed(&Url::parse(s).unwrap(), Some(&dev()))
    }

    #[test]
    fn the_app_and_a_frames_own_documents_are_allowed() {
        for s in [
            "tauri://localhost/",
            "tauri://localhost/index.html#task=3",
            "about:srcdoc",
            "about:blank",
            "data:text/html,<p>x</p>",
        ] {
            assert!(ok(s), "{s}");
            assert!(ok_in_dev(s), "{s}");
        }
    }

    #[test]
    fn a_debug_build_allows_the_dev_server_and_nothing_else_local() {
        assert!(ok_in_dev("http://localhost:1420/"));
        assert!(ok_in_dev("http://localhost:1420/src/main.tsx"));
        assert!(ok_in_dev("http://127.0.0.1:1420/src/main.tsx"));
        assert!(ok_in_dev("http://[::1]:1420/"));
        // Another port, another scheme, or no port at all is someone else.
        assert!(!ok_in_dev("http://localhost:2375/containers/json"));
        assert!(!ok_in_dev("http://127.0.0.1:8080/admin"));
        assert!(!ok_in_dev("http://localhost/"));
        assert!(!ok_in_dev("https://localhost:1420/"));
        assert!(!ok_in_dev("http://example.com:1420/"));
    }

    #[test]
    fn a_release_build_allows_no_http_at_all() {
        assert!(!ok("http://localhost:1420/"));
        assert!(!ok("http://127.0.0.1:1420/"));
        assert!(!ok("http://localhost:2375/"));
        assert!(!ok("http://[::1]:8080/"));
    }

    #[test]
    fn tauri_localhost_is_the_app_only_on_windows() {
        assert_eq!(ok("http://tauri.localhost/"), cfg!(windows));
        assert_eq!(ok("https://tauri.localhost/"), cfg!(windows));
        assert_eq!(ok_in_dev("http://tauri.localhost/"), cfg!(windows));
    }

    #[test]
    fn anywhere_else_is_refused() {
        for s in [
            "https://example.com/?leak=1",
            "http://example.com/",
            "https://localhost.example.com/",
            "file:///etc/passwd",
            "ftp://example.com/",
            "javascript:alert(1)",
        ] {
            assert!(!ok(s), "{s}");
            assert!(!ok_in_dev(s), "{s}");
        }
    }

    #[test]
    fn the_configured_dev_url_is_the_one_tested_here() {
        // If devUrl moves, the guard follows it at runtime; this keeps the
        // tests above honest about which port they mean.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["build"]["devUrl"], "http://localhost:1420");
    }
}
