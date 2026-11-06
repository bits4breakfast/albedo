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

import { git, taskBase } from '../git/worktree';
import { composeFileDiff, readAtRev, sideFromText, type WorkingReader } from '../git/fileDiff';
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

export async function loadBranchDiff(
  worktreePath: string,
  baseBranch: string,
  readWorking: WorkingReader,
): Promise<LoadedBranchDiff> {
  const merge = await taskBase(worktreePath, baseBranch);
  const base = merge ?? 'HEAD';
  const [tracked, loose, dirty] = await Promise.all([
    paths(['diff', '--name-only', '--no-renames', '-z', base, '--'], worktreePath),
    untracked(worktreePath),
    paths(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], worktreePath),
  ]);
  const all = [...new Set([...tracked, ...loose])];
  const changed: ChangedFile[] = await pool(all, 6, async (path) => {
    const [oldSide, newText] = await Promise.all([readAtRev(worktreePath, base, path), readWorking(path)]);
    return { path, result: composeFileDiff(oldSide, sideFromText(newText), path) };
  });
  return {
    diff: buildBranchDiff(changed, statReason),
    base,
    fromMergeBase: merge !== null,
    uncommitted: new Set([...dirty, ...loose]),
  };
}
