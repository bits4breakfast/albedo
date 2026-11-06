/**
 * What the model is shown, and how much of it (#186). Pure.
 *
 * Never the raw full diff. Each block goes in as its id, its path and the
 * lines it changes with one line of context; a long block is cut to its head
 * and tail with "+N lines" between; some files go in as one stat line only.
 * The whole is estimated before anything is sent, against a budget far under
 * the model's window (measured on Claude Code 2.1.316: Haiku reports a
 * 1,000,000-token window), which leaves room for the answer and keeps a call
 * quick and cheap:
 *
 *  - fits: one call groups the blocks and writes the summaries;
 *  - does not fit: two passes -- batches of blocks, each within budget, get a
 *    one-line summary per block, then one call groups the blocks from those
 *    lines;
 *  - even the lines do not fit: Albedo groups by folder itself, and says why.
 *    Never a silent cut that looks like a complete guide.
 */

import type { DiffHunk, DiffLine } from '../types';
import type { FileDiffResult } from '../git/fileDiff';
import type { Block, BranchDiff, StatReason } from './blocks';

/** The input budget per call, in estimated tokens. */
export const INPUT_BUDGET_TOKENS = 60_000;
/** A block with more changed lines than this is cut to head and tail. */
export const BLOCK_MAX_LINES = 80;
export const BLOCK_HEAD_LINES = 50;
export const BLOCK_TAIL_LINES = 20;
/** One line longer than this is cut; a longer one is a sign of minified code. */
export const LINE_MAX_CHARS = 240;
export const MINIFIED_LINE_CHARS = 1000;
/** More changed lines than this in one file: stat line only. */
export const HUGE_FILE_LINES = 1500;
/** What one block costs in pass two (its summary line), estimated. */
export const SUMMARY_LINE_TOKENS = 60;

/**
 * Tokens, estimated. Three characters a token is pessimistic for English and
 * about right for code; over-estimating only means two passes a little early.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
  'mix.lock',
  'flake.lock',
  'Podfile.lock',
  'pubspec.lock',
]);

const GENERATED = [
  /(^|\/)(dist|build|out|gen|generated|__generated__|vendor|node_modules)\//,
  /\.generated\.[^/]+$/,
  /\.g\.dart$/,
  /\.pb\.go$/,
  /_pb2\.py$/,
  /\.snap$/,
];

const MINIFIED = [/\.min\.(js|css|mjs)$/, /\.map$/];

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Why this file is a stat line for the model, or null to show its lines. */
export function statReason(path: string, result: FileDiffResult): StatReason | null {
  if (result.kind === 'binary') return 'binary';
  if (result.kind === 'too-large') return 'too-large';
  if (LOCKFILES.has(baseName(path))) return 'lockfile';
  if (GENERATED.some((re) => re.test(path))) return 'generated';
  if (MINIFIED.some((re) => re.test(path))) return 'minified';
  if (result.kind !== 'diff') return null;
  let changed = 0;
  for (const h of result.diff.hunks) {
    for (const l of h.lines) {
      if (l.kind !== 'add' && l.kind !== 'del') continue;
      changed++;
      if (l.content.length > MINIFIED_LINE_CHARS) return 'minified';
    }
  }
  return changed > HUGE_FILE_LINES ? 'huge' : null;
}

const STAT_LABEL: Record<StatReason, string> = {
  lockfile: 'lockfile',
  generated: 'generated',
  minified: 'minified',
  binary: 'binary',
  'too-large': 'too large to read',
  huge: 'very large change',
};

function clip(text: string): string {
  return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text;
}

function lineText(l: DiffLine): string {
  const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
  return mark + clip(l.content);
}

/** The hunk's changed lines with one line of context around each run. */
export function trimContext(hunk: DiffHunk): DiffLine[] {
  const lines = hunk.lines.filter((l) => l.kind !== 'meta');
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'del') {
      keep[i] = true;
      if (i > 0) keep[i - 1] = true;
      if (i + 1 < lines.length) keep[i + 1] = true;
    }
  });
  return lines.filter((_, i) => keep[i]);
}

/** Head and tail of a long run of lines, with how many were left out. */
export function headTail(lines: readonly string[]): string[] {
  if (lines.length <= BLOCK_MAX_LINES) return [...lines];
  const cut = lines.length - BLOCK_HEAD_LINES - BLOCK_TAIL_LINES;
  return [...lines.slice(0, BLOCK_HEAD_LINES), `… +${cut} lines …`, ...lines.slice(-BLOCK_TAIL_LINES)];
}

/** One block as the model reads it. */
export function renderBlock(block: Block, diff: BranchDiff): string {
  const counts = `+${block.added} -${block.removed}`;
  if (block.stat !== null || block.hunk === null) {
    const why = block.stat !== null ? STAT_LABEL[block.stat] : 'no line changes';
    return `[${block.id}] ${block.path} (${why}, stat only) ${counts}`;
  }
  const file = diff.files.find((f) => f.path === block.path);
  const hunk = file && file.result.kind === 'diff' ? file.result.diff.hunks[block.hunk] : undefined;
  if (!hunk) return `[${block.id}] ${block.path} ${counts}`;
  const change = file?.change === 'added' ? ' (new file)' : file?.change === 'deleted' ? ' (deleted file)' : '';
  const head = `[${block.id}] ${block.path}${change} ${hunk.header.trim()}`;
  return [head, ...headTail(trimContext(hunk).map(lineText))].join('\n');
}

export type Plan =
  | { kind: 'single'; ids: string[] }
  | { kind: 'two-pass'; batches: string[][] }
  | { kind: 'folders'; reason: string };

/**
 * How to fit `ids` into calls of at most `budget` tokens each. `texts` is each
 * block as rendered. `overhead` is the instructions' share of every call.
 */
export function planInput(
  ids: readonly string[],
  texts: ReadonlyMap<string, string>,
  budget = INPUT_BUDGET_TOKENS,
  overhead = 1_500,
): Plan {
  const room = budget - overhead;
  const cost = (id: string) => estimateTokens(texts.get(id) ?? '') + 1;
  const total = ids.reduce((n, id) => n + cost(id), 0);
  if (total <= room) return { kind: 'single', ids: [...ids] };

  // Pass two reads one line per block; if even that is over, stop here.
  if (ids.length * SUMMARY_LINE_TOKENS > room) {
    return {
      kind: 'folders',
      reason: `${ids.length} changed blocks are too many to group in one call, even as one line each.`,
    };
  }

  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const id of ids) {
    const c = Math.min(cost(id), room);
    if (current.length > 0 && used + c > room) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(id);
    used += c;
  }
  if (current.length > 0) batches.push(current);
  return { kind: 'two-pass', batches };
}

/** A group Albedo makes on its own, when the model cannot be asked. */
export interface FolderGroup {
  title: string;
  blocks: string[];
}

/** Every block, grouped by the folder its file is in, in path order. */
export function groupByFolder(diff: BranchDiff): FolderGroup[] {
  const by = new Map<string, string[]>();
  for (const f of diff.files) {
    const i = f.path.lastIndexOf('/');
    const folder = i === -1 ? '(root)' : f.path.slice(0, i);
    const list = by.get(folder) ?? [];
    list.push(...f.blocks);
    by.set(folder, list);
  }
  return [...by.entries()].map(([title, blocks]) => ({ title, blocks }));
}
