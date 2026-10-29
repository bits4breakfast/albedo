/**
 * The branch a task is really stacked on, read from git.
 *
 * `tasks.base_branch` is the branch the worktree was cut from, confirmed when
 * the task was created. A branch can be restacked afterwards -- cut from
 * `main`, then rebased onto another task's branch -- and nothing records that
 * until a PR names its base. This reads it from the history instead, two ways:
 *
 *  - **On it.** Another branch's tip is in this branch's history and not in
 *    the base's: this branch was built on top of it. The nearest such tip wins.
 *  - **On an older copy of it.** The parent was amended or rebased and pushed
 *    since, so its tip is no longer in this history -- only a copy of its
 *    commit is. Measured on the owner's repo: a branch sitting on an amended
 *    parent matched no tip at all, and exactly one branch by commit subject.
 *    This branch then needs rebasing onto its parent.
 *
 * Either way it is a reading, not a fact: the header says it was detected,
 * and the stored base stays what Albedo diffs against.
 */

import { baseOrUpstream, git } from './worktree';

export interface StackBase {
  base: string;
  /** `on`: the parent's tip is in this history. `older`: only a copy is. */
  how: 'on' | 'older';
}

/** `refs/heads/x` -> `x`, `refs/remotes/origin/x` -> `x`; null for `origin/HEAD`. */
export function branchNameOf(ref: string): string | null {
  const m = /^refs\/(?:heads\/(.+)|remotes\/[^/]+\/(.+))$/.exec(ref.trim());
  const name = m?.[1] ?? m?.[2] ?? null;
  return name === null || name === 'HEAD' ? null : name;
}

/**
 * The nearest parent among `candidates`: `name distance` pairs, distance being
 * commits from that tip to HEAD. The task's own branch (and its remote copy)
 * is never its own base. Local and remote copies of one branch count once.
 */
export function nearestParent(candidates: ReadonlyArray<{ ref: string; distance: number }>, own: string): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const c of candidates) {
    const name = branchNameOf(c.ref);
    if (name === null || name === own || c.distance < 1) continue;
    if (best === null || c.distance < best.distance) best = { name, distance: c.distance };
  }
  return best?.name ?? null;
}

/**
 * Subjects shorter than this ("wip", "fix tests") turn up on unrelated
 * branches; only a subject this long is taken as the same commit.
 */
const MIN_SUBJECT = 16;

/**
 * A `--source` name as a branch name: `origin/x` -> `x` when `origin` is a
 * remote. Not by the slash alone: local branches have slashes too
 * (`backup/pre-rebase`). Null for a remote's `HEAD`.
 */
export function sourceBranchName(source: string, remotes: ReadonlySet<string>): string | null {
  const slash = source.indexOf('/');
  const name = slash > 0 && remotes.has(source.slice(0, slash)) ? source.slice(slash + 1) : source;
  return name === '' || name === 'HEAD' ? null : name;
}

/**
 * The branch holding copies of this branch's own commits, from `git log
 * --source` lines (`<source>\t<subject>`) over every branch's commits that are
 * in neither the base nor HEAD. `ownSubjects` is newest first. The one with
 * the most matches wins.
 *
 * A branch that also has a copy of the NEWEST commit is a copy of this branch
 * (a backup, a stale push of it), not what it sits on: a parent holds only the
 * commits below this branch's own.
 */
export function olderCopyParent(
  ownSubjects: readonly string[],
  sourceLines: readonly string[],
  own: string,
  remotes: ReadonlySet<string>,
): string | null {
  const mine = new Set(ownSubjects.map((s) => s.trim()).filter((s) => s.length >= MIN_SUBJECT));
  if (mine.size === 0) return null;
  const top = ownSubjects[0]?.trim() ?? '';
  const hits = new Map<string, number>();
  const copies = new Set<string>();
  for (const line of sourceLines) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const subject = line.slice(tab + 1).trim();
    if (!mine.has(subject)) continue;
    const name = sourceBranchName(line.slice(0, tab), remotes);
    if (name === null || name === own) continue;
    if (subject === top) copies.add(name);
    hits.set(name, (hits.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [name, n] of hits) {
    if (copies.has(name)) continue;
    if (best === null || n > (hits.get(best) ?? 0)) best = name;
  }
  return best;
}

async function lines(args: string[], cwd: string): Promise<string[] | null> {
  const r = await git(args, cwd);
  return r.code === 0 ? r.stdout.split('\n').filter((l) => l.length > 0) : null;
}

/**
 * What `branch` in `worktreePath` is stacked on, or null when it is on its
 * stored base (or git cannot say). Three or four git calls, ~0.2 s on a large
 * repo with ~700 unmerged branches.
 */
export async function detectStackBase(worktreePath: string, branch: string, storedBase: string): Promise<StackBase | null> {
  if (branch === '' || storedBase === '' || storedBase.startsWith('-')) return null;
  try {
    const base = await baseOrUpstream(worktreePath, storedBase);
    const mb = (await git(['merge-base', base, 'HEAD'], worktreePath)).stdout.trim();
    if (mb === '') return null;

    // On it: tips in HEAD's history, past the base, that are not HEAD itself
    // or ahead of it (a sibling at the same commit is not a parent).
    const refs = await lines(
      ['for-each-ref', '--merged', 'HEAD', '--no-merged', base, '--no-contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
      worktreePath,
    );
    if (refs && refs.length > 0) {
      const candidates = await Promise.all(
        refs.slice(0, 20).map(async (ref) => ({
          ref,
          distance: Number((await git(['rev-list', '--count', `${ref}..HEAD`], worktreePath)).stdout.trim()) || 0,
        })),
      );
      const on = nearestParent(candidates, branch);
      if (on !== null && on !== storedBase) return { base: on, how: 'on' };
      if (on !== null) return null;
    }

    // On an older copy: the same commits, by subject, on another branch.
    const own = await lines(['log', '--no-merges', '--format=%s', '-n', '200', `${mb}..HEAD`], worktreePath);
    if (!own || own.length === 0) return null;
    const theirs = await lines(
      ['log', '--no-merges', '--source', '--format=%S%x09%s', '-n', '5000', '--branches', '--remotes', '--not', base, 'HEAD'],
      worktreePath,
    );
    const remotes = new Set((await lines(['remote'], worktreePath)) ?? []);
    const older = theirs ? olderCopyParent(own, theirs, branch, remotes) : null;
    return older !== null && older !== storedBase ? { base: older, how: 'older' } : null;
  } catch {
    return null;
  }
}
