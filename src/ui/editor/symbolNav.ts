/**
 * Go to Declaration (⌘B, ⌘-click), Find Usages (⌥F7) and, for PHP types, Go
 * to Implementation (⌥⌘B) from the editor.
 *
 * Three tiers, best first, each falling through to the next when it has no
 * answer:
 *
 * 1. PHPantom (`src/lsp/phpantom.ts`), for PHP files only and only when
 *    installed: resolves methods and properties by type, not just classes.
 * 2. `src/git/phpRefs.ts` for PHP class names: git grep, resolved through
 *    each file's namespace and imports. Needs nothing installed, and reads
 *    the disk on every lookup, so it is never stale.
 * 3. Everything else -- a TypeScript name, or a PHP name neither of the above
 *    could place -- by name from the code index, and usages by whole-word
 *    text search. Its title says so, so a list of text matches is never
 *    mistaken for a resolved one.
 *
 * Go to Implementation has the first two only: it is a question about a PHP
 * class, interface or trait, which a text search cannot answer. It runs both
 * and lists their union (see `implementations`), saying in the results what
 * that can and cannot hold.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { loadCodeIndex, TYPE_KINDS, type CodeSymbol } from '../../git/codeIndex';
import type { FindMatch, FindResult } from '../../git/findInFiles';
import { isPhpPath, phpantomFor, READY_WAIT_MS, type Location } from '../../lsp/phpantom';
import {
  declaredSpan,
  findPhpSubtypes,
  findPhpUsages,
  findWord,
  lastSegment,
  nameAt,
  namespacesOf,
  parsePhpHeader,
  phpTargetAt,
  type SupertypeKind,
} from '../../git/phpRefs';

export type NavAction = 'declaration' | 'usages' | 'implementations';

/**
 * `note`: how the answer was found, when that limits what it can contain.
 * `textSearch`: a PHP list git grep answered alone, without PHPantom, so it
 * can hold rows that only share the name (#172). The list's header says so.
 */
export type NavOutcome =
  | { kind: 'open'; path: string; line: number }
  | { kind: 'list'; title: string; result: FindResult; note?: string; textSearch?: boolean }
  | { kind: 'none'; message: string; note?: string };

export interface NavContext {
  /** The worktree (or main checkout) being browsed. */
  root: string;
  /** The open file, worktree-relative. */
  path: string;
  text: string;
  /** Cursor offset into `text`. */
  offset: number;
}

/** The line around `offset`, and the cursor's column on it. */
function lineAround(text: string, offset: number): { line: string; col: number; number: number } {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const endAt = text.indexOf('\n', offset);
  const end = endAt === -1 ? text.length : endAt;
  let number = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < start; i = text.indexOf('\n', i + 1)) number++;
  return { line: text.slice(start, end), col: offset - start, number };
}

/** Symbols as a result list: one group per file, the name highlighted. */
export function symbolsAsResult(symbols: readonly CodeSymbol[]): FindResult {
  const groups = new Map<string, FindResult['groups'][number]>();
  for (const s of symbols) {
    const text = `${s.kind} ${s.name}`;
    const match = { path: s.path, line: s.line, text, ranges: [[s.kind.length + 1, text.length]] as Array<[number, number]> };
    const g = groups.get(s.path);
    if (g) g.matches.push(match);
    else groups.set(s.path, { path: s.path, matches: [match] });
  }
  return { groups: [...groups.values()], count: symbols.length, capped: false };
}

function pick(symbols: readonly CodeSymbol[], title: string, empty: string): NavOutcome {
  if (symbols.length === 0) return { kind: 'none', message: empty };
  if (symbols.length === 1) return { kind: 'open', path: symbols[0]!.path, line: symbols[0]!.line };
  return { kind: 'list', title, result: symbolsAsResult(symbols) };
}

async function phpUsages(root: string, fqcn: string): Promise<NavOutcome> {
  const result = await findPhpUsages(root, fqcn);
  if (result.count === 0) return { kind: 'none', message: `No usages of ${fqcn}` };
  return { kind: 'list', title: `Usages of ${fqcn}`, result, textSearch: true };
}

/**
 * Locations as a result list, each row the line as it is on disk with the
 * name marked. A file that cannot be read keeps its rows, unmarked.
 */
