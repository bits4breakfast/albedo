/**
 * Which desktop the webview is running on, for the few places that differ by
 * configuration rather than by code: the program that opens a URL, and the
 * header space reserved for the macOS stoplights.
 *
 * Read from the user agent, not from `@tauri-apps/plugin-os`: that plugin is
 * a Rust crate, a JS package and a capability for one string the webview
 * already carries. WKWebView reports `Macintosh`; WebKitGTK reports `Linux`.
 * Anything else is `other` and gets the Linux behaviour, which is the
 * portable one (xdg-open, no stoplight padding).
 */

export type Platform = 'macos' | 'linux' | 'other';

export function detectPlatform(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): Platform {
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'other';
}

/** The program `shell:allow-execute` permits for opening a URL on this platform. */
export function urlOpener(p: Platform = detectPlatform()): 'open' | 'xdg-open' {
  return p === 'macos' ? 'open' : 'xdg-open';
}

/**
 * Stamp `data-platform` on the root element, before the first paint, so CSS
 * can gate macOS-only metrics (`--traffic-lights-w`) without a flash.
 */
export function applyPlatform(root: HTMLElement = document.documentElement): void {
  root.dataset.platform = detectPlatform();
}

/**
 * Stamp `data-fullscreen` on the root element and keep it current, so CSS can
 * drop the stoplight gutter in full screen: macOS hides the window buttons
 * there, and the 88px reserved for them left the icon and tabs adrift.
 * Best-effort: outside Tauri (tests, a browser preview) nothing happens.
 */
export async function watchFullscreen(root: HTMLElement = document.documentElement): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const apply = async () => {
      root.dataset.fullscreen = String(await win.isFullscreen());
    };
    await apply();
    // Entering or leaving full screen always resizes the window.
    await win.onResized(() => void apply());
  } catch {
    /* no Tauri window: keep the gutter */
  }
}
