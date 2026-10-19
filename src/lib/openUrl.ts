import { Command } from '@tauri-apps/plugin-shell';
import { urlOpener } from './platform';
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
