/**
 * Go to Declaration (⌘B, ⌘-click) and Find Usages (⌥F7) from the editor.
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
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { loadCodeIndex, TYPE_KINDS, type CodeSymbol } from '../../git/codeIndex';
import type { FindMatch, FindResult } from '../../git/findInFiles';
import { isPhpPath, phpantomFor, READY_WAIT_MS, type Location } from '../../lsp/phpantom';
import {
  findPhpUsages,
  findWord,
  lastSegment,
  nameAt,
  namespacesOf,
  parsePhpHeader,
  phpTargetAt,
} from '../../git/phpRefs';

export type NavAction = 'declaration' | 'usages';

export type NavOutcome =
  | { kind: 'open'; path: string; line: number }
  | { kind: 'list'; title: string; result: FindResult }
  | { kind: 'none'; message: string };

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
  return { kind: 'list', title: `Usages of ${fqcn}`, result };
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

/** Where ⌘B or ⌥F7 at the cursor leads. */
export async function navigate(ctx: NavContext, action: NavAction): Promise<NavOutcome> {
  const { line, col, number } = lineAround(ctx.text, ctx.offset);

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

      const index = await loadCodeIndex(ctx.root);
      const short = lastSegment(target.fqcn).toLowerCase();
      const named = index.symbols.filter(
        (s) => TYPE_KINDS.has(s.kind) && s.name.toLowerCase() === short && /\.php$/i.test(s.path),
      );
      if (named.length > 0) {
        const ns = await namespacesOf(ctx.root, [...new Set(named.map((s) => s.path))]);
        const fq = (s: CodeSymbol) => {
          const space = ns.get(s.path) ?? '';
          return (space === '' ? s.name : `${space}\\${s.name}`).toLowerCase();
        };
        const exact = named.filter((s) => fq(s) === target.fqcn.toLowerCase());
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