export async function locationsAsResult(
  root: string,
  locations: readonly Location[],
  word: string,
  read: (absolute: string) => Promise<string> = readTextFile,
): Promise<FindResult> {
  const texts = new Map<string, string[] | null>();
  for (const path of new Set(locations.map((l) => l.path))) {
    texts.set(path, await read(`${root}/${path}`).then((t) => t.split('\n'), () => null));
  }
  const re = new RegExp(`(?<![\\w$\\\\])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'gi');
  const groups = new Map<string, FindMatch[]>();
  const sorted = [...locations].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const loc of sorted) {
    const text = texts.get(loc.path)?.[loc.line - 1] ?? '';
    const ranges: Array<[number, number]> = [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
    const match: FindMatch = { path: loc.path, line: loc.line, text, ranges };
    const g = groups.get(loc.path);
    if (g) {
      if (!g.some((m) => m.line === loc.line)) g.push(match);
    } else groups.set(loc.path, [match]);
  }
  const out = [...groups].map(([path, matches]) => ({ path, matches }));
  return { groups: out, count: out.reduce((n, g) => n + g.matches.length, 0), capped: false };
}

/**
 * Tier 1. Null whenever PHPantom has nothing to say -- not installed, not
 * ready within `READY_WAIT_MS`, failed, or an empty answer -- so the caller
 * falls through to git grep rather than reporting "nothing".
 */
async function viaPhpantom(ctx: NavContext, action: NavAction, line0: number, col: number, word: string): Promise<NavOutcome | null> {
  try {
    const server = await phpantomFor(ctx.root);
    if (!server || !(await server.whenReady(READY_WAIT_MS))) return null;

    if (action === 'declaration') {
      const defs = await server.definition(ctx.path, ctx.text, line0, col);
      if (defs.length === 0) return null;
      // Asked on the declaration itself: answer with its usages, as PhpStorm does.
      const self = defs.length === 1 && defs[0]!.path === ctx.path && defs[0]!.line === line0 + 1;
      if (!self) {
        if (defs.length === 1) return { kind: 'open', path: defs[0]!.path, line: defs[0]!.line };
        return { kind: 'list', title: `Declarations of ${word}`, result: await locationsAsResult(ctx.root, defs, word) };
      }
    }
    const refs = await server.references(ctx.path, ctx.text, line0, col);
    if (refs.length === 0) return null;
    return { kind: 'list', title: `Usages of ${word}`, result: await locationsAsResult(ctx.root, refs, word) };
  } catch (err) {
    console.warn('[phpantom] falling back to git grep:', err);
    return null;
  }
}

/** The PHP types this worktree declares with `fqcn`'s short name, and those that are `fqcn`. */
async function phpTypesNamed(root: string, fqcn: string): Promise<{ named: CodeSymbol[]; exact: CodeSymbol[] }> {
  const index = await loadCodeIndex(root);
  const short = lastSegment(fqcn).toLowerCase();
  const named = index.symbols.filter((s) => TYPE_KINDS.has(s.kind) && s.name.toLowerCase() === short && /\.php$/i.test(s.path));
  if (named.length === 0) return { named, exact: [] };
  const ns = await namespacesOf(root, [...new Set(named.map((s) => s.path))]);
  const fq = (s: CodeSymbol) => {
    const space = ns.get(s.path) ?? '';
    return (space === '' ? s.name : `${space}\\${s.name}`).toLowerCase();
  };
  return { named, exact: named.filter((s) => fq(s) === fqcn.toLowerCase()) };
}

/** Go to Implementation's question, per kind of type: the title of the list, and what none reads as. */
function implementationQuestion(kind: SupertypeKind, name: string): { title: string; empty: string } {
  switch (kind) {
    case 'interface':
      return { title: `Classes Implementing ${name}`, empty: `No classes implement ${name}` };
    case 'class':
      return { title: `Subclasses of ${name}`, empty: `No subclasses of ${name}` };
    case 'trait':
      return { title: `Classes Using ${name}`, empty: `No classes use ${name}` };
    case 'any':
      return { title: `Implementations of ${name}`, empty: `No implementations of ${name}` };
  }
}

/**
 * What the list can hold, said under its title after the type's full name.
 * `listed`: a grep-only answer that is a list says "Text search" in its
 * header already, so the note leaves that out rather than saying it twice; an
 * empty answer has no such header, and keeps it.
 * With PHPantom the list is the union of both engines: PHPantom's answer is
 * transitive and multi-line-proof but leaves abstract types out (measured,
 * see `PhpServer.implementation`); grep adds the direct ones it skipped. So
 * an abstract type or an extending interface is there when it names the
 * target itself, and missed only further down.
 */
function implementationNote(engines: 'both' | 'grep', kind: SupertypeKind, listed: boolean): string {
  if (engines === 'both') {
    switch (kind) {
      case 'interface':
        return 'Classes implementing it at any depth, and the abstract classes and interfaces that name it directly';
      case 'class':
        return 'Subclasses at any depth; abstract ones when they extend it directly';
      case 'trait':
        return 'Classes and traits using it, directly or through a parent class or trait';
      case 'any':
        return 'Not declared in this worktree · what PHPantom resolves, and declarations naming it in extends or implements';
    }
  }
  const how = listed ? '' : ', by text search';
  switch (kind) {
    case 'interface':
      return `Direct implementers and extending interfaces${how} · an implements list split across lines is missed`;
    case 'class':
      return `Direct subclasses${how} · an extends split across lines is missed`;
    case 'trait':
      return `Direct users${how} · a use split across lines is missed`;
    case 'any':
      return `Not declared in this worktree · direct extends and implements${how} · a list split across lines is missed`;
  }
}

/** Two result lists as one, each line once, in path then line order. */
function mergeResults(a: FindResult, b: FindResult): FindResult {
  const groups = new Map<string, FindMatch[]>();
  for (const g of [...a.groups, ...b.groups]) {
    const list = groups.get(g.path) ?? [];
    for (const m of g.matches) if (!list.some((x) => x.line === m.line)) list.push(m);
    groups.set(g.path, list);
  }
  const out = [...groups]
    .sort(([p], [q]) => p.localeCompare(q))
    .map(([path, matches]) => ({ path, matches: matches.sort((x, y) => x.line - y.line) }));
  return { groups: out, count: out.reduce((n, g) => n + g.matches.length, 0), capped: a.capped || b.capped };
}

/**
 * ⌥⌘B: the types under the PHP type at the cursor. One answer whichever
 * engines run: git grep always, and PHPantom's answer added to it when it has
 * one. A type this worktree does not declare (a vendor interface: vendor/ is
 * not indexed) is still asked, as either kind.
 */
async function implementations(ctx: NavContext, line: string, col: number, number: number): Promise<NavOutcome> {
  if (!isPhpPath(ctx.path)) return { kind: 'none', message: 'Go to Implementation works on PHP classes, interfaces and traits' };
  const target = phpTargetAt(line, col, parsePhpHeader(ctx.text.split('\n')));
  if (!target) return { kind: 'none', message: 'Put the cursor on a class, interface or trait name' };
  const short = lastSegment(target.fqcn);
  const declared = (await phpTypesNamed(ctx.root, target.fqcn)).exact[0];
  if (declared?.kind === 'enum') return { kind: 'none', message: `${short} is an enum: nothing can extend it` };
  const kind: SupertypeKind = declared ? (declared.kind as SupertypeKind) : 'any';
  const { title, empty } = implementationQuestion(kind, short);

  let found: FindResult | null = null;
  try {
    const server = await phpantomFor(ctx.root);
    if (server && (await server.whenReady(READY_WAIT_MS))) {
      const locations = await server.implementation(ctx.path, ctx.text, number - 1, col);
      if (locations.length > 0) found = declarationsAsResult(await locationsAsResult(ctx.root, locations, short));
    }
  } catch (err) {
    console.warn('[phpantom] answering with git grep only:', err);
  }
  const grepped = await findPhpSubtypes(ctx.root, target.fqcn, kind);
  const result = found ? mergeResults(found, grepped) : grepped;
  const engines = found ? 'both' : 'grep';
  const note = (listed: boolean) => `${target.fqcn} · ${implementationNote(engines, kind, listed)}`;

  if (result.count === 0) return { kind: 'none', message: empty, note: note(false) };
  const only = result.count === 1 ? result.groups[0]!.matches[0]! : null;
  if (only) return { kind: 'open', path: only.path, line: only.line };
  return { kind: 'list', title, result, note: note(true), textSearch: engines === 'grep' };
}

/** Rows that are declarations, re-marked on the name each one declares. */
function declarationsAsResult(result: FindResult): FindResult {
  const groups = result.groups.map((g) => ({
    ...g,
    matches: g.matches.map((m) => {
      const span = declaredSpan(m.text);
      return span ? { ...m, ranges: [span] } : m;
    }),
  }));
  return { ...result, groups };
}

/** Where ⌘B, ⌥F7 or ⌥⌘B at the cursor leads. */
export async function navigate(ctx: NavContext, action: NavAction): Promise<NavOutcome> {
  const { line, col, number } = lineAround(ctx.text, ctx.offset);
  if (action === 'implementations') return implementations(ctx, line, col, number);

  if (isPhpPath(ctx.path)) {
    const at = nameAt(line, col);
    if (at) {
      const answer = await viaPhpantom(ctx, action, number - 1, col, lastSegment(at.name));
      if (answer) return answer;
    }
    const header = parsePhpHeader(ctx.text.split('\n'));
    const target = phpTargetAt(line, col, header);
    if (target) {
      // On a declaration, "go to declaration" has nowhere to go; PhpStorm
      // answers the useful question instead, and so does this.
      if (action === 'usages' || target.kind === 'declaration') return phpUsages(ctx.root, target.fqcn);

      const { named, exact } = await phpTypesNamed(ctx.root, target.fqcn);
      if (named.length > 0) {
        if (exact.length > 0) return pick(exact, `Declarations of ${target.fqcn}`, '');
        // Resolved to a class nobody declares (a vendor class, a typo, a
        // missing import): offer the same-named ones rather than nothing.
        return pick(named, `${target.fqcn} is not declared here · classes named ${lastSegment(target.fqcn)}`, '');
      }
      // Not a class this worktree declares: try it as any symbol by name.
    }
  }

  const at = nameAt(line, col);
  if (!at) return { kind: 'none', message: 'Put the cursor on a name' };
  const word = lastSegment(at.name);

  const index = await loadCodeIndex(ctx.root);
  const named = index.symbols.filter((s) => s.name === word);
  const onDeclaration = named.some((s) => s.path === ctx.path && s.line === number);
  if (action === 'usages' || onDeclaration) {
    const result = await findWord(ctx.root, word);
    if (result.count === 0) return { kind: 'none', message: `No text matches for ${word}` };
    return { kind: 'list', title: `Text Matches for ${word} · Not Resolved, by Name Only`, result };
  }
  return pick(named, `Symbols named ${word} · by name only`, `No declaration of ${word} in this worktree`);
}
