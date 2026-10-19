/**
 * A file and symbol index of one worktree, for the quick-open palette.
 *
 * Built from git, not from a parser: `git ls-files` for the files and
 * `git grep` for declarations. No language server, no Rust, no dependency --
 * the shell scope already allows `git` and git is already fast at exactly
 * this. On the main target repo (10k files, 34k PHP symbols) a full build is
 * well under a second, which is why there is no on-disk cache: a 30s in-memory
 * TTL is enough to make repeat opens instant without ever being badly stale.
 *
 * ## Two passes per line
 *
 * `git grep -E` is a coarse prefilter: POSIX ERE, so no lookahead and no
 * keyword exclusion, and it only has to keep the candidate lines small. Each
 * hit is then re-read by a JS regex that decides the kind and the name, and is
 * allowed to say "not a declaration after all". Both halves live here and
 * nowhere else -- a new language is one entry in `LANGUAGES`.
 *
 * ## What this is not
 *
 * A line-based heuristic. It does not know about comments, strings or
 * heredocs, and it cannot see a declaration split across lines. Good enough to
 * jump to a name, which is all it is for; see `extractSymbol` for the known
 * false positives and negatives per language.
 */

import { git } from './worktree';

export type SymbolKind = 'class' | 'interface' | 'trait' | 'enum' | 'type' | 'function' | 'method' | 'const';

/** Kinds that "Go to Class" lists. Everything else is symbol-only. */
export const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'interface', 'trait', 'enum', 'type']);

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** Worktree-relative, as git printed it. */
  path: string;
  /** 1-based. */
  line: number;
}

export interface CodeIndex {
  root: string;
  files: string[];
  symbols: CodeSymbol[];
  /** `Date.now()` when the build finished. */
  builtAt: number;
  /** How long the build took, ms. */
  took: number;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * POSIX classes, because git's ERE on macOS is the system regcomp: no `\s`.
 * PCRE accepts them too, which is what lets one string serve both engines.
 */
const S = '[[:space:]]';
const ID = '[A-Za-z_$]';

interface Language {
  name: string;
  /** File extensions, lowercase, without the dot. */
  extensions: string[];
  /** ERE prefilters, each passed to git as `-e`. Generous by design. */
  grep: string[];
  /** The precise pass. Null rejects the line. */
  extract: (text: string) => { kind: SymbolKind; name: string } | null;
}

// --- PHP --------------------------------------------------------------------

const PHP_TYPE = /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_\x80-￿][\w\x80-￿]*)/;
const PHP_FUNC =
  /^(\s*)((?:(?:public|protected|private|static|abstract|final)\s+)*)function\s+&?\s*([A-Za-z_\x80-￿][\w\x80-￿]*)\s*\(/;

function extractPhp(text: string): { kind: SymbolKind; name: string } | null {
  const t = PHP_TYPE.exec(text);
  if (t) return { kind: t[1] as SymbolKind, name: t[2]! };
  const f = PHP_FUNC.exec(text);
  if (f) {
    // A modifier or any indentation means it is inside a class body. A
    // top-level function in a namespaced file sits at column 0.
    const method = f[2]!.length > 0 || f[1]!.length > 0;
    return { kind: method ? 'method' : 'function', name: f[3]! };
  }
  return null;
}

// --- JS / TS ----------------------------------------------------------------

const JS_ID = '[A-Za-z_$][\\w$]*';
const JS_CLASS = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${JS_ID})`);
const JS_FUNC = new RegExp(
  `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${JS_ID})`,
);
const JS_INTERFACE = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?interface\\s+(${JS_ID})`);
const JS_TYPE = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${JS_ID})\\s*[<=]`);
const JS_ENUM = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${JS_ID})`);
const JS_BINDING = new RegExp(`^(\\s*)(export\\s+)?(?:declare\\s+)?(const|let|var)\\s+(${JS_ID})\\s*(?::[^=]+)?=(?!=)\\s*(.*)$`);
const JS_ARROW_RHS = new RegExp(`^(?:async\\s+)?(?:function\\b|${JS_ID}\\s*=>)`);
const JS_METHOD = new RegExp(
  `^(\\s+)(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set|declare)\\s+)*` +
    `\\*?\\s*(#?${JS_ID})\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{\\s*$`,
);

/** Words that look like `name(...) {` but are control flow. */
const JS_NOT_METHODS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with',
  'typeof', 'new', 'await', 'super', 'try', 'finally', 'yield', 'throw', 'delete', 'void',
  // `async (x): T => {` -- an arrow argument whose return type ends in `{`.
  'async',
]);

