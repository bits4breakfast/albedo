//! Keep the Mac awake while tasks run (#283); the webview decides when
//! (`src/ui/keepAwake.ts`).
//!
//! At most one `NSProcessInfo` activity, begun with `NSActivityUserInitiated`:
//! it disables idle system sleep and App Nap for Albedo. The display may still
//! sleep, and closing the lid still sleeps the Mac. `pmset -g assertions`
//! lists it as a `PreventUserIdleSystemSleep` assertion with the reason given.
//!
//! Ended when the webview says so, and on exit (`release`, from the run
//! loop's `Exit`). A crash ends it too: the OS drops a process's activities
//! with the process. Elsewhere than macOS every call is a no-op.

use parking_lot::Mutex;

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// The token `beginActivityWithOptions:reason:` returns; the activity lasts
    /// as long as it is retained and not passed to `endActivity:`.
    pub struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: the token is an opaque object that is never messaged; it is only
    // handed back to `-[NSProcessInfo endActivity:]`, and Apple documents the
    // NSProcessInfo activity API as safe to call from any thread. Retain and
    // release are atomic.
    unsafe impl Send for Activity {}

    pub fn begin(reason: &str) -> Activity {
        let info = NSProcessInfo::processInfo();
        Activity(info.beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiated,
            &NSString::from_str(reason),
        ))
    }

    pub fn end(activity: Activity) {
        let info = NSProcessInfo::processInfo();
        // SAFETY: the token came from `beginActivityWithOptions:reason:` and
        // is ended once: `end` takes it by value.
        unsafe { info.endActivity(&activity.0) };
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub struct Activity;

    pub fn begin(_reason: &str) -> Activity {
        Activity
    }

    pub fn end(_activity: Activity) {}
}

/// The activity held, with the reason it was begun with.
#[derive(Default)]
pub struct KeepAwake {
    held: Mutex<Option<(platform::Activity, String)>>,
}

impl KeepAwake {
    /// Hold (with `reason`) or release. Idempotent both ways. A new reason
    /// while held begins the new activity before ending the old one, so there
    /// is no moment with none.
    pub fn set(&self, on: bool, reason: &str) {
        let mut held = self.held.lock();
        if !on {
            if let Some((activity, _)) = held.take() {
                platform::end(activity);
            }
            return;
        }
        if held.as_ref().is_some_and(|(_, r)| r == reason) {
            return;
        }
        let previous = held.replace((platform::begin(reason), reason.to_owned()));
        if let Some((activity, _)) = previous {
            platform::end(activity);
        }
    }

    pub fn release(&self) {
        self.set(false, "");
    }

    /// The reason held, if any.
    #[cfg(test)]
    pub fn reason(&self) -> Option<String> {
        self.held.lock().as_ref().map(|(_, r)| r.clone())
    }
}

#[tauri::command]
pub fn set_keep_awake(state: tauri::State<'_, KeepAwake>, on: bool, reason: String) {
    state.set(on, &reason);
}

#[cfg(test)]
mod tests {
    use super::KeepAwake;

    #[test]
    fn holds_once_and_releases_idempotently() {
        let k = KeepAwake::default();
        assert_eq!(k.reason(), None);
        k.release();
        assert_eq!(k.reason(), None);

        k.set(true, "1 Claude Code task running");
        k.set(true, "1 Claude Code task running");
        assert_eq!(k.reason().as_deref(), Some("1 Claude Code task running"));

        k.set(true, "2 Claude Code tasks running");
        assert_eq!(k.reason().as_deref(), Some("2 Claude Code tasks running"));

        k.set(false, "");
        assert_eq!(k.reason(), None);
        k.set(false, "");
        assert_eq!(k.reason(), None);
    }

    /// The real assertion, as macOS reports it. Ignored by default: it asks
    /// the system. `cargo test --lib keep_awake -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn pmset_lists_the_assertion_while_held() {
        let assertions = || {
            let out = std::process::Command::new("pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let reason = format!("albedo keep-awake test {}", std::process::id());
        let k = KeepAwake::default();
        k.set(true, &reason);
        let held = assertions();
        let line = held.lines().find(|l| l.contains(&reason));
        assert!(
            line.is_some_and(|l| l.contains("PreventUserIdleSystemSleep")),
            "{held}"
        );
        k.release();
        assert!(!assertions().contains(&reason));
    }
}
