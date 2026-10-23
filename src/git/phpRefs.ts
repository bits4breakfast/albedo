/**
 * Namespace-aware class navigation for PHP: go to a class's declaration,
 * find the files that use it, and find the types that implement, extend or
 * use it.
 *
 * Same engine as the code index -- `git grep` plus a precise pass in JS, no
 * parser and no language server (the spec rules out LSP). What makes it better
 * than a name search is that every candidate is RESOLVED the way PHP resolves
 * it: through the file's `namespace` and its top-level `use` imports, aliases
 * included. Two classes both called `Dto` in different namespaces are two
 * different classes here.
 *
 * ## Known limits
 *
 * Line-based, like the index. A `use` group split across lines
 * (`use A\{` ... `};`) is not read, nor is a name built at runtime
 * (`$class = 'App\\Foo'; new $class`). Imports are recognised only at the
 * start of a line, which is what PSR-12 writes; an indented `use` is a trait
 * use inside a class body and is treated as a reference, which it is. For
 * the same reason a declaration whose `extends` or `implements` list goes on
 * past its first line is read from that line only, and an anonymous class
 * (`new class extends Foo`) is not a declaration here.
 */

import { git } from './worktree';
import { FIND_CAP, type FindGroup, type FindMatch, type FindResult } from './findInFiles';

// ---------------------------------------------------------------------------
// Reading a file's header
// ---------------------------------------------------------------------------

export interface PhpHeader {
  /** The file's namespace, '' for the global one. */
  namespace: string;
  /** Imported classes: lowercased alias -> fully qualified name. */
  uses: Map<string, string>;
}

const NAMESPACE_LINE = /^\s*namespace\s+([A-Za-z_\x80-￿][\w\x80-￿\\]*)\s*[;{]/;
/** A top-level import. Indented `use` is a trait use, never an import. */
const USE_LINE = /^use\s+(?!function\b|const\b)([^;]+);/i;

/** Strip a leading backslash; class names are case-insensitive, so compare lowered. */
function norm(name: string): string {
  return name.replace(/^\\/, '');
}

export function lastSegment(name: string): string {
  const i = name.lastIndexOf('\\');
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * The imports one `use` line declares, as [alias, fqcn] pairs. Handles
 * `use A\B;`, `use A\B as C;`, `use A\B, C\D;` and a one-line group
 * `use A\{B, C as D};`. Null when the line is not an import.
 */
export function parseUseLine(line: string): Array<[string, string]> | null {
  const m = USE_LINE.exec(line);
  if (!m) return null;
  const out: Array<[string, string]> = [];
  const body = m[1] as string;
  const group = /^\s*([\w\x80-￿\\]+)\\\{([^}]*)\}\s*$/.exec(body);
  const parts = group
    ? (group[2] as string).split(',').map((p) => `${group[1]}\\${p.trim()}`)
    : body.split(',');
  for (const raw of parts) {
    const p = /^\s*\\?([\w\x80-￿\\]+)(?:\s+as\s+([\w\x80-￿]+))?\s*$/i.exec(raw);
    if (!p) continue;
    const fqcn = p[1] as string;
    out.push([(p[2] ?? lastSegment(fqcn)).toLowerCase(), fqcn]);
  }
  return out;
}

/** Namespace and imports, from a whole file or just its header lines. */
export function parsePhpHeader(lines: Iterable<string>): PhpHeader {
  const header: PhpHeader = { namespace: '', uses: new Map() };
  for (const line of lines) {
    const ns = NAMESPACE_LINE.exec(line);
    if (ns) {
      header.namespace = ns[1] as string;
      continue;
    }
    for (const [alias, fqcn] of parseUseLine(line) ?? []) header.uses.set(alias, fqcn);
  }
  return header;
}

/**
 * Resolve a class name as written in a file to its fully qualified name, the
 * way PHP does: a leading `\` is absolute, `namespace\X` is the current
 * namespace, an imported first segment is replaced by its import, and
 * anything else is relative to the file's namespace.
 */
export function resolveClassName(name: string, header: PhpHeader): string {
  if (name.startsWith('\\')) return name.slice(1);
  if (/^namespace\\/i.test(name)) return join(header.namespace, name.slice('namespace\\'.length));
  const cut = name.indexOf('\\');
  const first = cut === -1 ? name : name.slice(0, cut);
  const imported = header.uses.get(first.toLowerCase());
  if (imported) return cut === -1 ? imported : `${imported}${name.slice(cut)}`;
  return join(header.namespace, name);
}

function join(ns: string, name: string): string {
  return ns === '' ? name : `${ns}\\${name}`;
}

// ---------------------------------------------------------------------------
// What is under the cursor
// ---------------------------------------------------------------------------

const NAME_CHAR = /[\w\x80-￿\\]/;

/** The (possibly qualified) name around `offset` on `line`, with its span. */
export function nameAt(line: string, offset: number): { name: string; from: number; to: number } | null {
  let from = offset;
  let to = offset;
  while (from > 0 && NAME_CHAR.test(line[from - 1] as string)) from--;
  while (to < line.length && NAME_CHAR.test(line[to] as string)) to++;
  const name = line.slice(from, to).replace(/\\+$/, '');
  if (!/^\\?[A-Za-z_\x80-￿]/.test(name)) return null;
  return { name, from, to: from + name.length };
}

const DECLARATION = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_\x80-￿][\w\x80-￿]*)/i;

