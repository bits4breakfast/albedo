/**
 * One file's change, for the editor's Diff mode.
 *
 * "This task's changes" means the same thing here as in the touched-files list
 * (`lineChanges`): the file at {@link taskBase} -- where the branch left its
 * base -- against the file in the working tree, so committed-on-branch and
 * still-uncommitted edits are one diff. The old side comes from git, the new
 * side from disk.
 *
 * Same split as worktree.ts: the `parse*` / `compose*` functions are pure and
 * unit-tested; the loaders are thin and go through `git()`, so a test can swap
 * the runner without mocking module internals. Rendering is not here -- the
 * result is a `FileDiff` for the one diff component, `transcript/Diff.tsx`.
 *
 * Why `ls-tree` + `cat-file` and not `git show <ref>:<path>`: `show` answers a
 * directory with a tree listing and a submodule with nothing useful, and it
 * reads the whole blob before we could know it is 40 MB. `ls-tree -l` says
 * what the path IS and how big it is first, and only a blob within the size
 * guard is ever read.
 */

import type { FileDiff } from '../types';
import { diffStrings } from '../lib/diff';
import { git, gitOk, taskBase } from './worktree';

/**
 * Past this, either side is not diffed at all. `diffStrings` is synchronous on
 * the UI thread; its edit-distance cap keeps the Myers search bounded, but
 * splitting, prefix-trimming and word refinement are still linear in the file
 * and a multi-megabyte generated file is not something anyone reviews line by
 * line. The renderer has its own guards (row budget, highlight line cap) for
 * what gets through.
 */
export const MAX_DIFF_BYTES = 1_500_000;

/** git's own binary heuristic: a NUL in the first 8000 bytes. */
const BINARY_SNIFF = 8000;

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

/** One side of the comparison. */
export type Side =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'binary' }
  | { kind: 'too-large'; bytes: number }
  /** A directory or a submodule at that path: nothing to diff as text. */
  | { kind: 'not-a-file' };

export function looksBinary(text: string): boolean {
  const n = Math.min(text.length, BINARY_SNIFF);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true;
  return false;
}

/** Classify content already read. Pure. */
export function sideFromText(text: string | null): Side {
  if (text === null) return { kind: 'absent' };
  if (text.length > MAX_DIFF_BYTES) return { kind: 'too-large', bytes: text.length };
  if (looksBinary(text)) return { kind: 'binary' };
  return { kind: 'text', text };
}

/** One `git ls-tree -l -z` record. */
export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  /** Null for anything that is not a blob (git prints `-`). */
  size: number | null;
  path: string;
}

/**
 * Parse `git ls-tree -l -z <ref> -- <path>`. Records are NUL-terminated and
 * each is `<mode> SP <type> SP <object> SP+ <size> TAB <path>` -- the size is
 * right-aligned with spaces, and `-z` keeps the path verbatim (no quoting).
 */
export function parseLsTree(stdout: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const rec of (stdout ?? '').split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ''));
    if (!m) continue;
    out.push({
      mode: m[1] as string,
      type: m[2] as string,
      object: m[3] as string,
      size: m[4] === '-' ? null : Number(m[4]),
      path: m[5] as string,
    });
  }
  return out;
}

/**
 * Parse `git diff --name-status -z -M`: path -> where it was renamed from.
 * Records are `<status> NUL <path> NUL`, except renames and copies, which
 * carry two paths: `R<score> NUL <from> NUL <to> NUL`.
 */
