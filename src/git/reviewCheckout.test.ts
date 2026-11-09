import { afterEach, describe, expect, it } from 'vitest';
import { setGitRunner, type GitRunner } from './worktree';
import { fetchReviewHead, parsePrUrl, remoteForPr, remoteRepo, reviewBranch } from './reviewCheckout';

describe('parsePrUrl', () => {
  it('reads host, owner, repo and number', () => {
    expect(parsePrUrl('https://github.com/acme/relay/pull/412')).toEqual({ host: 'github.com', owner: 'acme', repo: 'relay', number: 412 });
    expect(parsePrUrl('https://github.com/acme/relay/issues/412')).toBeNull();
    expect(parsePrUrl('https://github.com/acme/relay/pull/0')).toBeNull();
  });
});

describe('remoteForPr', () => {
  const pr = parsePrUrl('https://github.com/acme/relay/pull/412')!;
  it('every spelling of the same repository', () => {
    expect(remoteRepo('git@github.com:acme/relay.git')).toEqual({ host: 'github.com', path: 'acme/relay' });
    expect(remoteRepo('https://github.com/acme/relay')).toEqual({ host: 'github.com', path: 'acme/relay' });
    expect(remoteRepo('ssh://git@github.com:22/acme/relay.git')).toEqual({ host: 'github.com', path: 'acme/relay' });
  });
  it('the remote whose URL is the repository, through an SSH alias too', () => {
    const v = 'fork\tgit@github.com:me/relay.git (fetch)\nupstream\tgithub-work:Acme/relay.git (fetch)\nupstream\tgithub-work:Acme/relay.git (push)\n';
    expect(remoteForPr(v, pr)).toBe('upstream');
  });
  it('origin when none matches; nothing when there is no origin', () => {
    expect(remoteForPr('origin\t/srv/remotes/relay.git (fetch)\n', pr)).toBe('origin');
    expect(remoteForPr('fork\tgit@github.com:me/other.git (fetch)\n', pr)).toBeNull();
  });
});

describe('fetchReviewHead', () => {
  let prev: GitRunner | null = null;
  afterEach(() => {
    if (prev) setGitRunner(prev);
  });
  it('fetches the PR head into review/<n>, forced, and the base beside it', async () => {
    const calls: string[][] = [];
    prev = setGitRunner(async (args) => {
      calls.push(args);
      if (args[0] === 'remote') return { code: 0, stdout: 'origin\tgit@github.com:acme/relay.git (fetch)\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const branch = await fetchReviewHead('/r/relay', parsePrUrl('https://github.com/acme/relay/pull/412')!, 'main');
    expect(branch).toBe(reviewBranch(412));
    expect(calls[1]).toEqual([
      'fetch', '--no-tags', 'origin',
      '+refs/pull/412/head:refs/heads/review/412',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  });
});