/** The class, interface, trait or enum a line declares, if any. */
export function declaredOn(line: string): string | null {
  return DECLARATION.exec(line)?.[1] ?? null;
}

export type PhpTarget =
  /** The name is the declaration itself: the useful question is who uses it. */
  | { kind: 'declaration'; fqcn: string }
  | { kind: 'reference'; fqcn: string; written: string };

/**
 * What a click on `line` at `offset` refers to, in a file with `header`.
 * Null when the cursor is not on a name, or on a member (`->x`, `::x`, `$x`).
 */
export function phpTargetAt(line: string, offset: number, header: PhpHeader): PhpTarget | null {
  const at = nameAt(line, offset);
  if (!at) return null;
  const before = line.slice(0, at.from);
  if (/(\$|->|::)$/.test(before)) return null;
  if (/^(self|static|parent)$/i.test(at.name)) return null;

  const declared = declaredOn(line);
  if (declared !== null && declared.toLowerCase() === at.name.toLowerCase() && /(class|interface|trait|enum)\s+$/i.test(before)) {
    return { kind: 'declaration', fqcn: join(header.namespace, declared) };
  }

  const imports = parseUseLine(line);
  if (imports) {
    // Names in an import are absolute. Pick the import the cursor is on: in a
    // group (`use A\{B, C}`) the cursor sits on one member's last segment.
    const written = lastSegment(norm(at.name)).toLowerCase();
    const hit = imports.find(([, fqcn]) => lastSegment(fqcn).toLowerCase() === written);
    if (hit) return { kind: 'reference', fqcn: hit[1], written: at.name };
  }
  return { kind: 'reference', fqcn: resolveClassName(at.name, header), written: at.name };
}

// ---------------------------------------------------------------------------
// Matching references on a line
// ---------------------------------------------------------------------------

/**
 * Every class-name token on a line. Not after `$` (a variable), `->` or `::`
 * (a member), and not inside a longer name.
 */
const TOKEN = /(?<![\w\x80-￿$\\]|->|::)\\?[A-Za-z_\x80-￿][\w\x80-￿]*(?:\\[A-Za-z_\x80-￿][\w\x80-￿]*)*/g;

/**
 * The spans on `line` that refer to `fqcn`, in a file with `header`. A
 * declaration of the class itself is not a usage and yields nothing.
 */
