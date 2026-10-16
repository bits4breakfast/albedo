/**
 * Whole-UI text size: Cmd+ / Cmd- / Cmd0, remembered across launches.
 *
 * Apple's HIG notes that macOS has no Dynamic Type, so an app whose people read
 * all day has to offer its own control -- Mail, Safari and Xcode all do it with
 * these keys. Implemented as webview zoom rather than by rescaling the font
 * tokens: everything (type, spacing, the terminal, icon glyphs) scales
 * together, so no layout is ever tuned for one size and broken at another.
 */

import { getCurrentWebview } from '@tauri-apps/api/webview';

/** The steps Safari uses, trimmed to the range that stays usable. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75] as const;
const KEY = 'albedo.zoom';

export function storedZoom(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return ZOOM_STEPS.includes(n as (typeof ZOOM_STEPS)[number]) ? n : 1;
  } catch {
    return 1;
  }
}

/** The next step up or down from `current`, clamped to the ends. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((z) => z >= current - 1e-9);
  const at = i < 0 ? ZOOM_STEPS.length - 1 : i;
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir));
  return ZOOM_STEPS[next] as number;
}

/** Apply and remember. Never throws: a failed zoom leaves the UI as it was. */
export async function applyZoom(z: number): Promise<void> {
  try {
    localStorage.setItem(KEY, String(z));
  } catch {
    /* not remembered */
  }
  try {
    await getCurrentWebview().setZoom(z);
  } catch (err) {
    console.warn('[zoom] could not set zoom', err);
  }
}
