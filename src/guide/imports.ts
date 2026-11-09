/**
 * Which changed file imports which (#288), for the Review Guide's Map. Pure.
 *
 * Read from the files' own text -- the working-tree side git already handed
 * the guide (branchDiff.ts) -- with a small scanner per language. Source
 * code, never terminal output, and never a model: the map is Albedo's own
 * reading of the change, like the blocks and their counts.
 *
 * Deliberately simple, and so deliberately partial:
 *
 *  - TS/JS (and .vue/.svelte): `import … from`, `export … from`, bare
 *    `import '…'`, `require('…')` and `import('…')` with a RELATIVE path.
 *    Package names and path aliases are not followed.
 *  - PHP: `use A\B\C;` (and `use A\B\{C, D}`), matched to a file whose path
 *    ends with the namespace's last folder and the class: `B/C.php`. A name
 *    that matches more than one file equally well is left out, never guessed.
 *  - Rust: `mod x;` and `use crate::… / super::… / self::…`, by the module
 *    tree's file layout (`x.rs` or `x/mod.rs`).
 *
 * A missing arrow is the failure mode, never a wrong one: anything that does
 * not resolve to exactly one file is dropped.
 */

export type ImportLanguage = 'ts' | 'php' | 'rust';

const TS_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;

export function languageOf(path: string): ImportLanguage | null {
  if (TS_EXT.test(path) && !path.endsWith('.d.ts')) return 'ts';
  if (path.endsWith('.php')) return 'php';
  if (path.endsWith('.rs')) return 'rust';
  return null;
}

/** A file larger than this is not scanned: generated or vendored, not read. */
export const MAX_SCAN_CHARS = 400_000;
/** More changed files than this and no imports are read at all. */
export const MAX_SCAN_FILES = 600;

// ---------------------------------------------------------------------------
// Scanning: what a file names
// ---------------------------------------------------------------------------