export function referencesOn(line: string, fqcn: string, header: PhpHeader): Array<[number, number]> {
  const target = fqcn.toLowerCase();
  const short = lastSegment(target);

  const declared = declaredOn(line);
  if (declared !== null && join(header.namespace, declared).toLowerCase() === target) return [];
  if (NAMESPACE_LINE.test(line)) return [];

  const imports = parseUseLine(line);
  if (imports) {
    if (!imports.some(([, f]) => f.toLowerCase() === target)) return [];
    // Mark the class's own name in the import, whichever form it was written in.
    const out: Array<[number, number]> = [];
    const re = new RegExp(`(?<![\\w\\x80-\\uffff$])${escape(lastSegment(fqcn))}(?![\\w\\x80-\\uffff])`, 'gi');
    for (let m = re.exec(line); m; m = re.exec(line)) out.push([m.index, m.index + m[0].length]);
    return out.slice(0, 1);
  }

  const aliases = new Set([short]);
  for (const [alias, f] of header.uses) if (f.toLowerCase() === target) aliases.add(alias);

  const out: Array<[number, number]> = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(line); m; m = TOKEN.exec(line)) {
    const token = m[0];
    // Cheap filter first: the class's own name or an alias of it must end the
    // token. Resolving then settles which class that name means here.
    if (!aliases.has(lastSegment(token).toLowerCase())) continue;
    if (resolveClassName(token, header).toLowerCase() === target) out.push([m.index, m.index + token.length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching subtypes on a line
// ---------------------------------------------------------------------------

/** What Go to Implementation can be asked of: the kinds a type can extend, implement or use. */
export type SupertypeKind = 'class' | 'interface' | 'trait';

const DECLARATION_HEAD = /^(\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+)([A-Za-z_\x80-￿][\w\x80-￿]*)/i;

/** The span of the name a line declares, or null when it declares nothing. */
export function declaredSpan(line: string): [number, number] | null {
  const m = DECLARATION_HEAD.exec(line);
  if (!m) return null;
  const from = (m[1] as string).length;
  return [from, from + (m[3] as string).length];
}

/**
 * The span of the type `line` declares when that declaration extends or
 * implements `fqcn` (a `kind`): `class X extends Name`, `class X implements
 * A, Name`, `enum X: string implements Name`, `interface X extends Name`.
 * Null otherwise -- also for a trait, whose users are `traitUseOn`'s.
 */
export function subtypeDeclaredOn(line: string, fqcn: string, kind: SupertypeKind, header: PhpHeader): [number, number] | null {
  if (kind === 'trait') return null;
  const m = DECLARATION_HEAD.exec(line);
  if (!m) return null;
  const declares = (m[2] as string).toLowerCase();
  // The clause the target must be named in, for what this line declares.
  const clause =
    kind === 'class' ? (declares === 'class' ? 'extends' : null)
    : declares === 'interface' ? 'extends'
    : declares === 'class' || declares === 'enum' ? 'implements'
    : null;
  if (!clause) return null;

  const start = m[0].length;
  const cut = /\{|\/\/|\/\*|#/.exec(line.slice(start));
  const rest = line.slice(start, cut ? start + cut.index : line.length);
  const extendsAt = /\bextends\b/i.exec(rest);
  const implementsAt = /\bimplements\b/i.exec(rest);
  const at = clause === 'extends' ? extendsAt : implementsAt;
  if (!at) return null;
  const from = start + at.index + at[0].length;
  const ends = clause === 'extends' && implementsAt && implementsAt.index > at.index ? start + implementsAt.index : start + rest.length;

  const named = referencesOn(line, fqcn, header).some(([a, b]) => a >= from && b <= ends);
  return named ? declaredSpan(line) : null;
}

/** An indented `use A, B;` (or `use A { ... }`): traits used inside a class body. */
const TRAIT_USE = /^(\s+use\s+)(?!function\b|const\b)([^;{]+)/i;

/** Whether `line` uses trait `fqcn` inside a class, enum or trait body. */
export function traitUseOn(line: string, fqcn: string, header: PhpHeader): boolean {
  const m = TRAIT_USE.exec(line);
  if (!m) return false;
  const from = (m[1] as string).length;
  const to = from + (m[2] as string).length;
  return referencesOn(line, fqcn, header).some(([a, b]) => a >= from && b <= to);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** `path\0line\0text` records, as `git grep -n -z` prints them. */
interface Hit {
  path: string;
  line: number;
  text: string;
}

function parseZ(stdout: string): Hit[] {
  const out: Hit[] = [];
  for (const raw of stdout.split('\n')) {
    const a = raw.indexOf('\0');
    const b = a === -1 ? -1 : raw.indexOf('\0', a + 1);
    if (b === -1) continue;
    const line = Number(raw.slice(a + 1, b));
    if (Number.isInteger(line) && line > 0) out.push({ path: raw.slice(0, a), line, text: raw.slice(b + 1) });
  }
  return out;
}

async function grep(root: string, args: string[], paths: string[]): Promise<Hit[]> {
  const r = await git(['grep', '-n', '-z', '-I', '--no-color', '--untracked', ...args, '--', ...paths], root);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new Error(r.stderr.replace(/^fatal:\s*/m, '').trim() || `git grep exited ${r.code}`);
  return parseZ(r.stdout);
}

/** Paths per git call: keeps argv well under the OS limit on a large result. */
const CHUNK = 300;

async function grepChunked(root: string, args: string[], paths: string[]): Promise<Hit[]> {
  const out: Hit[] = [];
  for (let i = 0; i < paths.length; i += CHUNK) out.push(...(await grep(root, args, paths.slice(i, i + CHUNK))));
  return out;
}

/** The header (namespace and imports) of each file. */
export async function readHeaders(root: string, paths: string[]): Promise<Map<string, PhpHeader>> {
  // ERE with a POSIX class: valid whether or not this git has PCRE.
  const lines = new Map<string, string[]>();
  for (const h of await grepChunked(root, ['-E', '-i', '-e', '^(namespace|use)[[:space:]]'], paths)) {
    const list = lines.get(h.path);
    if (list) list.push(h.text);
    else lines.set(h.path, [h.text]);
  }
  const out = new Map<string, PhpHeader>();
  for (const p of paths) out.set(p, parsePhpHeader(lines.get(p) ?? []));
  return out;
}

/**
 * Every reference to class `fqcn` in the worktree's PHP files, grouped by file
 * the way Find in Files shows them.
 *
 * 1. A whole-word, case-insensitive grep for the short name finds every file
 *    that could mention it, directly or through a namespace import.
 * 2. Those files' headers say what the name means in each.
 * 3. A file that imports the class under an alias is grepped again for the
 *    alias, which step 1 could not have found.
 * 4. Each line keeps only the tokens that resolve to `fqcn`.
 */
export async function findPhpUsages(root: string, fqcn: string): Promise<FindResult> {
  const { hits, headers } = await candidateLines(root, fqcn);
  return toResult(hits, (h) => {
    const header = headers.get(h.path);
    return header ? referencesOn(h.text, fqcn, header) : [];
  });
}

/** Steps 1 to 3 of `findPhpUsages`: every line that could name `fqcn`, and its file's header. */
async function candidateLines(root: string, fqcn: string): Promise<{ hits: Hit[]; headers: Map<string, PhpHeader> }> {
  const short = lastSegment(fqcn);
  const hits = await grep(root, ['-w', '-i', '-F', '-e', short], ['*.php']);
  const files = [...new Set(hits.map((h) => h.path))];
  const headers = await readHeaders(root, files);

  const target = fqcn.toLowerCase();
  const byAlias = new Map<string, string[]>();
  for (const [path, header] of headers) {
    for (const [alias, f] of header.uses) {
      if (f.toLowerCase() !== target || alias === short.toLowerCase()) continue;
      const list = byAlias.get(alias);
      if (list) list.push(path);
      else byAlias.set(alias, [path]);
    }
  }
  for (const [alias, paths] of byAlias) hits.push(...(await grepChunked(root, ['-w', '-i', '-F', '-e', alias], paths)));
  return { hits, headers };
}

/**
 * The types that extend, implement or use `fqcn`, one row per declaration
 * line with the declared name marked: the direct subclasses of a class; the
 * classes, enums and interfaces naming an interface; the classes, enums and
 * traits using a trait. Direct only, and line-based like the rest of this
 * file (see Known limits).
 *
 * A trait use sits inside the class body, so its row is the nearest
 * declaration above it, read with one more grep over those files.
 */
export async function findPhpSubtypes(root: string, fqcn: string, kind: SupertypeKind): Promise<FindResult> {
  const { hits, headers } = await candidateLines(root, fqcn);
  const headerOf = (h: Hit) => headers.get(h.path) ?? parsePhpHeader([]);
  if (kind !== 'trait') {
    return toResult(hits, (h) => {
      const span = subtypeDeclaredOn(h.text, fqcn, kind, headerOf(h));
      return span ? [span] : [];
    });
  }

  const uses = hits.filter((h) => traitUseOn(h.text, fqcn, headerOf(h)));
  const files = [...new Set(uses.map((h) => h.path))];
  const declarations = await grepChunked(
    root,
    ['-E', '-i', '-e', '^[[:space:]]*((abstract|final|readonly)[[:space:]]+)*(class|trait|enum)[[:space:]]'],
    files,
  );
  const owners = uses.map((use) => {
    let owner: Hit | null = null;
    for (const d of declarations) {
      if (d.path === use.path && d.line <= use.line && (!owner || d.line > owner.line) && declaredSpan(d.text)) owner = d;
    }
    return owner ?? use;
  });
  return toResult(owners, (h) => {
    const span = declaredSpan(h.text);
    return span ? [span] : referencesOn(h.text, fqcn, headerOf(h));
  });
}

/**
 * Whole-word, case-sensitive text matches for `word` in every file: the
 * fallback for a name that is not a resolvable PHP class. `git grep -w`
 * rather than a `\b` pattern, which macOS's ERE does not support.
 */
export async function findWord(root: string, word: string): Promise<FindResult> {
  const hits = await grep(root, ['-w', '-F', '-e', word], []);
  const re = new RegExp(`(?<![\\w\\x80-\\uffff])${escape(word)}(?![\\w\\x80-\\uffff])`, 'g');
  return toResult(hits, (h) => {
    const out: Array<[number, number]> = [];
    for (const m of h.text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
    return out;
  });
}

/** Group hits by file, in path then line order, keeping lines `rangesFor` marks. */
function toResult(hits: Hit[], rangesFor: (h: Hit) => Array<[number, number]>): FindResult {
  const groups = new Map<string, FindMatch[]>();
  const seen = new Set<string>();
  let count = 0;
  let capped = false;
  for (const h of hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) {
    const key = `${h.path}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ranges = rangesFor(h);
    if (ranges.length === 0) continue;
    if (count >= FIND_CAP) {
      capped = true;
      break;
    }
    count++;
    const list = groups.get(h.path);
    const match: FindMatch = { path: h.path, line: h.line, text: h.text, ranges };
    if (list) list.push(match);
    else groups.set(h.path, [match]);
  }
  const out: FindGroup[] = [...groups].map(([path, matches]) => ({ path, matches }));
  return { groups: out, count, capped };
}

/** The namespace each file declares, for telling same-named classes apart. */
export async function namespacesOf(root: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, header] of await readHeaders(root, paths)) out.set(path, header.namespace);
  return out;
}
