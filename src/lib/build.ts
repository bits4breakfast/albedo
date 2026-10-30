/**
 * What build is running: the commit, whether the tree was dirty, and when it
 * was built -- plus the recent history What's New lists. Injected by
 * vite.config.ts (computed in buildEmbed.ts); absent under vitest, which does
 * not use that config.
 */

/** One first-parent commit, newest first in `history`. */
export interface BuildCommit {
  /** Abbreviated, as `git rev-parse --short` gives `sha`. */
  sha: string;
  /** The subject without its trailing `(#123)`. */
  subject: string;
  /** The PR it was merged as, from that trailing `(#123)`; null for a direct commit. */
  pr: number | null;
}

export interface BuildInfo {
  sha: string;
  dirty: boolean;
  /** ISO time of the build. */
  at: string;
  /** `https://github.com/<owner>/<repo>`, or null when origin is not GitHub. Absent in builds before #147. */
  repo?: string | null;
  /** The last few hundred first-parent commits, HEAD first. Empty when git could not list them. */
  history?: BuildCommit[];
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
