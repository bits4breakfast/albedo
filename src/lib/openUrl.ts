import { Command } from '@tauri-apps/plugin-shell';
import { safeHttpUrl } from './urls';

/**
 * Open an http(s) URL in the default browser. Anything else is refused here
 * as well as at the call sites, so no path reaches `open` with another scheme.
 */
export async function openExternal(raw: string): Promise<void> {
  const url = safeHttpUrl(raw);
  if (url === null) return;
  try {
    await Command.create('open', [url]).execute();
  } catch (err) {
    console.warn('[links] could not open', url, err);
  }
}
