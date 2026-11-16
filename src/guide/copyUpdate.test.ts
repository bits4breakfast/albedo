// @vitest-environment jsdom
/**
 * Update Copy's store (#352): the band's rule, the recorded heads, one update
 * at a time, a failure in git's words, and the explanation's lifecycle --
 * written once right after an update, a placeholder meanwhile, kept with the
 * heads, Rewrite, a failure that leaves the commits and files readable, and a
 * late answer for older heads dropped. Real git in temp repos; the model run
 * through writer.ts's injected runner, never `claude`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEYS } from '../ui/persisted';
import { setGitRunner, type GitRunner } from '../git/worktree';
import { makeReviewRepo, realGit, type ReviewRepo } from '../git/reviewRepo.fixture';
import { sinceChanges } from '../git/reviewUpdate';
import { setOneshotRunner, type OneshotOutput, type OneshotRequest } from './writer';
import {
  behindWords,
  copyBehind,
  explainStateOf,
  hideSince,
  isUpdating,
  MAX_UPDATES,
  resetSinceReviewForTests,
  runReviewUpdate,
  startExplanation,
  updateFailureOf,
  updateRecordOf,
  updatesCodec,
  wasUpToDate,
  type UpdateRecord,
} from './copyUpdate';

/** git and the fake model on a loaded machine: well past the 1 s default. */
const POLL = { timeout: 15_000 };

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetSinceReviewForTests();
});

const answer = (explanation: string): OneshotOutput => ({
  code: 0,
  stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: { explanation } }),
  stderr: '',
  timedOut: false,
});

describe('copyBehind: the band shows only while the heads differ', () => {
  const pr = { headOid: 'b'.repeat(40), commitCount: 4, forcePushedAt: null, lastCommitAt: 1000, author: 'octo' };
  const copy = { head: 'a'.repeat(40), localCommits: 1 };

  it('is nothing when GitHub’s head is the copy’s, or either is unknown', () => {
    expect(copyBehind({ ...pr, headOid: copy.head }, copy, 0)).toBeNull();
    expect(copyBehind(null, copy, 0)).toBeNull();
    expect(copyBehind(pr, null, 0)).toBeNull();
    expect(copyBehind({ ...pr, headOid: '' }, copy, 0)).toBeNull();
  });

  it('counts the new commits, with the latest’s time and the author', () => {
    const b = copyBehind(pr, copy, 0)!;
    expect(b).toEqual({ commits: 3, forced: false, latestAt: 1000, author: 'octo' });
    expect(behindWords(b)).toBe('3 new commits');
    expect(behindWords({ ...b, commits: 1 })).toBe('1 new commit');
    expect(behindWords({ ...b, commits: null })).toBe('New commits');
  });

  it('is a force-push only when the push came after the copy was taken', () => {
    expect(copyBehind({ ...pr, forcePushedAt: 500 }, copy, 100)?.forced).toBe(true);
    expect(copyBehind({ ...pr, forcePushedAt: 500 }, copy, 900)?.forced).toBe(false);
    expect(behindWords(copyBehind({ ...pr, forcePushedAt: 500 }, copy, 100)!)).toBe('Force-pushed');
  });

  it('new comments alone never show it: comments do not move the head', () => {
    expect(copyBehind({ ...pr, headOid: copy.head, lastCommitAt: 5 }, copy, 0)).toBeNull();
  });
});

describe('the records', () => {
  it('keeps the newest, drops malformed entries', () => {
    const rec = (at: number): UpdateRecord => ({ prev: 'a', next: 'b', forced: false, at });
    const all = Object.fromEntries(Array.from({ length: MAX_UPDATES + 5 }, (_, i) => [String(i), rec(i)]));
    const back = updatesCodec.decode(updatesCodec.encode(all)!)!;
    expect(Object.keys(back)).toHaveLength(MAX_UPDATES);
    expect(back['0']).toBeUndefined();
    expect(updatesCodec.decode(JSON.stringify({ 1: { prev: 'a' }, 2: rec(2) }))).toEqual({ 2: rec(2) });
  });

  it('Hide puts "Since your review" away until the next update', () => {
    data.set(KEYS.reviewUpdates, JSON.stringify({ 9: { prev: 'a', next: 'b', forced: false, at: 1 } }));
    hideSince(9);
    expect(updateRecordOf(9)?.hidden).toBe(true);
  });
});