const TS_PATTERNS = [
  /\bimport\s+(?:type\s+)?[\w*${}\s,]+?\s+from\s*['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/**
 * Line and block comments blanked out, so a commented-out import is not one.
 * String literals are stepped over whole, so a `/*` or `//` inside one
 * (`import.meta.glob('./pages/*.tsx')`, a URL) never opens a comment.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      // Keep the newlines, so a statement after the comment still starts a line.
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && !(ch !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The relative specifiers a TS/JS file imports, in order, each once. */
export function scanTs(text: string): string[] {
  const src = stripComments(text);
  const out: string[] = [];
  for (const re of TS_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const spec = m[1]!;
      if ((spec.startsWith('./') || spec.startsWith('../')) && !out.includes(spec)) out.push(spec);
    }
  }
  return out;
}

/** The fully qualified names a PHP file `use`s (classes, not functions or constants). */
export function scanPhp(text: string): string[] {
  const src = stripComments(text).replace(/(^|\n)\s*#[^\n]*/g, '$1');
  const out: string[] = [];
  const add = (name: string) => {
    const n = name.trim().replace(/^\\/, '').split(/\s+as\s+/i)[0]!.trim();
    if (/^[A-Za-z_][\w\\]*$/.test(n) && !out.includes(n)) out.push(n);
  };
  // Only at the start of a statement, so a closure's `use ($x)` is never one.
  for (const m of src.matchAll(/(?<=^|[;{}])\s*use\s+(?!function\b|const\b)([^;]+);/gm)) {
    const body = m[1]!.trim();
    const brace = body.indexOf('{');
    if (brace >= 0) {
      const prefix = body.slice(0, brace).replace(/\\\s*$/, '');
      const inner = body.slice(brace + 1, body.lastIndexOf('}'));
      for (const part of inner.split(',')) if (part.trim()) add(`${prefix}\\${part.trim()}`);
    } else {
      for (const part of body.split(',')) add(part);
    }
  }
  return out;
}

export interface RustRef {
  kind: 'mod' | 'use';
  /** `mod`: the module name. `use`: the path, `crate::a::b` and the like. */
  path: string;
}

/** The modules a Rust file declares (`mod x;`) and the crate paths it `use`s. */
export function scanRust(text: string): RustRef[] {
  const src = stripComments(text);
  const out: RustRef[] = [];
  const seen = new Set<string>();
  const add = (r: RustRef) => {
    const k = `${r.kind}:${r.path}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  };
  for (const m of src.matchAll(/(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/g)) add({ kind: 'mod', path: m[1]! });
  for (const m of src.matchAll(/(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g)) {
    for (const p of expandRustUse(m[1]!.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, ''))) {
      if (/^(?:crate|super|self)(?:::|$)/.test(p)) add({ kind: 'use', path: p });
    }
  }
  return out;
}

/** `a::{b, c::d}` -> `a::b`, `a::c::d`; one level of braces is enough here. */
function expandRustUse(body: string): string[] {
  const brace = body.indexOf('{');
  if (brace < 0) return [body.replace(/::\*$/, '')];
  const prefix = body.slice(0, brace).replace(/::$/, '');
  const inner = body.slice(brace + 1, body.lastIndexOf('}'));
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.split('{')[0]!.replace(/::\*?$/, ''))
    .filter((p) => p.length > 0 && p !== 'self')
    .map((p) => `${prefix}::${p}`)
    .concat(inner.split(',').some((p) => p.trim() === 'self') ? [prefix] : []);
}

// ---------------------------------------------------------------------------
// Resolving: which file a name is
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `a/b/../c/./d` -> `a/c/d`; null when it climbs out of the repository. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

const TS_TRY = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const TS_INDEX = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

export function resolveTs(from: string, spec: string, exists: (p: string) => boolean): string | null {
  const base = normalizePath(`${dirOf(from)}/${spec}`);
  if (base === null) return null;
  for (const ext of TS_TRY) if (exists(base + ext)) return base + ext;
  for (const ext of TS_INDEX) if (exists(base + ext)) return base + ext;
  // ESM TypeScript names the emitted `.js`: `./a.js` is `./a.ts`.
  const js = /\.(m|c)?js$/.exec(base);
  if (js) {
    const stem = base.slice(0, -js[0].length);
    const m = js[1] ?? '';
    for (const ext of [`.${m}ts`, `.${m}tsx`, '.ts', '.tsx']) if (exists(stem + ext)) return stem + ext;
  }
  return null;
}

/** Every `.php` path by its file name, for {@link resolvePhp}. */
export function phpIndex(paths: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    if (!p.endsWith('.php')) continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    const list = out.get(name);
    if (list) list.push(p);
    else out.set(name, [p]);
  }
  return out;
}

/**
 * `App\Retry\Backoff` -> the one file ending `Retry/Backoff.php` (more of the
 * namespace matching wins); null when none does or two match equally.
 */
export function resolvePhp(name: string, index: ReadonlyMap<string, readonly string[]>): string | null {
  const segs = name.split('\\').filter(Boolean);
  const cls = segs[segs.length - 1];
  if (!cls) return null;
  const candidates = index.get(`${cls}.php`) ?? [];
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const c of candidates) {
    const dirs = c.split('/').slice(0, -1);
    let score = 1;
    for (let i = segs.length - 2, j = dirs.length - 1; i >= 0 && j >= 0; i--, j--) {
      if (segs[i]!.toLowerCase() !== dirs[j]!.toLowerCase()) break;
      score++;
    }
    if (score > bestScore) {
      best = c;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) tie = true;
  }
  // A bare class name is too weak a match unless the namespace is one word.
  if (tie || best === null || (bestScore < 2 && segs.length > 1)) return null;
  return best;
}

/**
 * A file that is a crate's root: `lib.rs`, `main.rs`, `build.rs`, or a binary
 * of its own in `src/bin/`. Its `mod x;` is a sibling, and `crate::` starts
 * beside it.
 */
function isRustCrateRoot(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === 'lib.rs' || name === 'main.rs' || name === 'build.rs' || /(^|\/)src\/bin\/[^/]+\.rs$/.test(path);
}

/** The folder a Rust file's child modules live in. */
function rustModDir(path: string): string {
  const dir = dirOf(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'mod.rs' || isRustCrateRoot(path)) return dir;
  return `${dir ? `${dir}/` : ''}${name.slice(0, -3)}`;
}

/** The crate's root folder: the root file's own, else up to the last `src/` in the path. */
function rustCrateRoot(path: string): string {
  if (isRustCrateRoot(path)) return dirOf(path);
  const bin = /^(.*\/)?src\/bin\/[^/]+\//.exec(path);
  if (bin) return bin[0].slice(0, -1);
  const i = path.lastIndexOf('/src/');
  if (i >= 0) return path.slice(0, i + 4);
  if (path.startsWith('src/')) return 'src';
  return dirOf(path);
}

function rustModuleFile(dir: string, segs: readonly string[], exists: (p: string) => boolean): string | null {
  // The longest prefix of the path that is a module file: `a::b::Item` is a/b.rs.
  for (let n = segs.length; n >= 1; n--) {
    const stem = [dir, ...segs.slice(0, n)].filter(Boolean).join('/');
    if (exists(`${stem}.rs`)) return `${stem}.rs`;
    if (exists(`${stem}/mod.rs`)) return `${stem}/mod.rs`;
  }
  return null;
}

export function resolveRust(from: string, ref: RustRef, exists: (p: string) => boolean): string | null {
  if (ref.kind === 'mod') return rustModuleFile(rustModDir(from), [ref.path], exists);
  const segs = ref.path.split('::').filter(Boolean);
  let dir: string;
  if (segs[0] === 'crate') {
    dir = rustCrateRoot(from);
    segs.shift();
  } else {
    dir = rustModDir(from);
    while (segs[0] === 'self' || segs[0] === 'super') {
      if (segs.shift() === 'super') dir = dirOf(dir);
    }
  }
  if (segs.length === 0) return null;
  const found = rustModuleFile(dir, segs, exists);
  return found === from ? null : found;
}

// ---------------------------------------------------------------------------
// The whole change
// ---------------------------------------------------------------------------

export interface ScannedFile {
  path: string;
  /** The file as it is now; null when it is deleted, binary or too large. */
  text: string | null;
  /** Gone from the working tree: never what an import points at. */
  deleted?: boolean;
}

export interface ImportGraph {
  /** importer -> imported, both repository paths, each pair once. */
  edges: Array<[string, string]>;
  /** Files read for imports. */
  scanned: ReadonlySet<string>;
  /** Changed files in a language the scanner does not read. */
  unsupported: ReadonlySet<string>;
  /** Changed files in a language it reads, but with nothing to read: deleted, binary or too large. */
  unread: ReadonlySet<string>;
  /** Set when no imports were read at all, and why. */
  skipped: 'too-many' | null;
}

/**
 * The imports between `files` and from them to `repoFiles` (every file git
 * tracks, or null when that list could not be had: then only imports
 * between the changed files are found).
 */
export function importGraph(files: readonly ScannedFile[], repoFiles: ReadonlySet<string> | null): ImportGraph {
  if (files.length > MAX_SCAN_FILES) {
    return { edges: [], scanned: new Set(), unsupported: new Set(), unread: new Set(), skipped: 'too-many' };
  }
  // A deleted file is still in the index until the deletion is staged, and in
  // the change: neither makes it something an import can point at.
  const deleted = new Set(files.filter((f) => f.deleted).map((f) => f.path));
  const changed = new Set(files.filter((f) => !f.deleted).map((f) => f.path));
  const exists = (p: string) => !deleted.has(p) && (changed.has(p) || (repoFiles?.has(p) ?? false));
  let php: Map<string, string[]> | null = null;
  const edges: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (from: string, to: string | null) => {
    if (to === null || to === from) return;
    const k = `${from}\n${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push([from, to]);
  };
  const scanned = new Set<string>();
  const unsupported = new Set<string>();
  const unread = new Set<string>();
  for (const f of files) {
    const lang = languageOf(f.path);
    if (lang === null) {
      unsupported.add(f.path);
      continue;
    }
    if (f.text === null || f.deleted || f.text.length > MAX_SCAN_CHARS) {
      unread.add(f.path);
      continue;
    }
    scanned.add(f.path);
    if (lang === 'ts') for (const s of scanTs(f.text)) add(f.path, resolveTs(f.path, s, exists));
    else if (lang === 'rust') for (const r of scanRust(f.text)) add(f.path, resolveRust(f.path, r, exists));
    else {
      php ??= phpIndex(new Set([...(repoFiles ?? []), ...changed].filter(exists)));
      for (const n of scanPhp(f.text)) add(f.path, resolvePhp(n, php));
    }
  }
  return { edges, scanned, unsupported, unread, skipped: null };
}
