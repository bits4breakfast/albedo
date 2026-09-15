/**
 * Task title -> filesystem- and git-ref-safe slug.
 *
 * Pure module: no I/O, no Tauri imports. A bad slug corrupts a branch name and
 * a directory name at the same time, so every rule here is enforced rather than
 * assumed, and the result is re-validated before it is returned.
 *
 * Owner: worktree workstream (M3).
 */

/** Slugs are capped so that `~/agents/<repo>/<slug>` stays comfortably short. */
export const MAX_SLUG_LENGTH = 40;

/** Characters we allow, after normalisation: lowercase alphanumerics and dash. */
const SLUG_CHARSET = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export interface SlugifyOptions {
  /** Hard cap on the produced slug. Defaults to {@link MAX_SLUG_LENGTH}. */
  maxLength?: number;
  /** Clock injection point, so the empty-title fallback is testable. */
  now?: number;
}

/**
 * Convert an arbitrary task title into a slug that is safe as BOTH a path
 * segment and a git branch name.
 *
 * Guarantees about the return value:
 *  - matches `[a-z0-9]([a-z0-9-]*[a-z0-9])?`
 *  - never empty (falls back to `task-<timestamp>`)
 *  - no leading dash (git would read it as an option) and no trailing dash
 *  - no `..`, no `@{`, no trailing `.lock`, no dot at all
 *  - length <= maxLength (except the fallback, which is bounded anyway)
 */
export function slugify(title: string, opts: SlugifyOptions = {}): string {
  const maxLength = Math.max(1, opts.maxLength ?? MAX_SLUG_LENGTH);

  const folded = (title ?? '')
    // Decompose accents so "Café" -> "cafe" rather than "caf".
    .normalize('NFKD')
    // Strip combining marks left behind by the decomposition.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  let slug = folded
    // Anything that is not a-z0-9 becomes a separator. This single rule kills
    // spaces, slashes, `~^:?*[\`, control characters, `@{`, quotes and dots.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, '');
  }

  if (slug.length === 0) {
    slug = `task-${opts.now ?? Date.now()}`;
  }

  // Belt and braces: if any rule above is ever relaxed, fail loudly here rather
  // than handing git a hostile ref name.
  if (!isSafeSlug(slug)) {
    throw new Error(`slugify produced an unsafe slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/**
 * True when `s` is safe to use unquoted as a path segment and a branch name.
 * Deliberately stricter than git's own rules -- it is cheap to be strict here.
 */
export function isSafeSlug(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (!SLUG_CHARSET.test(s)) return false;
  // Unreachable given the charset above, but kept so the invariant is explicit
  // if the charset is ever widened.
  if (s.includes('..')) return false;
  if (s.endsWith('.lock')) return false;
  if (s === '.' || s === '..' || s === '.git') return false;
  return true;
}

/**
 * Branch name derived from a slug. Kept as its own function so that a future
 * change (e.g. an `albedo/` prefix) is a one-line edit rather than a grep.
 * A slash-free branch name means the ref and the directory name stay identical,
 * which makes the reconcile view readable.
 */
export function branchNameFor(slug: string): string {
  if (!isSafeSlug(slug)) {
    throw new Error(`refusing to build a branch name from unsafe slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/**
 * Validate a ref name that did NOT come from {@link slugify} -- e.g. a base
 * branch the user picked, or a branch read back from git. Implements the
 * relevant subset of git-check-ref-format(1) for a branch (refs/heads/<name>).
 *
 * This is the guard that stops a hand-typed "--upload-pack=..." from ever
 * reaching the argv we hand to git.
 */
export function isValidRefName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  // A leading dash is read by git as an option even when passed as its own argv
  // element, so it is rejected outright.
  if (name.startsWith('-')) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (name.includes('..')) return false;
  if (name.includes('@{')) return false;
  if (name === '@') return false;
  if (name.endsWith('.lock')) return false;
  // Any path component may not begin with a dot or end with .lock.
  for (const part of name.split('/')) {
    if (part.length === 0) return false;
    if (part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  // Control characters, DEL, space and the git-reserved punctuation set.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return true;
}

/** Throwing wrapper around {@link isValidRefName}, for use at call boundaries. */
export function assertValidRefName(name: string, what = 'branch'): void {
  if (!isValidRefName(name)) {
    throw new Error(`Invalid ${what} name: ${JSON.stringify(name)}`);
  }
}