export function parseRenames(stdout: string): Map<string, string> {
  const parts = (stdout ?? '').split('\0');
  const out = new Map<string, string>();
  let i = 0;
  while (i < parts.length) {
    const status = (parts[i] ?? '').replace(/^\n/, '');
    if (status === '') {
      i++;
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = parts[i + 1];
      const to = parts[i + 2];
      if (status.startsWith('R') && from && to) out.set(to, from);
      i += 3;
      continue;
    }
    i += 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type ChangeKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged';

export type FileDiffResult =
  | {
      kind: 'diff';
      change: ChangeKind;
      diff: FileDiff;
      /** Both full texts, so the renderer can expand the unchanged gaps. */
      oldText: string;
      newText: string;
    }
  /** No text diff, and why. `change` is what we still know. */
  | { kind: 'binary'; change: ChangeKind }
  | { kind: 'too-large'; change: ChangeKind; bytes: number }
  | { kind: 'not-a-file' }
  /** Neither side exists: not in the base, not on disk. */
  | { kind: 'absent' };

/**
 * Decide what to show for a pair of sides. Pure.
 *
 * `oldPath` is where the old side was read from; when it differs from
 * `relPath` the file was renamed, and the diff's path takes the `old → new`
 * form the diff header already knows how to draw.
 */
export function composeFileDiff(oldSide: Side, newSide: Side, relPath: string, oldPath = relPath): FileDiffResult {
  if (oldSide.kind === 'not-a-file' || newSide.kind === 'not-a-file') return { kind: 'not-a-file' };
  if (oldSide.kind === 'absent' && newSide.kind === 'absent') return { kind: 'absent' };

  const renamed = oldPath !== relPath && oldSide.kind !== 'absent';
  const change: ChangeKind =
    oldSide.kind === 'absent'
      ? 'added'
      : newSide.kind === 'absent'
        ? 'deleted'
        : renamed
          ? 'renamed'
          : 'modified';

  const big = [oldSide, newSide].find((s) => s.kind === 'too-large');
  if (big && big.kind === 'too-large') return { kind: 'too-large', change, bytes: big.bytes };
  if (oldSide.kind === 'binary' || newSide.kind === 'binary') return { kind: 'binary', change };

  const oldText = oldSide.kind === 'text' ? oldSide.text : '';
  const newText = newSide.kind === 'text' ? newSide.text : '';
  const path = renamed ? `${oldPath} → ${relPath}` : relPath;
  const diff = diffStrings(oldText, newText, path);
  // A rename with identical content is still a change; an edit back to the
  // original is not.
  const same = change === 'modified' && oldText === newText;
  return { kind: 'diff', change: same ? 'unchanged' : change, diff, oldText, newText };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** Refuse a revision git would read as an option. Paths go after `--`. */
function assertRev(rev: string): void {
  if (rev.length === 0 || rev.startsWith('-')) {
    throw new Error(`Refusing to pass a revision that starts with "-": ${JSON.stringify(rev)}`);
  }
}

/** The file at `path` in `rev`, within the size guard. Never throws for a missing path. */
export async function readAtRev(worktreePath: string, rev: string, path: string): Promise<Side> {
  assertRev(rev);
  const listing = await gitOk(['ls-tree', '-l', '-z', rev, '--', path], worktreePath);
  const entry = parseLsTree(listing).find((e) => e.path === path);
  if (!entry) return { kind: 'absent' };
  if (entry.type !== 'blob') return { kind: 'not-a-file' };
  if (entry.size !== null && entry.size > MAX_DIFF_BYTES) return { kind: 'too-large', bytes: entry.size };
  // A symlink is a blob holding its target, which is what git diffs too.
  const r = await git(['cat-file', 'blob', entry.object], worktreePath);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git cat-file exited with ${r.code}`);
  return sideFromText(r.stdout);
}

/**
 * Where `relPath` was renamed from since `base`, or null. Only asked when the
 * path is absent at the base -- a rename is otherwise indistinguishable from
 * "added". Untracked files are not in a diff, so a rename to an untracked path
 * stays "added" until it is staged, exactly as `git diff` would report it.
 */
export async function renameSource(worktreePath: string, base: string, relPath: string): Promise<string | null> {
  assertRev(base);
  const r = await git(['diff', '--name-status', '-z', '-M', base, '--'], worktreePath);
  if (r.code !== 0) return null;
  return parseRenames(r.stdout).get(relPath) ?? null;
}

/** Reads the working-tree file; null when it does not exist. */
export type WorkingReader = (relPath: string) => Promise<string | null>;

export interface TaskFileDiff {
  result: FileDiffResult;
  /** The revision the old side was read from: the merge base, or HEAD. */
  base: string;
  /** False when there was no merge base and HEAD stood in for it. */
  fromMergeBase: boolean;
}

/**
 * The file's change over the whole task: {@link taskBase} (HEAD when there is
 * none) against the working tree.
 */
export async function loadTaskFileDiff(
  worktreePath: string,
  baseBranch: string,
  relPath: string,
  readWorking: WorkingReader,
): Promise<TaskFileDiff> {
  const merge = await taskBase(worktreePath, baseBranch);
  const base = merge ?? 'HEAD';
  const [newText, atBase] = await Promise.all([readWorking(relPath), readAtRev(worktreePath, base, relPath)]);
  let oldSide = atBase;
  let oldPath = relPath;
  if (atBase.kind === 'absent' && newText !== null) {
    const from = await renameSource(worktreePath, base, relPath);
    if (from !== null) {
      oldSide = await readAtRev(worktreePath, base, from);
      oldPath = from;
    }
  }
  return {
    result: composeFileDiff(oldSide, sideFromText(newText), relPath, oldPath),
    base,
    fromMergeBase: merge !== null,
  };
}
