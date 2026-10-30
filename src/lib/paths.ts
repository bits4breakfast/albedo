/**
 * Worktree-scoped path resolution. **The single place this happens.**
 *
 * A transcript is data the app renders, and a good part of it is model output
 * or tool results quoting arbitrary text. A path taken from there must never be
 * able to read or write outside the task's checkout, so containment here is a
 * security boundary, not a convenience. Nothing else in the app may join a
 * transcript path to a filesystem path -- if you are about to write
 * `${worktreePath}/${something}`, call `resolveInWorktree` instead.
 *
 * The one way past it is a person's click on a path, for that one file, which
 * src/ui/editor/outsideFile.ts handles and src-tauri/src/fsscope.rs grants.
 * Nothing changes here: an outside path still resolves to null.
 *
 * Two layers, both required:
 *
 * 1. **Lexical.** Reject the obviously hostile shapes (URLs, Windows drive
 *    letters, percent-encoded separators, backslashes), then normalise `.` and
 *    `..` away and require the result to sit under the worktree root.
 * 2. **Physical.** A string check alone is *not* sufficient: `uploads/evil`
 *    can be a symlink to `/etc`, and it normalises to a path that is plainly
 *    inside the worktree. So the normalised path is handed to a probe that
 *    resolves symlinks and re-checks containment against the real location.
 *
 * The probe is pluggable because the two environments differ: under Tauri we
 * have `lstat` but no `readlink`, so the default probe refuses any symlinked
 * component (it cannot verify where it points, so it does not allow it). Tests
 * inject a `fs.realpath`-backed probe and exercise the real filesystem.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedPath {
  /** Absolute, normalised, symlink-resolved location on disk. */
  absolute: string;
  /** Path relative to the worktree root. Never starts with `/` or `..`. */
  relative: string;
}

/**
 * Resolve `absolutePath` to its real on-disk location, following symlinks.
 *
 * Returns null when the real location cannot be determined -- the caller then
 * refuses the path, because "I could not check" and "it is fine" are not the
 * same answer. A probe performs **no containment check of its own**;
 * `resolveInWorktree` re-checks whatever comes back, so a buggy or compromised
 * probe still cannot hand out an escape.
 *
 * `worktreeRoot` is a hint, not a boundary: the degraded fallback probe uses it
 * to bound how far up it walks. It is null when the root *itself* is being
 * canonicalised, which happens first and has nothing above it to bound against.
 */
