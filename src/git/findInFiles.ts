/**
 * Find in Files (⌘⇧F): full-text search across one worktree.
 *
 * Same engine as the quick-open index -- `git grep`, so the shell scope needs
 * nothing new and tracked plus untracked-but-not-ignored files are searched,
 * exactly the set `git ls-files --others --exclude-standard` lists. This file
 * is the pure half: the argv, the match ranges for highlighting, grouping by
 * file and the cap, plus `runFind`, the one call that touches git. Parsing
 * the `-z` output is `parseGrepOutput` in `codeIndex.ts`; it is not repeated.
 */

import { grepFlavour, noteNoPcre, parseGrepOutput } from './codeIndex';
import { git } from './worktree';

/** Options the dialog's toggles control. Fixed-string, case-insensitive by default. */
export interface FindOptions {
  regex: boolean;
  matchCase: boolean;
}

/** One line git printed: the shape `parseGrepOutput` returns. */
export interface FindHit {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

/** A hit with where on the line it matched, for highlighting. */
export interface FindMatch extends FindHit {
  /** `[start, end)` UTF-16 offsets into `text`; empty when it cannot be located. */
  ranges: Array<[number, number]>;
}

export interface FindGroup {
  path: string;
  matches: FindMatch[];
}

export interface FindResult {
  groups: FindGroup[];
  /** Matching lines shown. */
  count: number;
  /** True when git found more than `FIND_CAP`; the dialog must say so. */
  capped: boolean;
}

/**
 * Lines shown at most. Past this a search is too broad to read anyway, and
 * rendering tens of thousands of rows would stall the dialog it is in.
 */
export const FIND_CAP = 500;

/** Shortest query worth running: one character greps every line in the repo. */
export const FIND_MIN_LENGTH = 2;

/** Lines longer than this are cut around the first match before display. */
const LINE_DISPLAY_MAX = 240;

/**
 * The `git grep` argv.
 *
 * `-F` for fixed strings, so the default never needs escaping -- a search for
 * `foo(` must not be a syntax error. Regex mode uses the session's engine (PCRE,
 * falling back to ERE, decided in `codeIndex.ts`). The pattern goes through
 * `-e` so one starting with `-` is never read as a flag.
 */
export function findArgs(query: string, opts: FindOptions, engine: '-P' | '-E' = '-P'): string[] {
  return [
    'grep',
    '-n',
    '-z', // NUL after path and line: no colon ambiguity, no path quoting
    '-I', // skip binaries
    '--no-color',
    '--untracked',
    opts.regex ? engine : '-F',
    ...(opts.matchCase ? [] : ['-i']),
    '-e',
    query,
    '--',
  ];
}

/**
 * A JS regex that finds the same thing on one line, for highlighting only --
 * git has already decided which lines match. Null when the pattern is a PCRE
 * or ERE construct JS cannot compile; the line is then shown unhighlighted,
 * never dropped.
 */
export function highlighter(query: string, opts: FindOptions): RegExp | null {
  const flags = opts.matchCase ? 'g' : 'gi';
  if (!opts.regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  try {
    return new RegExp(query, flags);
  } catch {
    return null;
  }
}

/** Every non-empty match of `re` on `text`. */
export function matchRanges(text: string, re: RegExp | null): Array<[number, number]> {
  if (!re) return [];
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      // `a*` and friends: never loop on an empty match, never show one.
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * Group hits by file in git's order, cap the total, and locate the matches.
 * git prints files sorted and lines ascending, so the order is kept as is.
 */
export function groupHits(hits: readonly FindHit[], query: string, opts: FindOptions, cap = FIND_CAP): FindResult {
  const re = highlighter(query, opts);
  const groups: FindGroup[] = [];
  const byPath = new Map<string, FindGroup>();
  let count = 0;
  for (const hit of hits) {
    if (count === cap) return { groups, count, capped: true };
    let group = byPath.get(hit.path);
    if (!group) {
      group = { path: hit.path, matches: [] };
      byPath.set(hit.path, group);
      groups.push(group);
    }
    group.matches.push({ ...hit, ranges: matchRanges(hit.text, re) });
    count++;
  }
  return { groups, count, capped: false };
}

/**
 * The part of a line worth showing: leading indentation dropped, and a long
 * line (minified bundles, lock files) cut to a window around the first match.
 * Ranges are shifted to match. `…` marks a cut.
 */
export function displayLine(match: Pick<FindMatch, 'text' | 'ranges'>): {
  text: string;
  ranges: Array<[number, number]>;
} {
  const indent = match.text.length - match.text.trimStart().length;
  let start = indent;
  let end = match.text.length;
  if (end - start > LINE_DISPLAY_MAX) {
    const first = match.ranges[0]?.[0] ?? start;
    start = Math.max(start, first - 40);
    end = Math.min(end, start + LINE_DISPLAY_MAX);
  }
  const lead = start > indent ? '…' : '';
  const tail = end < match.text.length ? '…' : '';
  const shift = start - lead.length;
  const ranges = match.ranges
    .filter(([a, b]) => b > start && a < end)
    .map(([a, b]): [number, number] => [Math.max(a, start) - shift, Math.min(b, end) - shift]);
  return { text: lead + match.text.slice(start, end) + tail, ranges };
}

/**
 * Split a line into plain and highlighted runs, for rendering without
 * `dangerouslySetInnerHTML`. Overlapping ranges cannot occur (`matchRanges`
 * walks forward) but are tolerated.
 */
export function splitRuns(text: string, ranges: ReadonlyArray<[number, number]>): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    if (from > at) out.push({ text: text.slice(at, from), hit: false });
    out.push({ text: text.slice(from, b), hit: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/**
 * Git's own words for "this build has no PCRE". Only this downgrades the
 * session to ERE; an invalid pattern under `-P` is the user's typo, and
 * retrying it under ERE would hide the real error behind a different one.
 */
const NO_PCRE = /USE_LIBPCRE|not compiled with|Perl-compatible/i;

/** Thrown for a pattern git rejects; the dialog shows `message` as is. */
export class FindError extends Error {}

/**
 * Search `root`. Resolves with grouped, capped results; rejects with a
 * `FindError` carrying git's message when the pattern is invalid.
 *
 * Not cancellable -- the shell plugin's `execute` cannot stop the child -- so
 * a superseded search is left to finish and the caller drops its answer. The
 * debounce and `FIND_MIN_LENGTH` are what keep that from piling up.
 */
export async function runFind(root: string, query: string, opts: FindOptions): Promise<FindResult> {
  const engine = grepFlavour();
  let r = await git(findArgs(query, opts, engine), root);
  if (opts.regex && engine === '-P' && r.code !== 0 && r.code !== 1 && NO_PCRE.test(r.stderr)) {
    noteNoPcre();
    r = await git(findArgs(query, opts, '-E'), root);
  }
  // 1 is "nothing matched": an answer, not a failure.
  if (r.code === 1) return { groups: [], count: 0, capped: false };
  if (r.code !== 0) throw new FindError(r.stderr.replace(/^fatal:\s*/m, '').trim() || `git grep exited ${r.code}`);
  return groupHits(parseGrepOutput(r.stdout), query, opts);
}
