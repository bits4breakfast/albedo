//! The native half of `src/ui/attention.ts`: system notifications through
//! `UNUserNotificationCenter`, and a dock bounce that stops on its own.
//!
//! ## The bounce
//!
//! A critical bounce runs until the app is activated, and Tauri cannot stop
//! one it started: tao ignores `requestUserAttention(null)`. So the bounce is
//! asked for here, where the request id `cancelUserAttentionRequest` needs is
//! at hand, and cancelled after `CRITICAL_BOUNCE`. An informational bounce is
//! a single hop and needs nothing.
//!
//! ## Notifications
//!
//! `tauri-plugin-notification` 2.4 cannot deliver on macOS 26: it answers every
//! permission question with a hard-coded "granted" (so macOS is never asked),
//! posts through the deprecated `NSUserNotificationCenter` that no longer
//! delivers, and discards the error. Albedo never appeared in System Settings
//! -> Notifications. This module asks macOS for real, posts with the current
//! API, and reports failures instead of swallowing them.
//!
//! macOS grants notifications only to an app with a real signing identity: an
//! ad-hoc signed bundle is refused outright ("Notifications are not allowed
//! for this application"). `build.sh` signs with an Apple Development
//! certificate when one is installed; without one, `notify_permission` says
//! `denied` and the UI says why.
//!
//! Clicking a banner brings the window forward and emits
//! `albedo://notification-clicked` with the task id the banner was posted for.
//!
//! The plugin is still what `tauri dev` uses: a bare binary outside an `.app`
//! has no bundle, and `UNUserNotificationCenter` raises an Objective-C
//! exception without one -- so outside a bundle every command here answers
//! `unsupported` and never touches the center.

/// The event a banner click emits, carrying the task id (or null).
pub const CLICKED_EVENT: &str = "albedo://notification-clicked";

/// How long a critical bounce lasts before it is cancelled.
pub const CRITICAL_BOUNCE: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::mpsc;
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSRequestUserAttentionType};
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSUUID};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Manager};

    /// The key under which a banner carries its task id.
    const TASK_KEY: &str = "taskId";

    /// Only an `.app` bundle has the bundle identity the center needs.
    pub fn bundled() -> bool {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(false)
    }

    pub struct Ivars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the class
        // implements no `dealloc`.
        #[unsafe(super(NSObject))]
        #[thread_kind = AllocAnyThread]
        #[name = "AlbedoNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                let info = response.notification().request().content().userInfo();
                let task_id = info
                    .objectForKey(&NSString::from_str(TASK_KEY))
                    .and_then(|v| v.downcast::<NSNumber>().ok())
                    .map(|n| n.as_i64());
                let app = &self.ivars().app;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit(super::CLICKED_EVENT, task_id);
                completion.call(());
            }
        }
    );

    /// The center holds its delegate weakly; this keeps ours alive.
    static DELEGATE: OnceLock<Retained<Delegate>> = OnceLock::new();

    pub fn install(app: &AppHandle) {
        if !bundled() {
            return;
        }
        let delegate = DELEGATE.get_or_init(|| {
            let this = Delegate::alloc().set_ivars(Ivars { app: app.clone() });
            // SAFETY: NSObject's `init` on a freshly allocated subclass.
            unsafe { msg_send![super(this), init] }
        });
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    }

    /// Bounce, and cancel a critical bounce after `CRITICAL_BOUNCE`. macOS
    /// ignores the request while the app is active and stops it when the app
    /// is activated, so cancelling one that already ended is harmless.
    pub fn bounce(app: &AppHandle, critical: bool) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let id = NSApplication::sharedApplication(mtm).requestUserAttention(if critical {
                NSRequestUserAttentionType::CriticalRequest
            } else {
                NSRequestUserAttentionType::InformationalRequest
            });
            if !critical || id == 0 {
                return;
            }
            std::thread::spawn(move || {
                std::thread::sleep(super::CRITICAL_BOUNCE);
                let _ = handle.run_on_main_thread(move || {
                    if let Some(mtm) = MainThreadMarker::new() {
                        NSApplication::sharedApplication(mtm).cancelUserAttentionRequest(id);
                    }
                });
            });
        });
    }

    fn describe(err: *mut NSError) -> Option<String> {
        // SAFETY: the completion handlers pass a valid NSError or null.
        unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string())
    }

    /// Ask macOS once; afterwards it answers from the stored choice without a
    /// prompt. `Ok(false)` is a refusal, by the user or by macOS itself.
    pub fn request_permission() -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            let _ = tx.send((granted.as_bool(), describe(err)));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &handler,
            );
        match rx.recv() {
            Ok((true, _)) => Ok(true),
            Ok((false, None)) => Ok(false),
            Ok((false, Some(why))) => Err(why),
            Err(_) => Err("macOS never answered the permission request".into()),
        }
    }

    pub fn post(title: &str, body: &str, task_id: Option<i64>) -> Result<(), String> {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        if let Some(id) = task_id {
            let info = NSDictionary::from_retained_objects(
                &[&*NSString::from_str(TASK_KEY)],
                &[Retained::into_super(Retained::into_super(
                    NSNumber::new_i64(id),
                ))],
            );
            // SAFETY: a property-list dictionary (string key, number value),
            // which is all userInfo requires. The cast only erases generics.
            let info: &NSDictionary<AnyObject, AnyObject> =
                unsafe { &*(Retained::as_ptr(&info) as *const NSDictionary<AnyObject, AnyObject>) };
            unsafe { content.setUserInfo(info) };
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSUUID::new().UUIDString(),
            &content,
            None,
        );
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |err: *mut NSError| {
            let _ = tx.send(describe(err));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&handler));
        match rx.recv() {
            Ok(None) => Ok(()),
            Ok(Some(why)) => Err(why),
            Err(_) => Err("macOS never confirmed the notification".into()),
        }
    }
}

/// Register the click handler. A no-op outside a macOS `.app`.
pub fn install(_app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::install(_app);
}

/// Bounce the dock: once, or for `CRITICAL_BOUNCE` when `critical`.
#[tauri::command]
pub fn attention_bounce(app: tauri::AppHandle, critical: bool) {
    #[cfg(target_os = "macos")]
    mac::bounce(&app, critical);
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{Manager, UserAttentionType};
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.request_user_attention(Some(if critical {
                UserAttentionType::Critical
            } else {
                UserAttentionType::Informational
            }));
        }
    }
}

/// `"granted"`, `"denied"`, or `"unsupported"` (not macOS, or not running
/// from an `.app` bundle -- the caller falls back to the plugin).
///
/// The first call shows macOS's prompt; later calls answer from the stored
/// choice. Errors carry macOS's own reason, which for an ad-hoc signed build
/// is "Notifications are not allowed for this application".
#[tauri::command]
pub async fn notify_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if !mac::bundled() {
            return Ok("unsupported".into());
        }
        let granted = tauri::async_runtime::spawn_blocking(mac::request_permission)
            .await
            .map_err(|e| e.to_string())??;
        Ok(if granted { "granted" } else { "denied" }.into())
    }
    #[cfg(not(target_os = "macos"))]
    Ok("unsupported".into())
}

/// Post one banner. `task_id` comes back in `albedo://notification-clicked`.
#[tauri::command]
pub async fn notify_post(title: String, body: String, task_id: Option<i64>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !mac::bundled() {
            return Err("unsupported".into());
        }
        tauri::async_runtime::spawn_blocking(move || mac::post(&title, &body, task_id))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body, task_id);
        Err("unsupported".into())
    }
}
