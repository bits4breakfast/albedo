/**
 * Go to Declaration (⌘B, ⌘-click) and Find Usages (⌥F7) from the editor.
 *
 * PHP classes go through `src/git/phpRefs.ts`, which resolves names through
 * each file's namespace and imports. Everything else -- a method, a function,
 * a TypeScript name -- falls back to the code index by name, and its usages
 * to a whole-word text search. The fallback says so in its title, so a list
 * of text matches is never mistaken for a resolved one.
 */

import { loadCodeIndex, TYPE_KINDS, type CodeSymbol } from '../../git/codeIndex';
import type { FindResult } from '../../git/findInFiles';
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

/** Where ⌘B or ⌥F7 at the cursor leads. */
export async function navigate(ctx: NavContext, action: NavAction): Promise<NavOutcome> {
  const { line, col, number } = lineAround(ctx.text, ctx.offset);

  if (/\.php$/i.test(ctx.path)) {
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
    return { kind: 'list', title: `Text matches for ${word} · not resolved, by name only`, result };
  }
  return pick(named, `Symbols named ${word} · by name only`, `No declaration of ${word} in this worktree`);
}
