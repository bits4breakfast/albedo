/**
 * The Review Guide's facts (#186): a branch's change, cut into blocks with
 * stable ids. Pure.
 *
 * Albedo owns these and the model never does: what changed, where, and how
 * many lines. The model only proposes how to group the ids and what to call
 * the groups (writer.ts), and validate.ts holds it to these.
 *
 * A block is one hunk of a file's diff (three lines of context, as the editor's
 * Diff mode shows it), except for a file the model gets as a stat line only
 * (budget.ts: lockfiles, generated, minified, binary, huge): that file is ONE
 * block, so it still lands in exactly one group.
 *
 * Ids come from the content -- the path and the lines the hunk adds and
 * removes -- not from line numbers or position, so an edit elsewhere in the
 * file leaves a block's id alone and a guide written before it still knows the
 * block. Four base-36 characters; a collision within one diff gets a suffix,
 * in path then hunk order, so the same diff always gets the same ids.
 */

import type { DiffHunk } from '../types';
import type { ChangeKind, FileDiffResult } from '../git/fileDiff';

/** Why a file goes to the model as one stat line instead of its lines. */
export type StatReason = 'lockfile' | 'generated' | 'minified' | 'binary' | 'too-large' | 'huge';

/** One file of the branch's change, as read from git and disk. */
export interface ChangedFile {
  path: string;
  result: FileDiffResult;
}

export interface Block {
  id: string;
  path: string;
  /** Index into the file's hunks; null for a stat-only file's single block. */
  hunk: number | null;
  added: number;
  removed: number;
  /** Set when the model sees only a stat line for this block's file. */
  stat: StatReason | null;
}

export interface GuideFile {
  path: string;
  change: ChangeKind | null;
  result: FileDiffResult;
  /** This file's block ids, in file order. */
  blocks: string[];
  added: number;
  removed: number;
  stat: StatReason | null;
}

export interface BranchDiff {
  files: GuideFile[];
  blocks: ReadonlyMap<string, Block>;
  /** Every block id, path then file order: the "reading order" Albedo would use alone. */
  order: string[];
  /** Changes whenever any block does: the cache key. */
  hash: string;
}

/** 32-bit FNV-1a. Not cryptographic; an id, not a secret. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function base36(n: number, width: number): string {
  return n.toString(36).padStart(width, '0').slice(-width);
}

/** What identifies a hunk: its path and the lines it removes and adds. */
export function hunkSignature(path: string, hunk: DiffHunk): string {
  const parts: string[] = [path];
  for (const l of hunk.lines) {
    if (l.kind === 'add') parts.push(`+${l.content}`);
    else if (l.kind === 'del') parts.push(`-${l.content}`);
  }
  return parts.join('\n');
}

export function countHunk(hunk: DiffHunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of hunk.lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/** Hands out ids, suffixing a collision so each stays unique within one diff. */
function idMinter(): (signature: string) => string {
  const used = new Set<string>();
  return (signature) => {
    const base = base36(fnv1a(signature), 4);
    let id = base;
    for (let n = 0; used.has(id); n++) id = `${base}${n.toString(36)}`;
    used.add(id);
    return id;
  };
}

export type StatClassifier = (path: string, result: FileDiffResult) => StatReason | null;

/**
 * Cut a branch's changed files into blocks. `classify` says which files go to
 * the model as a stat line (budget.ts's `statReason` in production).
 */
export function buildBranchDiff(changed: readonly ChangedFile[], classify: StatClassifier): BranchDiff {
  const sorted = [...changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const mint = idMinter();
  const blocks = new Map<string, Block>();
  const files: GuideFile[] = [];
  const order: string[] = [];

  for (const f of sorted) {
    const r = f.result;
    if (r.kind === 'absent' || r.kind === 'not-a-file') continue;
    if (r.kind === 'diff' && r.change === 'unchanged') continue;
    const change = 'change' in r ? r.change : null;
    const stat = classify(f.path, r);
    const hunks = r.kind === 'diff' ? r.diff.hunks : [];
    const counts = hunks.map(countHunk);
    const added = counts.reduce((n, c) => n + c.added, 0);
    const removed = counts.reduce((n, c) => n + c.removed, 0);

    const ids: string[] = [];
    if (stat !== null || hunks.length === 0) {
      // One block for the whole file: a stat-only file, or one with no lines
      // to show (a pure rename). Its id still follows the content, so a
      // regenerated lockfile is a new block.
      const sig = [f.path, `#${r.kind}`, ...hunks.map((h) => hunkSignature(f.path, h))].join('\n');
      const id = mint(sig);
      blocks.set(id, { id, path: f.path, hunk: null, added, removed, stat });
      ids.push(id);
    } else {
      hunks.forEach((h, i) => {
        const id = mint(hunkSignature(f.path, h));
        const c = counts[i] ?? { added: 0, removed: 0 };
        blocks.set(id, { id, path: f.path, hunk: i, added: c.added, removed: c.removed, stat: null });
        ids.push(id);
      });
    }
    order.push(...ids);
    files.push({ path: f.path, change, result: r, blocks: ids, added, removed, stat });
  }

  return { files, blocks, order, hash: base36(fnv1a(order.join(',')), 7) + order.length.toString(36) };
}

/** path -> its block ids, as a guide records them to tell what changed since. */
export function fileBlockIndex(diff: BranchDiff): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of diff.files) out[f.path] = [...f.blocks];
  return out;
}
