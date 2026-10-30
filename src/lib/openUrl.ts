import { Command } from '@tauri-apps/plugin-shell';
import { detectPlatform, urlOpener, type Platform } from './platform';
import { safeHttpUrl } from './urls';

/**
 * Open an http(s) URL in the default browser: `open` on macOS, `xdg-open` on
 * Linux. Anything else is refused here as well as at the call sites, so no
 * path reaches either with another scheme.
 */
export async function openExternal(raw: string): Promise<void> {
  const url = safeHttpUrl(raw);
  if (url === null) return;
  try {
    await Command.create(urlOpener(), [url]).execute();
  } catch (err) {
    console.warn('[links] could not open', url, err);
  }
}

/** What the platform calls showing a file in its file manager. */
export function revealLabel(p: Platform = detectPlatform()): string {
  return p === 'macos' ? 'Reveal in Finder' : 'Show in Folder';
}

/**
 * Show a file in the file manager: `open -R` on macOS selects it in Finder;
 * elsewhere `xdg-open` on its folder, which is as far as a portable desktop
 * goes. Only an absolute path, so nothing can read as an option. Uses the
 * `open`/`xdg-open` entries the URL opener already has.
 */
export async function revealInFileManager(absolute: string, p: Platform = detectPlatform()): Promise<void> {
  if (!absolute.startsWith('/')) return;
  const folder = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
  const args = p === 'macos' ? ['-R', absolute] : [folder];
  try {
    const out = await Command.create(urlOpener(p), args).execute();
    if (out.code !== 0) console.warn('[links] could not reveal', absolute, out.stderr);
  } catch (err) {
    console.warn('[links] could not reveal', absolute, err);
  }
}