export type WorktreeProbe = (
  absolutePath: string,
  worktreeRoot: string | null,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

const MAX_PATH_LEN = 4096;

/** `%2e`, `%2f`, `%5c` and friends: an encoded separator or dot. */
const ENCODED_SEPARATOR = /%(?:2e|2f|5c|00)/i;

/** `https://`, `file://`, `data:` … anything with a scheme is not a file path. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** `C:\Users\…` or `C:/Users/…`. */
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;

/**
 * Collapse `.` and `..` segments in an absolute path.
 *
 * `..` at the root is dropped rather than escaping, which is what a kernel
 * does too -- but the caller still has to check containment afterwards,
 * because `/root/../../etc/passwd` collapses to `/etc/passwd`, happily inside
 * nothing at all.
 */
function normalizeAbsolute(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

/**
 * True when `p` is strictly below `root`.
 *
 * The trailing slash matters: without it `/a/bcd` reads as being inside
 * `/a/bc`. `root` itself is deliberately not "inside" -- there is no file to
 * open there.
 */
function isInside(root: string, p: string): boolean {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return p.startsWith(prefix) && p.length > prefix.length;
}

/** Cheap structural rejection, before any I/O. */
function lexicallyHostile(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_PATH_LEN) return true;
  if (raw.includes('\0')) return true;
  // A backslash is a legal POSIX filename character, but a path containing one
  // in a transcript is a Windows path or an escape attempt. Neither is ours.
  if (raw.includes('\\')) return true;
  if (DRIVE_LETTER.test(raw)) return true;
  if (URL_SCHEME.test(raw)) return true;
  // We never percent-decode (a file may legitimately be named `100%25`), so an
  // encoded separator can only be an attempt to slip past normalisation.
  if (ENCODED_SEPARATOR.test(raw)) return true;
  // `~` expansion is the shell's job, not ours, and `~/…` is never worktree-local.
  if (raw.startsWith('~')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The physical probe
// ---------------------------------------------------------------------------

/** Deepest ancestor walk when canonicalising a path that does not exist yet. */
const MAX_ANCESTOR_WALK = 64;

type Lstat = (path: string) => Promise<{ isSymlink: boolean }>;
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Is the `canonicalize_path` command present in this binary?
 *
 * Probed once per session by canonicalising `/`, which succeeds on any host
 * where the command is registered and fails on every host where it is not.
 * Asking the question directly is the only reliable way to tell "the command
 * is missing" from "that path does not exist" -- both arrive as a rejected
 * invoke with a string in it, and parsing that string would be guesswork.
 */
let canonicalizeAvailable: boolean | null = null;

async function haveCanonicalize(invoke: Invoke): Promise<boolean> {
  if (canonicalizeAvailable !== null) return canonicalizeAvailable;
  try {
    const root = await invoke<string>('canonicalize_path', { path: '/' });
    canonicalizeAvailable = typeof root === 'string' && root.startsWith('/');
  } catch {
    canonicalizeAvailable = false;
  }
  return canonicalizeAvailable;
}

/**
 * Canonicalise via the Rust `canonicalize_path` command.
 *
 * `std::fs::canonicalize` fails on a path that does not exist, but the editor
 * must be able to open a file the agent named before creating it. So a failure
 * walks up to the nearest ancestor that *does* resolve and re-attaches the
 * missing segments to its canonical form.
 *
 * Only a component that is genuinely absent may be skipped. If `lstat` says
 * something is there and canonicalize still refused it -- a broken symlink, an
 * unreadable parent -- we cannot say where it points, so we refuse too. Without
 * that check, a dangling symlink out of the worktree would be skipped over and
 * then written through.
 */
async function canonicalizeViaCommand(
  invoke: Invoke,
  lstat: Lstat,
  absolutePath: string,
): Promise<string | null> {
  const tail: string[] = [];
  let cursor = absolutePath;

  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    try {
      const real = await invoke<string>('canonicalize_path', { path: cursor });
      if (typeof real !== 'string' || !real.startsWith('/')) return null;
      const base = normalizeAbsolute(real);
      if (tail.length === 0) return base;
      return `${base === '/' ? '' : base}/${[...tail].reverse().join('/')}`;
    } catch {
      if (cursor === '/') return null;
      let present = true;
      try {
        await lstat(cursor);
      } catch {
        present = false;
      }
      if (present) return null;
      const slash = cursor.lastIndexOf('/');
      if (slash < 0) return null;
      tail.push(cursor.slice(slash + 1));
      cursor = slash === 0 ? '/' : cursor.slice(0, slash);
    }
  }
  return null;
}

/**
 * Degraded fallback, for a binary without `canonicalize_path`.
 *
 * `@tauri-apps/plugin-fs` exposes `lstat` but no `readlink`, so a symlink's
 * target cannot be inspected. Rather than guess, every component below the
 * worktree root is lstat'd and a symlink is **refused**. That is stricter than
 * POSIX realpath -- a symlink pointing at a sibling file inside the same
 * worktree is rejected too -- but it fails closed, and degrading to "refuses
 * symlinks" is correct where degrading to "allows anything" would not be.
 *
 * A component that does not exist ends the walk: nothing below a missing
 * directory can exist either.
 */
async function lstatWalk(
  lstat: Lstat,
  absolutePath: string,
  worktreeRoot: string | null,
): Promise<string | null> {
  // Canonicalising the root itself: there is nothing above it to walk from, and
  // Albedo created it, so it is taken as given. This is the one thing the
  // fallback cannot verify, and the reason it is only a fallback.
  if (worktreeRoot === null) return absolutePath;
  if (!isInside(worktreeRoot, absolutePath)) return null;

  const segments = absolutePath.slice(worktreeRoot.length + 1).split('/');
  let cursor = worktreeRoot;
  for (const segment of segments) {
    cursor = `${cursor}/${segment}`;
    let info: { isSymlink: boolean };
    try {
      info = await lstat(cursor);
    } catch {
      break;
    }
    if (info.isSymlink) return null;
  }
  return absolutePath;
}

/** Default probe for the Tauri renderer: the command, or the fallback. */
async function tauriProbe(
  absolutePath: string,
  worktreeRoot: string | null,
): Promise<string | null> {
  let invoke: Invoke;
  let lstat: Lstat;
  try {
    ({ invoke } = (await import('@tauri-apps/api/core')) as { invoke: Invoke });
    ({ lstat } = await import('@tauri-apps/plugin-fs'));
  } catch {
    // No host to ask -- refuse rather than trust the string.
    return null;
  }

  if (await haveCanonicalize(invoke)) {
    return canonicalizeViaCommand(invoke, lstat, absolutePath);
  }
  return lstatWalk(lstat, absolutePath, worktreeRoot);
}

let probe: WorktreeProbe = tauriProbe;

/**
 * Swap the symlink probe. Exists so tests can run against a real filesystem
 * without a Tauri host. Passing null restores the default and forgets the
 * cached `canonicalize_path` availability answer.
 */
export function setWorktreeProbe(next: WorktreeProbe | null): void {
  probe = next ?? tauriProbe;
  rootCache.clear();
  if (next === null) canonicalizeAvailable = null;
}

/**
 * Canonical form of each worktree root we have seen.
 *
 * `resolveInWorktree` runs once per path link the transcript renders, which is
 * hundreds per pane, and the root is the same string every time. Roots are few
 * (one per task) and their canonical form does not change while the app runs,
 * so this is a plain memo rather than a cache with a policy.
 */
const rootCache = new Map<string, string>();

async function canonicalRoot(rootNorm: string): Promise<string | null> {
  const memo = rootCache.get(rootNorm);
  if (memo !== undefined) return memo;
  const real = await probe(rootNorm, null);
  if (real === null || !real.startsWith('/') || real === '/') return null;
  const normalized = normalizeAbsolute(real);
  if (normalized === '/') return null;
  rootCache.set(rootNorm, normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// resolveInWorktree
// ---------------------------------------------------------------------------

/**
 * Resolve a path seen in a transcript against a task's worktree.
 *
 * Returns null when the path escapes the worktree -- callers render it as plain
 * text rather than a link. Rejects `..` traversal (including repeated and
 * percent-encoded forms), absolute paths outside the worktree, paths that
 * normalise out of it, and symlinks whose target leaves it.
 *
 * An absolute path that is genuinely inside the worktree resolves to itself.
 */
export async function resolveInWorktree(
  worktreePath: string,
  raw: string,
): Promise<ResolvedPath | null> {
  if (typeof worktreePath !== 'string' || typeof raw !== 'string') return null;

  const root = worktreePath.trim();
  if (!root.startsWith('/') || lexicallyHostile(root)) return null;
  const rootNorm = normalizeAbsolute(root);
  if (rootNorm === '/') return null;

  const candidate = raw.trim();
  if (lexicallyHostile(candidate)) return null;

  const joined = candidate.startsWith('/') ? candidate : `${rootNorm}/${candidate}`;
  const normalized = normalizeAbsolute(joined);

  // Layer 1: lexical containment. Catches traversal without touching the disk.
  //
  // A relative path that escapes the lexical root is refused here, before any
  // I/O at all -- which is the common hostile case and the one worth being
  // cheap about. Only an *absolute* candidate can still be salvageable, by
  // being spelled against the canonical root rather than the given one.
  let bound: string | null = isInside(rootNorm, normalized) ? rootNorm : null;
  if (bound === null && !candidate.startsWith('/')) return null;

  // The root is canonicalised too, so a symlinked `~/agents` does not break
  // every comparison below.
  const rootReal = await canonicalRoot(rootNorm);
  if (rootReal === null) return null;

  if (bound === null) {
    bound = isInside(rootReal, normalized) ? rootReal : null;
    if (bound === null) return null;
  }

  // Layer 2: physical containment. Catches symlinks that leave the worktree,
  // which layer 1 cannot see -- `a/link/x` is a perfectly contained *string*.
  // Containment is re-checked here, on the canonical root, so the probe is
  // never the thing that decides.
  const real = await probe(normalized, bound);
  if (real === null) return null;
  if (!isInside(rootReal, real)) return null;

  return { absolute: real, relative: real.slice(rootReal.length + 1) };
}

// ---------------------------------------------------------------------------
// parsePathRef
// ---------------------------------------------------------------------------

export interface PathRef {
  path: string;
  line: number | null;
}

/** Largest line number we will believe. Beyond this it is not a line number. */
const MAX_LINE = 1_000_000;

/**
 * Characters allowed in an unquoted path. No spaces and no backslashes: a
 * space would swallow the rest of a sentence, and a backslash is Windows.
 */
const PC = 'A-Za-z0-9_.~@+\\-';

/**
 * PC minus `.`, used in the trailing lookaheads. Letting a match end on a dot
 * is what makes `see src/a.ts.` work: the dot is consumed and then trimmed as
 * sentence punctuation, instead of failing the match outright.
 */
const PC_END = 'A-Za-z0-9_~@+/\\-';

/** Characters that, immediately before a match, mean we are mid-token. */
const BOUNDARY_BEFORE = new RegExp(`[${PC}/:\\\\]`);

/** An extension has to start with a letter, so `v1.2` is not a file. */
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,7})$/;

/**
 * Extensions we accept on a path with **no directory separator at all**.
 *
 * The allowlist exists purely to keep `example.com:443` and `redis.io:6379`
 * from parsing as `path:line`. A path containing a `/` never consults it.
 */
const BARE_FILE_EXTENSIONS = new Set([
  'bash', 'bat', 'blade', 'c', 'cc', 'cfg', 'cjs', 'conf', 'cpp', 'cs', 'css', 'csv',
  'dart', 'diff', 'dockerfile', 'env', 'erb', 'ex', 'exs', 'go', 'gql', 'gradle',
  'graphql', 'h', 'hpp', 'htm', 'html', 'ini', 'java', 'js', 'json', 'jsx', 'kt',
  'less', 'lock', 'log', 'lua', 'md', 'mdx', 'mjs', 'mk', 'patch', 'php', 'pl', 'po',
  'proto', 'ps1', 'py', 'r', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'svg', 'swift',
  'tf', 'toml', 'tpl', 'ts', 'tsv', 'tsx', 'twig', 'txt', 'vue', 'xml', 'yaml', 'yml',
  'zsh',
]);

/** `src/services.yaml` -> true; `origin/master` -> false. */
function hasFileExtension(p: string): boolean {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return EXTENSION.test(base);
}

/** Shared structural rejection for every form. */
function plausibleShape(p: string): boolean {
  if (p.length === 0 || p.length > 512) return false;
  if (/[\s\0\\]/.test(p)) return false;
  if (URL_SCHEME.test(p)) return false;
  if (DRIVE_LETTER.test(p)) return false;
  if (p.endsWith('/')) return false;
  if (/^\.{1,2}$/.test(p)) return false;
  return true;
}

/**
 * Conservative shape test for the forms that carry a line number.
 *
 * A false positive turns ordinary prose into a broken link, so anything
 * doubtful is rejected -- but these forms have the `:42` / `(42)` / `, line 42`
 * suffix as corroboration, so a directory separator is enough on its own.
 */
function looksLikePath(p: string, requireSlash: boolean): boolean {
  if (!plausibleShape(p)) return false;
  if (p.includes('/')) return true;
  if (requireSlash) return false;
  // Without a directory separator the only evidence left is the extension, and
  // only a known file extension counts -- `example.com:443` is not a file.
  const ext = EXTENSION.exec(p);
  return ext !== null && BARE_FILE_EXTENSIONS.has((ext[1] ?? '').toLowerCase());
}

/**
 * Shape test for a **bare** path -- no line number, no corroborating syntax.
 *
 * Measured over 60k real transcript lines, "contains a slash" alone produced a
 * 17.2% false-positive rate, and every offender had the same signature: an
 * extension-less `a/b`. Progress counters (`1/2`, `3/4`), git refs
 * (`origin/master`, `origin/ACME-2269`), prose (`I/O`, `and/or`, `CSV/PDF`,
 * `Request/Response`), npm specifiers (`posthog-js/react`) and MCP method
 * names (`tools/list`, `server/discover`) all fall out once the basename must
 * carry a file extension.
 *
 * The consequence is that a directory reference like `var/cache` stops being a
 * link, which is right: this is a click-to-open-a-*file* affordance. The
 * failure mode being fixed is not a crash -- an unresolvable link is inert --
 * it is that a pane where one link in six does nothing is a pane you stop
 * trusting.
 */
function looksLikeBarePath(p: string): boolean {
  if (!plausibleShape(p)) return false;
  if (!p.includes('/')) return false;
  // An explicitly rooted or explicitly relative path is a path by construction,
  // extension or not: nobody writes `./foo` or `/var/log/syslog` in passing.
  if (p.startsWith('/') || p.startsWith('./')) return true;
  return hasFileExtension(p);
}

/** Same test for the quoted forms, where spaces inside the quotes are fine. */
function looksLikeQuotedPath(p: string): boolean {
  if (p.length === 0 || p.length > 512) return false;
  if (/[\0\\]/.test(p)) return false;
  if (p !== p.trim()) return false;
  if (URL_SCHEME.test(p)) return false;
  if (DRIVE_LETTER.test(p)) return false;
  if (p.endsWith('/')) return false;
  if (p.includes('/')) return true;
  const ext = EXTENSION.exec(p);
  return ext !== null && BARE_FILE_EXTENSIONS.has((ext[1] ?? '').toLowerCase());
}

function toLine(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LINE) return null;
  return n;
}

interface Candidate extends PathRef {
  index: number;
  /** Lower wins when two candidates start at the same offset. */
  rank: number;
}

/**
 * Returned by a builder that recognised the *shape* of a reference but refuses
 * it -- `src/a.ts:0` is not line zero of a file, it is something else wearing
 * a path's clothes. It suppresses every other candidate starting at the same
 * offset, so the bare-path pattern cannot quietly rescue half of it.
 */
const VETO = Symbol('veto');

/**
 * Run one pattern across `text`, rejecting matches that begin mid-token.
 *
 * The boundary check replaces a lookbehind assertion on purpose: the app's
 * build target includes WebKit versions without lookbehind support, and a regex
 * that throws at parse time takes the whole module with it. It also does the
 * real work of skipping URLs -- in `https://host/a/b.ts:9` every plausible
 * match is preceded by `/` or `:`.
 */
function scan(
  text: string,
  re: RegExp,
  rank: number,
  build: (m: RegExpExecArray) => PathRef | typeof VETO | null,
  out: Candidate[],
  vetoed: Set<number>,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const prev = m.index > 0 ? text.charAt(m.index - 1) : '';
    if (prev !== '' && BOUNDARY_BEFORE.test(prev)) continue;
    const ref = build(m);
    if (ref === VETO) vetoed.add(m.index);
    else if (ref) out.push({ ...ref, index: m.index, rank });
  }
}