function extractJs(text: string): { kind: SymbolKind; name: string } | null {
  let m = JS_CLASS.exec(text);
  if (m) return { kind: 'class', name: m[1]! };
  m = JS_INTERFACE.exec(text);
  if (m) return { kind: 'interface', name: m[1]! };
  m = JS_ENUM.exec(text);
  if (m) return { kind: 'enum', name: m[1]! };
  m = JS_TYPE.exec(text);
  if (m) return { kind: 'type', name: m[1]! };
  m = JS_FUNC.exec(text);
  if (m) return { kind: 'function', name: m[1]! };
  m = JS_BINDING.exec(text);
  if (m) {
    const indented = m[1]!.length > 0;
    const exported = m[2] !== undefined;
    // An indented, unexported binding is a local -- every `const onClick` in
    // every component. Module scope or exported only.
    if (indented && !exported) return null;
    const rhs = m[5]!;
    const arrowish =
      JS_ARROW_RHS.test(rhs) ||
      // `(a, b) => {` on one line, or `({` / `(` opening a multi-line param
      // list whose `=>` is further down.
      (/^(?:async\s+)?\(/.test(rhs) && (rhs.includes('=>') || !rhs.includes(')')));
    if (arrowish) return { kind: 'function', name: m[4]! };
    if (m[3] === 'const') return { kind: 'const', name: m[4]! };
    return null;
  }
  m = JS_METHOD.exec(text);
  // `=>` before the brace means the "return type" swallowed an arrow:
  // `useCallback((x): T => {` is a call, not a declaration.
  if (m && !JS_NOT_METHODS.has(m[2]!) && !/=>\s*\{\s*$/.test(text)) return { kind: 'method', name: m[2]! };
  return null;
}

// --- Python -----------------------------------------------------------------

const PY_CLASS = /^\s*class\s+([A-Za-z_]\w*)/;
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;

function extractPython(text: string): { kind: SymbolKind; name: string } | null {
  const c = PY_CLASS.exec(text);
  if (c) return { kind: 'class', name: c[1]! };
  const d = PY_DEF.exec(text);
  if (d) return { kind: d[1]!.length > 0 ? 'method' : 'function', name: d[2]! };
  return null;
}

// --- Go ---------------------------------------------------------------------

const GO_FUNC = /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)?/;

function extractGo(text: string): { kind: SymbolKind; name: string } | null {
  const f = GO_FUNC.exec(text);
  if (f) return { kind: f[1] ? 'method' : 'function', name: f[2]! };
  const t = GO_TYPE.exec(text);
  if (t) return { kind: t[2] === 'struct' ? 'class' : t[2] === 'interface' ? 'interface' : 'type', name: t[1]! };
  return null;
}

// --- Rust -------------------------------------------------------------------

const RS_VIS = '(?:pub(?:\\([^)]*\\))?\\s+)?';
const RS_FN = new RegExp(`^(\\s*)${RS_VIS}(?:(?:const|async|unsafe|extern\\s+"[^"]*")\\s+)*fn\\s+([A-Za-z_]\\w*)`);
const RS_TYPE = new RegExp(`^\\s*${RS_VIS}(struct|enum|trait|union|type)\\s+([A-Za-z_]\\w*)`);

function extractRust(text: string): { kind: SymbolKind; name: string } | null {
  const f = RS_FN.exec(text);
  // Indented means inside an `impl` or `trait` block, or a nested fn -- the
  // first two are by far the common case.
  if (f) return { kind: f[1]!.length > 0 ? 'method' : 'function', name: f[2]! };
  const t = RS_TYPE.exec(text);
  if (t) {
    const kw = t[1]!;
    const kind: SymbolKind = kw === 'enum' ? 'enum' : kw === 'trait' ? 'trait' : kw === 'type' ? 'type' : 'class';
    return { kind, name: t[2]! };
  }
  return null;
}

const RS_VIS_ERE = `(pub(\\([^)]*\\))?${S}+)?`;

export const LANGUAGES: readonly Language[] = [
  {
    name: 'php',
    extensions: ['php'],
    grep: [
      `^${S}*((abstract|final|readonly)${S}+)*(class|interface|trait|enum)${S}+[A-Za-z_]`,
      `^${S}*((public|protected|private|static|abstract|final)${S}+)*function${S}+&?${S}*[A-Za-z_]`,
    ],
    extract: extractPhp,
  },
  {
    name: 'js',
    extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'],
    grep: [
      `^${S}*(export${S}+)?(default${S}+)?(declare${S}+)?(abstract${S}+)?class${S}+${ID}`,
      `^${S}*(export${S}+)?(default${S}+)?(declare${S}+)?(async${S}+)?function${S}*\\*?${S}*${ID}`,
      `^${S}*(export${S}+)?(default${S}+)?(declare${S}+)?(interface|type|enum|const${S}+enum)${S}+${ID}`,
      // Module-scope bindings, and exported ones at any depth.
      `^(export${S}+)?(const|let|var)${S}+${ID}`,
      `^${S}*export${S}+(declare${S}+)?(const|let|var)${S}+${ID}`,
      // Class and object-literal methods: indented `name(...) {` ending the line.
      `^${S}+((public|private|protected|static|async|readonly|override|abstract|get|set|declare)${S}+)*\\*?${S}*#?${ID}[A-Za-z0-9_$]*${S}*(<[^>]*>)?${S}*\\([^)]*\\)${S}*(:[^{]*)?\\{${S}*$`,
    ],
    extract: extractJs,
  },
  {
    name: 'python',
    extensions: ['py'],
    grep: [`^${S}*class${S}+[A-Za-z_]`, `^${S}*(async${S}+)?def${S}+[A-Za-z_]`],
    extract: extractPython,
  },
  {
    name: 'go',
    extensions: ['go'],
    grep: [`^func${S}+`, `^type${S}+[A-Za-z_]`],
    extract: extractGo,
  },
  {
    name: 'rust',
    extensions: ['rs'],
    grep: [
      `^${S}*${RS_VIS_ERE}((const|async|unsafe|extern${S}+"[^"]*")${S}+)*fn${S}+[A-Za-z_]`,
      `^${S}*${RS_VIS_ERE}(struct|enum|trait|union|type)${S}+[A-Za-z_]`,
    ],
    extract: extractRust,
  },
];

const BY_EXTENSION = new Map<string, Language>();
for (const lang of LANGUAGES) for (const ext of lang.extensions) BY_EXTENSION.set(ext, lang);

/** The language a path belongs to, by extension; null when none is indexed. */
export function languageOf(path: string): Language | null {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash || dot === path.length - 1) return null;
  return BY_EXTENSION.get(path.slice(dot + 1).toLowerCase()) ?? null;
}

