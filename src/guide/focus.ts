/**
 * What a Review Guide sets aside and what it asks to be read carefully
 * (#295). Pure: patterns in, decisions out, from git paths alone.
 *
 *  - **Set aside**: files that rarely need a careful read (tests, styles,
 *    lockfiles, snapshots, generated files). They go into a group of their
 *    own, listed last, and are never sent to the Guide writer.
 *  - **Review carefully**: files a project wants read with care (migrations,
 *    schema, auth, CI and build config, dependency manifests). A file that
 *    matches both is NOT set aside: a flagged file is never tucked away.
 *
 * A project keeps its own lists (projects.guide_set_aside / guide_careful,
 * migration 0014); NULL there means Albedo's starting set below. A guide
 * keeps the lists it was written with, so Rewrite writes it the same way.
 *
 * Patterns are a small glob, matched against the path git reports (relative,
 * `/`-separated, case-sensitive):
 *   `*`      any characters within one folder or name
 *   `?`      one character, not `/`
 *   `**`     any number of folders, none included: `**` then `/x` matches `x` too
 *   `{a,b}`  either alternative
 * A pattern with no `/` is matched against the file's name in any folder
 * (`*.css`, `package.json`), as in .gitignore; a leading `/` anchors it to
 * the repository's root (`/package.json`). An unclosed `{` is literal.
 * Blank lines and `#` comments are ignored. No dependency: a glob library is not worth the embargo here.
 */

export interface GuideFocus {
  setAside: string[];
  careful: string[];
}

/** Albedo's starting set (#295): what a project uses until it saves its own. */
export const DEFAULT_SET_ASIDE: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  // Other languages' test conventions (#310): PHPUnit, Go, pytest, and the
  // test folders of PHP, Ruby, Java and Rust projects.
  '*Test.php',
  '*_test.go',
  'test_*.py',
  '*_test.py',
  '**/tests/**',
  '**/test/**',
  '**/spec/**',
  '**/__snapshots__/**',
  '*.snap',
  '*.{css,scss,less}',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'go.sum',
  '*.min.{js,css}',
  '*.map',
  '**/generated/**',
  '*.generated.*',
];

export const DEFAULT_CAREFUL: readonly string[] = [
  '**/migrations/**',
  '*schema.sql',
  '**/auth/**',
  '*{permission,Permission}*',
  '.github/workflows/**',
  '.circleci/**',
  'Dockerfile',
  'package.json',
  'Cargo.toml',
  'composer.json',
  '.env*',
];

export const DEFAULT_FOCUS: GuideFocus = { setAside: [...DEFAULT_SET_ASIDE], careful: [...DEFAULT_CAREFUL] };

/** More patterns than this, or a longer one, is not a list a person keeps. */
export const MAX_PATTERNS = 100;
export const MAX_PATTERN_CHARS = 200;

/** One pattern per line; blanks and `#` comments dropped, duplicates once, capped. */
export function parsePatterns(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const p = raw.trim();
    if (!p || p.startsWith('#') || p.length > MAX_PATTERN_CHARS || out.includes(p)) continue;
    out.push(p);
    if (out.length === MAX_PATTERNS) break;
  }
  return out;
}

export function formatPatterns(list: readonly string[]): string {
  return list.join('\n');
}

/** A stored list (JSON array of strings), held to the same rules; null when it is not one. */
export function patternsFromJson(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
    return parsePatterns(v.join('\n'));
  } catch {
    return null;
  }
}

export function samePatterns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

export function sameFocus(a: GuideFocus, b: GuideFocus): boolean {
  return samePatterns(a.setAside, b.setAside) && samePatterns(a.careful, b.careful);
}

/** A project's defaults: its own lists, or Albedo's where it has none. */
export function projectFocus(p: { guideSetAside: string[] | null; guideCareful: string[] | null } | null | undefined): GuideFocus {
  return {
    setAside: [...(p?.guideSetAside ?? DEFAULT_SET_ASIDE)],
    careful: [...(p?.guideCareful ?? DEFAULT_CAREFUL)],
  };
}

/**
 * A pattern, compiled: its `{a,b}` alternatives expanded, each split into
 * segments. No regular expression: a segment is matched by a linear
 * wildcard scan and the segments by a small table, so no pattern can make
 * matching slow (#295 review).
 */
type Segment = string | typeof GLOBSTAR;
const GLOBSTAR = Symbol('**');

/** At most this many alternatives per pattern; past it the rest are dropped. */
export const MAX_ALTERNATIVES = 64;
/** Compiled patterns kept, the oldest dropped first. */
export const MAX_COMPILED = 256;
const compiled = new Map<string, Segment[][] | null>();