describe('Update Copy, against real git', { timeout: 30_000 }, () => {
  let repo: ReviewRepo;
  let restoreGit: GitRunner;
  let restoreRunner: ReturnType<typeof setOneshotRunner>;
  let asked: OneshotRequest[];
  let reply: (req: OneshotRequest) => Promise<OneshotOutput>;
  const task = () => ({ id: 3, worktreePath: repo.copy, baseBranch: 'main', reviewUrl: 'https://github.com/acme/relay/pull/1', createdAt: 0 });

  beforeEach(() => {
    repo = makeReviewRepo();
    restoreGit = realGit();
    asked = [];
    reply = async () => answer('The author added b2 because the reviewer asked.');
    restoreRunner = setOneshotRunner((req) => {
      asked.push(req);
      return reply(req);
    });
  }, 30_000);
  afterEach(() => {
    setGitRunner(restoreGit);
    setOneshotRunner(restoreRunner);
    repo.cleanup();
  });

  it('records the previous head and the new one, then writes the explanation once and keeps it', async () => {
    const prev = repo.head(repo.copy);
    const next = repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2\n\nThe reviewer asked for it.');
    await runReviewUpdate(task(), { now: () => 4242 });
    const rec = updateRecordOf(3)!;
    expect(rec).toMatchObject({ prev, next, forced: false, at: 4242 });
    expect(JSON.parse(data.get(KEYS.reviewUpdates)!)['3'].prev).toBe(prev);
    await expect.poll(() => updateRecordOf(3)?.explanation?.text, POLL).toBe('The author added b2 because the reviewer asked.');
    expect(updateRecordOf(3)!.explanation!.cut).toBe(false);
    expect(asked).toHaveLength(1);
    // The commits' messages and the diff between the two heads, nothing else.
    expect(asked[0]!.prompt).toContain('Add b2');
    expect(asked[0]!.prompt).toContain('The reviewer asked for it.');
    expect(asked[0]!.prompt).toContain('+b2');
    expect(asked[0]!.prompt).not.toContain('A2');
    expect(explainStateOf(3)).toBeNull();
    expect(repo.head(repo.copy)).toBe(next);
  });

  it('shows a placeholder state while the explanation is written; Rewrite asks again and replaces it', async () => {
    let release!: () => void;
    reply = () => new Promise((r) => (release = () => r(answer('First.'))));
    repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    await runReviewUpdate(task());
    await expect.poll(() => explainStateOf(3)?.kind, POLL).toBe('writing');
    // A second ask while one is written is the same one.
    await startExplanation(3, repo.copy).catch(() => {});
    expect(asked).toHaveLength(1);
    await expect.poll(() => typeof release, POLL).toBe('function');
    release();
    await expect.poll(() => updateRecordOf(3)?.explanation?.text, POLL).toBe('First.');
    reply = async () => answer('Second.');
    await startExplanation(3, repo.copy);
    expect(asked).toHaveLength(2);
    expect(updateRecordOf(3)!.explanation!.text).toBe('Second.');
  });

  it('a failed explanation is a short error; the commits and files still read', async () => {
    reply = async () => ({ code: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Overloaded' }), stderr: '', timedOut: false });
    repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    await runReviewUpdate(task());
    await expect.poll(() => explainStateOf(3), POLL).toEqual({ kind: 'failed', message: 'Overloaded' });
    const rec = updateRecordOf(3)!;
    expect(rec.explanation).toBeUndefined();
    const c = await sinceChanges(repo.copy, rec.prev, rec.next);
    expect(c.commits.map((x) => x.subject)).toEqual(['Add b2']);
    expect(c.files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('drops a late answer for heads that are no longer the last update', async () => {
    let release!: () => void;
    reply = () => new Promise((r) => (release = () => r(answer('About the first update.'))));
    repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    await runReviewUpdate(task());
    await expect.poll(() => typeof release, POLL).toBe('function');
    const first = release;
    reply = async () => answer('About the second update.');
    repo.pushToPr('d.txt', 'd\n', 'Add d');
    await runReviewUpdate(task());
    await expect.poll(() => updateRecordOf(3)?.explanation?.text, POLL).toBe('About the second update.');
    first();
    await new Promise((r) => setTimeout(r, 50));
    expect(updateRecordOf(3)!.explanation!.text).toBe('About the second update.');
  });

  it('one update at a time per task', async () => {
    repo.pushToPr('b.txt', 'b1\nb2\n', 'Add b2');
    const a = runReviewUpdate(task(), { explain: false });
    expect(isUpdating(3)).toBe(true);
    const b = runReviewUpdate(task(), { explain: false });
    await Promise.all([a, b]);
    expect(isUpdating(3)).toBe(false);
    expect(updateFailureOf(3)).toBeNull();
    expect(wasUpToDate(3)).toBe(false);
  });

  it('a force-push records forced; a conflicting local edit fails in git’s words and records nothing', async () => {
    const before = repo.head(repo.copy);
    repo.write('a.txt', 'a1\nmy edit\na3\n');
    repo.forcePushPr({ 'a.txt': 'a1\nREWRITTEN\na3\n' }, 'Redo a');
    await runReviewUpdate(task(), { explain: false });
    expect(updateFailureOf(3)).toMatch(/a\.txt/);
    expect(updateFailureOf(3)).not.toMatch(/\(git reset/);
    expect(updateRecordOf(3)).toBeNull();
    expect(repo.head(repo.copy)).toBe(before);
    expect(repo.read('a.txt')).toBe('a1\nmy edit\na3\n');
    // Without the edit in the way, it goes, and says it was a force-push.
    repo.write('a.txt', 'a1\nA2\na3\n');
    await runReviewUpdate(task(), { explain: false });
    expect(updateFailureOf(3)).toBeNull();
    expect(updateRecordOf(3)).toMatchObject({ prev: before, forced: true });
  });

  it('already at the head: nothing recorded, and it says so', async () => {
    await runReviewUpdate(task(), { explain: false });
    expect(updateRecordOf(3)).toBeNull();
    expect(wasUpToDate(3)).toBe(true);
  });
});