/** `File "src/app.py", line 42` — Python tracebacks and PHP's quoted form. */
const QUOTED_LINE = /(["'])([^"'\n]{1,512})\1\s*,\s*line\s+(\d{1,7})\b/gi;

/** `#0 /app/src/Foo.php(42): Bar->baz()` — PHP stack frames. Slash required. */
const PAREN_LINE = new RegExp(`(/?(?:[${PC}]+/)+[${PC}]+)\\((\\d{1,7})\\)`, 'g');

/** `src/Foo.php:42` and `src/Foo.php:42:7`, including the `at …` shape. */
const COLON_LINE = new RegExp(
  `(/?[${PC}]+(?:/[${PC}]+)*):(\\d{1,7})(?::(\\d{1,7}))?(?![${PC_END}])`,
  'g',
);

/** `… in /var/www/src/Foo.php on line 42` — PHP's fatal error format. */
const ON_LINE = new RegExp(`(/?[${PC}]+(?:/[${PC}]+)+)\\s+on line\\s+(\\d{1,7})\\b`, 'gi');

/**
 * `config/services.yaml-12-    foo: bar` — a `grep -C` context line.
 *
 * grep separates a *matching* line from its number with `:` (already covered by
 * COLON_LINE) but a *context* line with `-`. Since `-` is a legal path
 * character, without this the number is swallowed into the path and the link
 * points at a file that does not exist.
 *
 * Two constraints keep it from eating hyphenated filenames, because the matched
 * content follows the second dash immediately and gives no boundary to anchor
 * on:
 *
 *  - the match must start a line, which grep's output always does; and
 *  - the path part must end in a file extension, which is what separates
 *    `src/App.tsx-1-import React` (a grep line) from `src/my-2-thing.ts`
 *    (one filename, and `src/my` has no extension).
 *
 * The regex is greedy, so the *last* viable split wins: `src/a-1-b.ts-5-x`
 * resolves to `src/a-1-b.ts` line 5, not `src/a` line 1.
 */
const GREP_CONTEXT = new RegExp(`^(/?[${PC}]+(?:/[${PC}]+)*)-(\\d{1,7})-`, 'gm');

/** A bare path. Always requires a separator: `node.js` in prose is not a file. */
const BARE = new RegExp(`(/?[${PC}]+(?:/[${PC}]+)+)(?![${PC_END}])`, 'g');

/**
 * Trailing punctuation that belongs to the sentence, not the path:
 * `see src/a.ts.` or `(src/a.ts)`.
 */
function trimTrailingPunctuation(p: string): string {
  return p.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * A bare file name in a code span, optionally with `:line[:col]`. The
 * extension must be one {@link BARE_FILE_EXTENSIONS} knows, minus `log`:
 * `console.log` in backticks is a call, far more often than a file.
 */
const BARE_FILE = /^([A-Za-z0-9_][\w.-]*\.([A-Za-z][A-Za-z0-9]{0,9}))(?::(\d{1,7})(?::\d{1,5})?)?$/;

/**
 * A file named without a folder, `Foo.php` or `Foo.php:12`: what a code span
 * holds when the agent names a file it has been talking about. Only for a span
 * that is nothing else -- in prose, `node.js` is not a file -- and only with a
 * known extension. The caller still has to find which file it is.
 */
export function bareFileRef(text: string): PathRef | null {
  const m = BARE_FILE.exec(text.trim());
  if (!m) return null;
  const ext = (m[2] ?? '').toLowerCase();
  if (ext === 'log' || !BARE_FILE_EXTENSIONS.has(ext)) return null;
  const line = m[3] === undefined ? null : Number(m[3]);
  return { path: m[1] ?? '', line: line !== null && line > 0 && line <= MAX_LINE ? line : null };
}

/** True when a path names no folder: it has to be looked up in the worktree. */
export function isBareName(path: string): boolean {
  return !path.includes('/') && !path.startsWith('~');
}

/**
 * Pull `path:line` / `path:line:col` / `"path", line N` out of transcript text.
 *
 * Returns the first confident reference, or null when there is none. Line is
 * null for a bare path. Deliberately conservative: URLs, Windows paths, clock
 * times and version numbers all return null.
 */
export function parsePathRef(text: string): PathRef | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  const found: Candidate[] = [];
  const vetoed = new Set<number>();

  scan(text, QUOTED_LINE, 0, (m) => {
    const p = (m[2] ?? '').trim();
    if (!looksLikeQuotedPath(p)) return null;
    const line = toLine(m[3]);
    return line === null ? VETO : { path: p, line };
  }, found, vetoed);

  scan(text, PAREN_LINE, 1, (m) => {
    const p = trimTrailingPunctuation(m[1] ?? '');
    if (!looksLikePath(p, true)) return null;
    const line = toLine(m[2]);
    return line === null ? VETO : { path: p, line };
  }, found, vetoed);

  scan(text, GREP_CONTEXT, 2, (m) => {
    const p = m[1] ?? '';
    if (!plausibleShape(p) || !hasFileExtension(p)) return null;
    const line = toLine(m[2]);
    // No veto: if the number is implausible this was never a grep line, so the
    // other patterns should still get a look at the text.
    return line === null ? null : { path: p, line };
  }, found, vetoed);

  scan(text, COLON_LINE, 3, (m) => {
    const p = m[1] ?? '';
    // A trailing dot here would be part of the path, not the sentence, because
    // the `:line` follows it immediately -- so no punctuation trimming.
    if (!looksLikePath(p, false)) return null;
    const line = toLine(m[2]);
    // `src/a.ts:0` is not line zero of a file. Veto rather than degrade: the
    // shape says "this is a path reference" and the number says it is not one
    // we understand, so the honest answer is no reference at all.
    return line === null ? VETO : { path: p, line };
  }, found, vetoed);

  scan(text, ON_LINE, 4, (m) => {
    const p = trimTrailingPunctuation(m[1] ?? '');
    if (!looksLikePath(p, true)) return null;
    const line = toLine(m[2]);
    return line === null ? VETO : { path: p, line };
  }, found, vetoed);

  scan(text, BARE, 5, (m) => {
    const p = trimTrailingPunctuation(m[1] ?? '');
    if (!looksLikeBarePath(p)) return null;
    return { path: p, line: null };
  }, found, vetoed);

  const live = vetoed.size === 0 ? found : found.filter((c) => !vetoed.has(c.index));
  if (live.length === 0) return null;

  live.sort((a, b) => (a.index !== b.index ? a.index - b.index : a.rank - b.rank));
  const best = live[0];
  return best ? { path: best.path, line: best.line } : null;
}
