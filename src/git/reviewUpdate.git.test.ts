/**
 * Update Copy against real git (#352): a review copy checked out from a PR
 * ref, the PR moving on upstream, and the copy following it -- by a
 * fast-forward, or after a force-push by `reset --keep`, which keeps a local
 * edit it does not have to touch and refuses one it would, leaving HEAD where
 * it was. Then what "Since your review" lists for each.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePrUrl } from './reviewCheckout';
import { explainMaterial, parseSinceLog, readCopy, sinceChanges, updateReviewCopy } from './reviewUpdate';
import { GitError, setGitRunner, type GitRunner } from './worktree';
import { makeReviewRepo, realGit, sh, type ReviewRepo } from './reviewRepo.fixture';

const pr = parsePrUrl('https://github.com/acme/relay/pull/1')!;
let repo: ReviewRepo;
let restore: GitRunner;

beforeEach(() => {
  repo = makeReviewRepo();
  restore = realGit();
}, 30_000);
afterEach(() => {
  setGitRunner(restore);
  repo.cleanup();
});

describe('updateReviewCopy', { timeout: 30_000 }, () => {
  it('fast-forwards the copy to the PR’s new head, and refreshes the base', async () => {
    const before = repo.head(repo.copy);
    const next = repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    const main = repo.pushToMain('c.txt', 'c\n', 'Main moves');
    const seen: string[] = [];
    const r = await updateReviewCopy(repo.copy, pr, 'main', (p) => seen.push(p));
    expect(r).toEqual({ prev: before, next, forced: false, moved: true, kept: null });
    expect(seen).toEqual([before]);
    expect(repo.head(repo.copy)).toBe(next);
    // Still on review/1, which moved with it.
    expect(sh(repo.copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('review/1');
    expect(sh(repo.local, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(main);
  });

  it('says so, and moves nothing, when the copy is already at the head', async () => {
    const at = repo.head(repo.copy);
    expect(await updateReviewCopy(repo.copy, pr, 'main')).toEqual({ prev: at, next: at, forced: false, moved: false, kept: null });
  });

  it('keeps a local edit the fast-forward does not touch', async () => {
    repo.write('a.txt', 'a1\nA2\na3\nmine\n');
    const next = repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    await updateReviewCopy(repo.copy, pr, 'main');
    expect(repo.head(repo.copy)).toBe(next);
    expect(repo.read('a.txt')).toBe('a1\nA2\na3\nmine\n');
  });

  it('after a force-push, moves with reset --keep and keeps a non-conflicting local edit', async () => {
    const before = repo.head(repo.copy);
    repo.write('b.txt', 'b1\nlocal\n');
    const next = repo.forcePushPr({ 'a.txt': 'a1\nREWRITTEN\na3\n' }, 'Change a, again');
    const r = await updateReviewCopy(repo.copy, pr, 'main');
    expect(r).toEqual({ prev: before, next, forced: true, moved: true, kept: 'review/1-previous' });
    expect(sh(repo.copy, 'rev-parse', 'review/1-previous').trim()).toBe(before);
    expect(repo.head(repo.copy)).toBe(next);
    expect(repo.read('a.txt')).toBe('a1\nREWRITTEN\na3\n');
    expect(repo.read('b.txt')).toBe('b1\nlocal\n');
  });

  it('keeps a commit made in the copy on a branch, rather than moving past it silently', async () => {
    repo.write('c.txt', 'my fix\n');
    sh(repo.copy, 'add', 'c.txt');
    sh(repo.copy, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'Try a fix');
    const mine = repo.head(repo.copy);
    const next = repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    const r = await updateReviewCopy(repo.copy, pr, 'main');
    expect(r).toMatchObject({ prev: mine, next, forced: true, moved: true, kept: 'review/1-previous' });
    expect(repo.head(repo.copy)).toBe(next);
    expect(sh(repo.copy, 'rev-parse', 'review/1-previous').trim()).toBe(mine);
  });

  it('after a force-push, refuses a conflicting local edit in git’s words and leaves HEAD and the edit alone', async () => {
    const before = repo.head(repo.copy);
    repo.write('a.txt', 'a1\nmy edit\na3\n');
    repo.forcePushPr({ 'a.txt': 'a1\nREWRITTEN\na3\n' }, 'Change a, again');
    const err = await updateReviewCopy(repo.copy, pr, 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).args.slice(0, 2)).toEqual(['reset', '--keep']);
    expect((err as GitError).stderr).toMatch(/a\.txt/);
    expect(repo.head(repo.copy)).toBe(before);
    expect(repo.read('a.txt')).toBe('a1\nmy edit\na3\n');
  });

  it('refuses a fast-forward over a conflicting local edit, HEAD unchanged', async () => {
    const before = repo.head(repo.copy);
    repo.write('b.txt', 'mine\n');
    repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    const err = await updateReviewCopy(repo.copy, pr, 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).args[0]).toBe('merge');
    expect(repo.head(repo.copy)).toBe(before);
    expect(repo.read('b.txt')).toBe('mine\n');
  });

  it('fails in git’s words when the PR ref is not there', async () => {
    const other = parsePrUrl('https://github.com/acme/relay/pull/2')!;
    const before = repo.head(repo.copy);
    const err = await updateReviewCopy(repo.copy, other, 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).args[0]).toBe('fetch');
    expect(repo.head(repo.copy)).toBe(before);
  });
});

describe('what changed between the two heads', { timeout: 30_000 }, () => {
  it('a fast-forward: the new commits, newest first, and the files with their counts', async () => {
    const prev = repo.head(repo.copy);
    repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    repo.pushToPr('d.txt', 'd1\nd2\nd3\n', 'Add d');
    const { next } = await updateReviewCopy(repo.copy, pr, 'main');
    const c = await sinceChanges(repo.copy, prev, next);
    expect(c.forced).toBe(false);
    expect(c.commits.map((x) => x.subject)).toEqual(['Add d', 'Add b2']);
    expect(c.commits[0]!.sha).toBe(next);
    expect(c.commits[0]!.at).toBeGreaterThan(0);
    expect(c.files).toEqual([
      { path: 'b.txt', added: 1, deleted: 0 },
      { path: 'd.txt', added: 3, deleted: 0 },
    ]);
  });

  it('a force-push: the commits the new head has that the old did not, and the files against the old copy', async () => {
    const prev = repo.head(repo.copy);
    repo.forcePushPr({ 'a.txt': 'a1\nREWRITTEN\na3\n', 'e.txt': 'e\n' }, 'Redo a, add e');
    const { next } = await updateReviewCopy(repo.copy, pr, 'main');
    const c = await sinceChanges(repo.copy, prev, next);
    expect(c.forced).toBe(true);
    expect(c.commits.map((x) => x.subject)).toEqual(['Redo a, add e']);
    expect(c.files).toEqual([
      { path: 'a.txt', added: 1, deleted: 1 },
      { path: 'e.txt', added: 1, deleted: 0 },
    ]);
  });

  it('the explanation’s material: whole messages and the diff between the heads only', async () => {
    const prev = repo.head(repo.copy);
    repo.pushToMain('unrelated.txt', 'not in the PR\n', 'Main only');
    const next = repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2\n\nBecause the reviewer asked.');
    await updateReviewCopy(repo.copy, pr, 'main');
    const m = await explainMaterial(repo.copy, prev, next);
    expect(m.commits).toEqual([{ sha: next, subject: 'Add b2', body: 'Because the reviewer asked.' }]);
    expect(m.diff).toContain('+b2');
    expect(m.diff).not.toContain('unrelated');
    expect(m.diff).not.toContain('A2');
  });

  it('readCopy: the head and the commits ahead of the base', async () => {
    expect(await readCopy(repo.copy, 'main')).toEqual({ head: repo.head(repo.copy), localCommits: 1 });
  });

  it('parseSinceLog skips anything that is not a record', () => {
    const sha = 'a'.repeat(40);
    expect(parseSinceLog(`\u001e${sha}\u001f1700000000\u001fSubject \u001f with a separator\n`)).toEqual([
      { sha, at: 1_700_000_000_000, subject: 'Subject \u001f with a separator' },
    ]);
    expect(parseSinceLog('noise\u001e\u001e')).toEqual([]);
  });
});
