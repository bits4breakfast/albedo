/**
 * Where the work stood: the branch and HEAD a reminder records when it is
 * set, and how a task's HEAD compares with that when its card shows.
 *
 * Read with git, never from the terminal. Every failure is "git could not
 * say" (null), which the card shows as nothing rather than as a guess.
 */

import { git, parseAheadBehind } from '../git/worktree';

export interface HeadSnapshot {
  /** The checked-out branch; null on a detached HEAD or when git could not say. */
  branch: string | null;
  sha: string | null;
}

/** The folder's branch and full HEAD sha. */
export async function headSnapshot(cwd: string): Promise<HeadSnapshot> {
  const [sha, ref] = await Promise.all([
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).catch(() => null),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).catch(() => null),
  ]);
  return {
    sha: sha?.code === 0 && sha.stdout.trim() !== '' ? sha.stdout.trim() : null,
    branch: ref?.code === 0 && ref.stdout.trim() !== '' ? ref.stdout.trim() : null,
  };
}

/** How HEAD now relates to the recorded commit. */
export type HeadCompare =
  | { kind: 'same' }
  | { kind: 'moved'; ahead: number; behind: number; now: string }
  /** The recorded commit is not in this repository any more. */
  | { kind: 'gone' }
  /** Nothing was recorded, or git could not say. */
  | { kind: 'unknown' };

export async function compareHead(cwd: string, recorded: string | null): Promise<HeadCompare> {
  if (recorded === null) return { kind: 'unknown' };
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).catch(() => null);
  if (head?.code !== 0) return { kind: 'unknown' };
  const now = head.stdout.trim();
  if (now === recorded) return { kind: 'same' };
  const exists = await git(['cat-file', '-e', `${recorded}^{commit}`], cwd).catch(() => null);
  if (exists === null) return { kind: 'unknown' };
  if (exists.code !== 0) return { kind: 'gone' };
  // `<recorded>...HEAD`: left is only in the recorded commit, right only in HEAD.
  const counts = await git(['rev-list', '--left-right', '--count', `${recorded}...HEAD`], cwd).catch(() => null);
  const ab = counts?.code === 0 ? parseAheadBehind(counts.stdout) : null;
  if (!ab) return { kind: 'unknown' };
  // parseAheadBehind reads "<left> <right>" as ahead/behind of the left side.
  return { kind: 'moved', ahead: ab.behind, behind: ab.ahead, now: now.slice(0, 7) };
}

/**
 * "Task was at a1b2c3d on fix/login-retry · now 3 ahead". Null when nothing
 * was recorded: a reminder without a commit says nothing about one.
 */
export function whereText(
  r: { branch: string | null; headSha: string | null },
  cmp: HeadCompare | null,
): string | null {
  if (r.headSha === null) return null;
  const on = r.branch ? ` on ${r.branch}` : r.branch === '' ? ' in the main checkout' : ' (detached)';
  const was = `Task was at ${r.headSha.slice(0, 7)}${on}`;
  if (cmp === null || cmp.kind === 'unknown') return was;
  if (cmp.kind === 'same') return `${was} · still there`;
  if (cmp.kind === 'gone') return `${was} · that commit is gone`;
  const parts = [cmp.ahead > 0 ? `${cmp.ahead} ahead` : '', cmp.behind > 0 ? `${cmp.behind} behind` : ''].filter(Boolean);
  return `${was} · now ${parts.length > 0 ? parts.join(', ') : `at ${cmp.now}`}`;
}
