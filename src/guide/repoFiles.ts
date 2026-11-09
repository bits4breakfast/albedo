/**
 * Every file git tracks in a worktree (#288): what the Map resolves an
 * import against when it points outside the change. One `git ls-files`, kept
 * per worktree for as long as the change it was read for is the same, so
 * flipping between Read and Map costs nothing.
 *
 * A failure is not an error the user sees: the map then finds imports
 * between changed files only, and draws no unchanged ones.
 */

import { git } from '../git/worktree';
import { splitZ } from './branchDiff';

/** Past this many tracked files the list is not kept: a monorepo the map would not help with. */
export const MAX_REPO_FILES = 200_000;

const cache = new Map<string, { hash: string; files: Promise<ReadonlySet<string> | null> }>();

export function repoFiles(worktreePath: string, diffHash: string): Promise<ReadonlySet<string> | null> {
  const kept = cache.get(worktreePath);
  if (kept && kept.hash === diffHash) return kept.files;
  const files = git(['ls-files', '-z'], worktreePath).then(
    (r) => {
      if (r.code !== 0) return null;
      const list = splitZ(r.stdout);
      return list.length > MAX_REPO_FILES ? null : new Set(list);
    },
    () => null,
  );
  cache.delete(worktreePath);
  cache.set(worktreePath, { hash: diffHash, files });
  // A few worktrees at most: the oldest read goes first.
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
  return files;
}