/** Kind and name of the declaration on `text`, or null. Dispatches on `path`. */
export function extractSymbol(path: string, text: string): { kind: SymbolKind; name: string } | null {
  const lang = languageOf(path);
  return lang ? lang.extract(text) : null;
}

/**
 * Which regex engine git grep is asked for.
 *
 * The prefilters are written in the common subset of POSIX ERE and PCRE (POSIX
 * classes, plain groups, backslash-escaped literals), so the same strings work
 * under both and produce identical hits. PCRE is 3-4x faster on the target
 * repo (PHP 1.7s -> 0.44s), but git may be built without it; the first
 * failure under `-P` drops to `-E` for the rest of the session.
 */
export type GrepFlavour = '-P' | '-E';
let flavour: GrepFlavour = '-P';

/** The engine this session uses. Shared with Find in Files, which learns the same fact. */
export function grepFlavour(): GrepFlavour {
  return flavour;
}

/** This git has no PCRE: every later grep, here or in Find in Files, uses ERE. */
export function noteNoPcre(): void {
  flavour = '-E';
}

/** The argv for one language's `git grep`. Exported so a test can pin it. */
export function grepArgs(lang: Language, engine: GrepFlavour = flavour): string[] {
  return [
    'grep',
    '-n', // line numbers
    '-z', // NUL after path and line: no colon ambiguity, no path quoting
    '-I', // skip binaries
    engine,
    '--no-color',
    // Untracked-but-not-ignored files too: an agent's new class must be
    // findable before anyone commits it, matching what ls-files lists.
    '--untracked',
    ...lang.grep.flatMap((p) => ['-e', p]),
    '--',
    ...lang.extensions.map((ext) => `*.${ext}`),
  ];
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** `git ls-files -z`: NUL-separated, deduplicated, order kept. */
export function parseLsFilesZ(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of stdout.split('\0')) {
    if (p === '' || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Parse `git grep -n` output, in either form.
 *
 * With `-z` (what we run) each record is `path\0line\0text\n` and nothing is
 * ambiguous. Without it the separators are colons, and a path may contain
 * `:12:` itself. That form is parsed too, defensively, in case the flag is ever
 * dropped: every `:<digits>:` split is a candidate, and the first whose path is
 * a known file wins. With no file list, the first candidate wins -- right for
 * every path that does not itself contain `:<digits>:`.
 *
 * A record that fits neither shape is skipped, never thrown on: one odd line
 * must not cost the whole index.
 */
export function parseGrepOutput(stdout: string, knownFiles?: ReadonlySet<string>): GrepHit[] {
  const out: GrepHit[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue;
    const a = raw.indexOf('\0');
    if (a !== -1) {
      const b = raw.indexOf('\0', a + 1);
      if (b === -1) continue;
      const line = Number(raw.slice(a + 1, b));
      if (!Number.isInteger(line) || line < 1) continue;
      out.push({ path: raw.slice(0, a), line, text: raw.slice(b + 1) });
      continue;
    }
    const hit = splitColonRecord(raw, knownFiles);
    if (hit) out.push(hit);
  }
  return out;
}

const COLON_SPLIT = /:(\d+):/g;

function splitColonRecord(raw: string, knownFiles?: ReadonlySet<string>): GrepHit | null {
  let first: GrepHit | null = null;
  COLON_SPLIT.lastIndex = 0;
  for (let m = COLON_SPLIT.exec(raw); m !== null; m = COLON_SPLIT.exec(raw)) {
    const path = raw.slice(0, m.index);
    const line = Number(m[1]);
    // Rewind so overlapping candidates (`a:1:2:x`) are all tried.
    COLON_SPLIT.lastIndex = m.index + 1;
    if (path === '' || line < 1) continue;
    const hit = { path, line, text: raw.slice(m.index + m[0].length) };
    if (!knownFiles) return hit;
    if (knownFiles.has(path)) return hit;
    first ??= hit;
  }
  return first;
}

/** Turn grep hits into symbols, dropping lines the precise pass rejects. */
export function symbolsFromHits(hits: readonly GrepHit[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (const h of hits) {
    const s = extractSymbol(h.path, h.text);
    if (s) out.push({ name: s.name, kind: s.kind, path: h.path, line: h.line });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building and caching
// ---------------------------------------------------------------------------

/** How long a built index is served before the next open rebuilds it. */
export const INDEX_TTL_MS = 30_000;

interface Entry {
  promise: Promise<CodeIndex>;
  /** The last index that finished, kept while a rebuild runs. */
  last: CodeIndex | null;
  /** When `promise` settled; null while in flight. */
  settledAt: number | null;
}

const cache = new Map<string, Entry>();

/** One language's grep, retried under ERE if this git has no PCRE. */
async function grepLanguage(lang: Language, root: string) {
  const engine = flavour;
  const r = await git(grepArgs(lang, engine), root);
  // 0 is hits, 1 is no hits; anything else under -P is most likely "not
  // compiled with PCRE", and costs one retry once per session.
  if (engine === '-P' && r.code !== 0 && r.code !== 1) {
    flavour = '-E';
    return git(grepArgs(lang, '-E'), root);
  }
  return r;
}

async function build(root: string): Promise<CodeIndex> {
  const t0 = performance.now();
  const [filesOut, ...grepOuts] = await Promise.all([
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root),
    ...LANGUAGES.map((lang) => grepLanguage(lang, root)),
  ]);
  if (filesOut!.code !== 0) throw new Error(filesOut!.stderr.trim() || 'git ls-files failed');
  const files = parseLsFilesZ(filesOut!.stdout);
  const known = new Set(files);
  const symbols: CodeSymbol[] = [];
  for (const r of grepOuts) {
    // 1 is "no lines matched", which is a valid answer for a repo with no Go.
    // Anything else loses only that language's symbols, not the palette.
    if (r.code !== 0) {
      if (r.code !== 1) console.warn('codeIndex: git grep failed', r.stderr);
      continue;
    }
    for (const s of symbolsFromHits(parseGrepOutput(r.stdout, known))) symbols.push(s);
  }
  return { root, files, symbols, builtAt: Date.now(), took: Math.round(performance.now() - t0) };
}

/**
 * The index for a worktree, building it if there is none or it is older than
 * the TTL. Concurrent callers share one build. A failed build is not cached.
 */
export function loadCodeIndex(root: string): Promise<CodeIndex> {
  const hit = cache.get(root);
  if (hit && (hit.settledAt === null || Date.now() - hit.settledAt < INDEX_TTL_MS)) return hit.promise;

  const entry: Entry = { promise: build(root), last: hit?.last ?? null, settledAt: null };
  cache.set(root, entry);
  entry.promise.then(
    (index) => {
      entry.last = index;
      entry.settledAt = Date.now();
    },
    () => {
      if (cache.get(root) === entry) {
        // Keep the last good index for `peekCodeIndex`, but force a rebuild.
        if (entry.last) cache.set(root, { promise: Promise.resolve(entry.last), last: entry.last, settledAt: 0 });
        else cache.delete(root);
      }
    },
  );
  return entry.promise;
}

/**
 * The most recent finished index for a worktree, however old, or null.
 *
 * The palette shows this immediately and swaps in the fresh one when
 * `loadCodeIndex` resolves, so a stale-by-31-seconds index never costs the
 * user an "indexing…" flash.
 */
export function peekCodeIndex(root: string): CodeIndex | null {
  return cache.get(root)?.last ?? null;
}

/** Drop the cached index for one worktree, or all of them. */
export function invalidateCodeIndex(root?: string): void {
  if (root === undefined) cache.clear();
  else {
    const entry = cache.get(root);
    // Keep `last` so peek still has something to show during the rebuild.
    if (entry?.last) cache.set(root, { promise: Promise.resolve(entry.last), last: entry.last, settledAt: 0 });
    else cache.delete(root);
  }
}