/** The index of the `}` closing the `{` at `open`, or -1 when it is never closed. */
function closing(p: string, open: number): number {
  let depth = 0;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') depth++;
    else if (p[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `{a,b}` expanded, nested ones too. An unclosed `{` is literal, and so is a `}` with no `{`. */
export function expandBraces(p: string, max = MAX_ALTERNATIVES): string[] {
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== '{') continue;
    const end = closing(p, i);
    if (end < 0) continue; // unclosed: literal, look further on
    const body = p.slice(i + 1, end);
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    for (let j = 0; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') depth--;
      else if (body[j] === ',' && depth === 0) {
        parts.push(body.slice(from, j));
        from = j + 1;
      }
    }
    parts.push(body.slice(from));
    if (parts.length < 2) continue; // `{a}`: literal, as in a shell
    const head = p.slice(0, i);
    const out: string[] = [];
    for (const part of parts) {
      for (const tail of expandBraces(part + p.slice(end + 1), max)) {
        out.push(head + tail);
        if (out.length >= max) return out;
      }
    }
    return out;
  }
  return [p];
}

function compile(pattern: string): Segment[][] | null {
  let p = pattern.trim().replace(/^\.\//, '');
  // A leading `/` anchors it to the repository's root, as in .gitignore;
  // otherwise a pattern with no `/` is the name, in any folder.
  const anchored = p.startsWith('/');
  p = p.replace(/^\/+/, '');
  if (!p) return null;
  return expandBraces(p).map((alt) => {
    const segs: Segment[] = alt
      .split('/')
      .filter((x) => x !== '')
      .map((x) => (x === '**' ? GLOBSTAR : x.replace(/\*+/g, '*')));
    return !anchored && !alt.includes('/') ? [GLOBSTAR, ...segs] : segs;
  });
}

function compiledOf(pattern: string): Segment[][] | null {
  if (compiled.has(pattern)) return compiled.get(pattern)!;
  const c = compile(pattern);
  compiled.set(pattern, c);
  while (compiled.size > MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
  return c;
}

/**
 * One name against one segment of a pattern: `*` any run, `?` one
 * character. The classic linear scan with one remembered star: no
 * backtracking beyond it, so O(name x segment) at worst.
 */
export function matchSegment(seg: string, name: string): boolean {
  let s = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (s < seg.length && (seg[s] === '?' || seg[s] === name[n])) {
      s++;
      n++;
    } else if (s < seg.length && seg[s] === '*') {
      star = s++;
      mark = n;
    } else if (star >= 0) {
      s = star + 1;
      n = ++mark;
    } else return false;
  }
  while (s < seg.length && seg[s] === '*') s++;
  return s === seg.length;
}

/** The segments against the path's: `**` takes any number of them, none included. */
function matchSegments(segs: readonly Segment[], parts: readonly string[]): boolean {
  // can[j]: the pattern so far matches the first j parts of the path.
  let can = new Array<boolean>(parts.length + 1).fill(false);
  can[0] = true;
  for (const seg of segs) {
    const next = new Array<boolean>(parts.length + 1).fill(false);
    if (seg === GLOBSTAR) {
      let seen = false;
      for (let j = 0; j <= parts.length; j++) {
        seen ||= can[j]!;
        next[j] = seen;
      }
    } else {
      for (let j = 1; j <= parts.length; j++) next[j] = can[j - 1]! && matchSegment(seg, parts[j - 1]!);
    }
    can = next;
  }
  return can[parts.length]!;
}

/** Whether `path` matches `pattern`; an empty pattern matches nothing. */
export function matchGlob(pattern: string, path: string): boolean {
  const alts = compiledOf(pattern);
  if (!alts) return false;
  const parts = path.split('/').filter((x) => x !== '');
  return alts.some((segs) => matchSegments(segs, parts));
}

/** The first of `patterns` that `path` matches, or null. */
export function firstMatch(patterns: readonly string[], path: string): string | null {
  for (const p of patterns) if (matchGlob(p, path)) return p;
  return null;
}

/** Set aside: matches a set-aside pattern and no careful one. */
export function isSetAside(focus: GuideFocus, path: string): boolean {
  return firstMatch(focus.setAside, path) !== null && firstMatch(focus.careful, path) === null;
}

/** A stored guide's `focus`, or undefined when it has none or it is not the shape (#295). */
export function asFocus(v: unknown): GuideFocus | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const { setAside, careful } = v as { setAside?: unknown; careful?: unknown };
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((p): p is string => typeof p === 'string') : null);
  const a = list(setAside);
  const c = list(careful);
  return a && c ? { setAside: a, careful: c } : undefined;
}
