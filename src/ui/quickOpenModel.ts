/**
 * What the quick-open palette shows for a query. Pure, so the ranking rules
 * are tested without a DOM; `QuickOpen.tsx` only renders the result.
 *
 * ## Modes, after PhpStorm
 *
 *   file    ⇧⌘O  every file in the worktree
 *   class   ⌘O   classes, interfaces, traits, enums, TS types
 *   symbol  ⌥⌘O  all of the above plus functions, methods, constants
 *   all     ⇧⇧   files and symbols in one list
 *
 * ## The open file goes first
 *
 * In class and symbol modes, matches from the file open in the editor rank
 * ahead of everything else, and with an empty query they ARE the list -- the
 * file's outline, in line order. That makes ⌥⌘O in an open file "jump to a
 * method here", which is the commonest reason to press it. It also means a
 * scrappy match in the open file beats a clean one elsewhere; typing one more
 * letter usually removes the scrappy one.
 */

import { basenameStart, fuzzyMatch, matchPath, normaliseQuery, TopK, BASENAME_TIER } from '../lib/fuzzy';
import { TYPE_KINDS, type CodeIndex, type CodeSymbol, type SymbolKind } from '../git/codeIndex';

export type QuickOpenMode = 'file' | 'class' | 'symbol' | 'all';

export interface QuickOpenItem {
  key: string;
  kind: SymbolKind | 'file';
  /** Symbol name, or a file's basename. */
  name: string;
  /** Indices into `name` to emphasise. */
  nameHits: number[];
  /** Worktree-relative file path. For a file row, the directory only. */
  path: string;
  /** Indices into `path` to emphasise (file rows matched on the directory). */
  pathHits: number[];
  /** The file to open, worktree-relative. */
  file: string;
  line: number | null;
  /** In the file open in the editor. */
  current: boolean;
  score: number;
}

export interface QuickOpenResult {
  items: QuickOpenItem[];
  /** Every match, before the cap. */
  total: number;
}

/** Rendered rows. Past this the list is noise and the DOM cost is real. */
export const RESULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Preparation: done once per index build, not per keystroke
// ---------------------------------------------------------------------------

interface PreparedFile {
  path: string;
  lower: string;
  base: number;
}

interface PreparedSymbol extends CodeSymbol {
  lower: string;
}

export interface PreparedIndex {
  files: PreparedFile[];
  symbols: PreparedSymbol[];
}

const prepared = new WeakMap<CodeIndex, PreparedIndex>();

/** Lowercase every candidate once. Memoised on the index object. */
export function prepareIndex(index: CodeIndex): PreparedIndex {
  let p = prepared.get(index);
  if (!p) {
    p = {
      files: index.files.map((path) => ({ path, lower: path.toLowerCase(), base: basenameStart(path) })),
      symbols: index.symbols.map((s) => ({ ...s, lower: s.name.toLowerCase() })),
    };
    prepared.set(index, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Split a trailing `:line` off the query, PhpStorm-style: `Foo.php:120` opens
 * Foo.php at line 120. Only a trailing run of digits counts, so a query that
 * merely contains a colon is left alone.
 */
export function parseQuery(raw: string): { text: string; line: number | null } {
  const m = /^(.*?):(\d+)\s*$/.exec(raw);
  if (!m || m[1]!.trim() === '') return { text: raw, line: null };
  const line = Number(m[2]);
  return { text: m[1]!, line: line >= 1 ? line : null };
}

/**
 * The editor's path, relative to the worktree, or null when it is outside it.
 * The open-file request carries whatever path the caller had: relative from a
 * transcript or this palette, absolute from a tool call.
 */
export function worktreeRelative(root: string, path: string): string | null {
  const r = root.replace(/\/+$/, '');
  if (path.startsWith('/')) return path.startsWith(`${r}/`) ? path.slice(r.length + 1) : null;
  return path.replace(/^(\.\/)+/, '');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Ties go to the declaration a person most likely wants. */
const KIND_RANK: Record<QuickOpenItem['kind'], number> = {
  class: 0,
  interface: 0,
  trait: 0,
  enum: 0,
  type: 1,
  file: 2,
  function: 3,
  method: 3,
  const: 4,
};

/**
 * In `all` mode a file and a symbol compete on one scale. A basename hit is
 * scored like a symbol-name hit (the tier is removed); a hit that needed the
 * directory is a weaker claim and pays for it.
 */
const PATH_ONLY_PENALTY = 30;

function compare(a: QuickOpenItem, b: QuickOpenItem): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (k !== 0) return k;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  const fa = a.file.length - b.file.length;
  if (fa !== 0) return fa;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0);
}

function fileItem(f: PreparedFile, indices: number[], score: number, line: number | null): QuickOpenItem {
  const dir = f.base > 0 ? f.path.slice(0, f.base - 1) : '';
  const nameHits: number[] = [];
  const pathHits: number[] = [];
  for (const i of indices) {
    if (i >= f.base) nameHits.push(i - f.base);
    else if (i < dir.length) pathHits.push(i);
  }
  return {
    key: `f:${f.path}`,
    kind: 'file',
    name: f.path.slice(f.base),
    nameHits,
    path: dir,
    pathHits,
    file: f.path,
    line,
    current: false,
    score,
  };
}

function symbolItem(s: PreparedSymbol, indices: number[], score: number, current: boolean): QuickOpenItem {
  return {
    key: `s:${s.path}:${s.line}:${s.name}`,
    kind: s.kind,
    name: s.name,
    nameHits: indices,
    path: s.path,
    pathHits: [],
    file: s.path,
    line: s.line,
    current,
    score,
  };
}

/**
 * Rank the index against a query. `currentFile` is worktree-relative, or null.
 */
export function search(
  index: PreparedIndex,
  mode: QuickOpenMode,
  rawQuery: string,
  currentFile: string | null,
  limit = RESULT_LIMIT,
): QuickOpenResult {
  const { text, line } = parseQuery(rawQuery);
  const q = normaliseQuery(text);
  const top = new TopK<QuickOpenItem>(limit, compare);

  if (q === '') {
    // The open file's outline, in line order; nothing for files, where an
    // unranked list of 10k paths helps nobody.
    if (mode === 'file' || currentFile === null) return { items: [], total: 0 };
    const own = index.symbols
      .filter((s) => s.path === currentFile && (mode !== 'class' || TYPE_KINDS.has(s.kind)))
      .sort((a, b) => a.line - b.line);
    return { items: own.slice(0, limit).map((s) => symbolItem(s, [], 0, true)), total: own.length };
  }

  if (mode === 'file' || mode === 'all') {
    for (const f of index.files) {
      const hit = matchPath(q, f.path, f.lower, f.base);
      if (!hit) continue;
      let score = hit.score;
      if (mode === 'all') score = score >= BASENAME_TIER ? score - BASENAME_TIER : score - PATH_ONLY_PENALTY;
      top.push(fileItem(f, hit.indices, score, line));
    }
  }

  if (mode !== 'file') {
    const typesOnly = mode === 'class';
    for (const s of index.symbols) {
      if (typesOnly && !TYPE_KINDS.has(s.kind)) continue;
      const hit = fuzzyMatch(q, s.name, s.lower);
      if (!hit) continue;
      // `all` is a global search; the open-file preference is for the two
      // modes that are about code structure.
      const current = mode !== 'all' && s.path === currentFile;
      top.push(symbolItem(s, hit.indices, hit.score, current));
    }
  }

  return { items: top.items, total: top.seen };
}
