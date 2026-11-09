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
 * (`*.css`, `package.json`), as in .gitignore. Blank lines and `#` comments
 * are ignored. No dependency: a glob library is not worth the embargo here.
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

const compiled = new Map<string, RegExp | null>();

function escape(ch: string): string {
  return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

/** The body of one glob, without anchors. `{a,b}` nests; an unclosed `{` is literal. */
function globBody(p: string): string {
  let out = '';
  let i = 0;
  const alts: number[] = []; // depth of open braces
  while (i < p.length) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        const atEnd = i + 2 === p.length || p[i + 2] === '/';
        if (atStart && atEnd) {
          if (p[i + 2] === '/') {
            out += '(?:[^/]*/)*'; // `**` and its slash: zero or more folders
            i += 3;
          } else {
            out += '.*'; // trailing `**`: everything below
            i += 2;
          }
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') out += '[^/]';
    else if (c === '{' && p.indexOf('}', i) > i) {
      alts.push(i);
      out += '(?:';
    } else if (c === '}' && alts.length > 0) {
      alts.pop();
      out += ')';
    } else if (c === ',' && alts.length > 0) out += '|';
    else out += escape(c);
    i += 1;
  }
  while (alts.length > 0) {
    alts.pop();
    out += ')';
  }
  return out;
}

/** The pattern as a RegExp over a whole path; null for an empty one. */
export function globToRegExp(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern)!;
  let p = pattern.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  let re: RegExp | null = null;
  if (p) {
    // No `/`: the name, in any folder.
    if (!p.includes('/')) p = `**/${p}`;
    try {
      re = new RegExp(`^${globBody(p)}$`);
    } catch {
      re = null;
    }
  }
  compiled.set(pattern, re);
  return re;
}

export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern)?.test(path) ?? false;
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
