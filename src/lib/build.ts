/**
 * What build is running: the commit, whether the tree was dirty, and when it
 * was built. Injected by vite.config.ts; absent under vitest, which does not
 * use that config.
 */

interface BuildInfo {
  sha: string;
  dirty: boolean;
  /** ISO time of the build. */
  at: string;
}

declare const __ALBEDO_BUILD__: BuildInfo | null | undefined;

export const BUILD: BuildInfo | null = typeof __ALBEDO_BUILD__ !== 'undefined' ? (__ALBEDO_BUILD__ ?? null) : null;

/** `377ae12 · 20 Oct 15:30`, with `+` after the commit when the tree was dirty. */
export function buildLabel(b: BuildInfo | null = BUILD): string {
  if (!b) return 'Build Unknown';
  const at = new Date(b.at);
  const when = Number.isNaN(at.getTime())
    ? ''
    : ` · ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  return `${b.sha}${b.dirty ? '+' : ''}${when}`;
}
