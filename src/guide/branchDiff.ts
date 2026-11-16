/**
 * The branch's change as the Review Guide reads it (#186): every file that
 * differs from the task's base, committed and uncommitted together -- what
 * the PR will show -- plus files not yet added to git, which the PR will show
 * once they are committed and which a guide must not quietly leave out.
 *
 * The base is {@link taskBase} (through `baseOrUpstream`, #82), and each file
 * is read exactly as the editor's Diff mode reads it (`readAtRev` for the old
 * side, the disk for the new, `composeFileDiff` between), so a block in the
 * guide is the same hunk the Diff tab shows. Renames are not paired up here:
 * a moved file is a deletion and an addition, as `--no-renames` reports it.
 */

import { DIFF_NO_REFRESH, git, taskBase } from '../git/worktree';
import { composeFileDiff, readAtRev, sideFromText, type Side, type WorkingReader } from '../git/fileDiff';
import { buildBranchDiff, type BranchDiff, type ChangedFile } from './blocks';
import { statReason } from './budget';

/** NUL-separated paths, as `-z` prints them. */
export function splitZ(stdout: string): string[] {
  return (stdout ?? '').split('\0').filter((p) => p.length > 0);
}

async function paths(args: string[], cwd: string): Promise<string[]> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} exited with ${r.code}`);
  return splitZ(r.stdout);
}

/**
 * Paths whose content or mode differs between `rev` and the working tree:
 * what `git diff --name-only` listed, without writing the index (#363). With
 * the refresh off `--name-only` would also list files whose stat is merely
 * stale; `--numstat` skips those, so the paths come from it.
 */
async function changedSince(rev: string, cwd: string): Promise<string[]> {
  const r = await git([...DIFF_NO_REFRESH, '--numstat', '--no-renames', '-z', rev, '--'], cwd);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git diff exited with ${r.code}`);
  return numstatPathsZ(r.stdout);
}

/** The paths of `--numstat -z --no-renames` output: `<added>\t<deleted>\t<path>` NUL-terminated. */
export function numstatPathsZ(stdout: string): string[] {
  const out: string[] = [];
  for (const rec of splitZ(stdout)) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(rec);
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** Untracked files git would add (ignored ones excluded). */
function untracked(cwd: string): Promise<string[]> {
  return paths(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
}

export interface LoadedBranchDiff {
  diff: BranchDiff;
  /** The commit the old side was read from. */
  base: string;
  /** False when there was no merge base and HEAD stood in. */
  fromMergeBase: boolean;
  /** Files with changes not yet committed: the "Uncommitted only" filter. */
  uncommitted: ReadonlySet<string>;
}

/** Run `fn` over `items`, at most `limit` at once, keeping their order. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The old side of each file, by the commit it was read at (#365). A commit
 * never changes, so a file read at one is the same file the next time: going
 * back to the Guide reads the base side of every changed file again, two git
 * calls each, for an answer already had. Only a full commit id is kept --
 * never `HEAD`, which moves. Per folder as well, so one repo's answer is
 * never handed to another. The last {@link MAX_BASE_READS} commits are kept,
 * as the pane keeps the last few reads (store.ts).
 */
export const MAX_BASE_READS = 3;
const baseReads = new Map<string, Map<string, Side>>();

function isCommitId(rev: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rev);
}

async function readBase(worktreePath: string, rev: string, path: string): Promise<Side> {
  if (!isCommitId(rev)) return readAtRev(worktreePath, rev, path);
  const at = `${worktreePath}\n${rev}`;
  let files = baseReads.get(at);
  if (files) {
    // Least recently used last out.
    baseReads.delete(at);
    baseReads.set(at, files);
  } else {
    files = new Map();
    baseReads.set(at, files);
    while (baseReads.size > MAX_BASE_READS) baseReads.delete(baseReads.keys().next().value as string);
  }
  const had = files.get(path);
  if (had) return had;
  // A failed read throws and is not kept: the next visit asks git again.
  const side = await readAtRev(worktreePath, rev, path);
  files.set(path, side);
  return side;
}

/** Tests only. */
export function forgetBaseReadsForTests(): void {
  baseReads.clear();
}

export async function loadBranchDiff(
  worktreePath: string,
  baseBranch: string,
  readWorking: WorkingReader,
): Promise<LoadedBranchDiff> {
  const merge = await taskBase(worktreePath, baseBranch);
  const base = merge ?? 'HEAD';
  const [tracked, loose, dirty] = await Promise.all([
    changedSince(base, worktreePath),
    untracked(worktreePath),
    changedSince('HEAD', worktreePath),
  ]);
  const all = [...new Set([...tracked, ...loose])];
  const changed: ChangedFile[] = await pool(all, 6, async (path) => {
    const [oldSide, newText] = await Promise.all([readBase(worktreePath, base, path), readWorking(path)]);
    return { path, result: composeFileDiff(oldSide, sideFromText(newText), path) };
  });
  return {
    diff: buildBranchDiff(changed, statReason),
    base,
    fromMergeBase: merge !== null,
    uncommitted: new Set([...dirty, ...loose]),
  };
}
