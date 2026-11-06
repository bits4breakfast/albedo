import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { urlOpener } from '../lib/platform';
import {
  GH_PROGRAMS,
  fetchPrStatus,
  gh,
  loadViewerLogin,
  mergePr,
  parsePrBase,
  prLookupBranch,
  resetViewerLoginForTests,
  setGhRunner,
  viewerLogin,
  type GhRunner,
  type GhProgram,
} from './gh';

const task = {
  branch: 'feat/x',
  baseBranch: 'main',
  worktreePath: '/wt/x',
  repoPath: '/repo',
};

/** What `gh api graphql` prints for PR_QUERY (#278): one PR for the branch. */
const PR_JSON = JSON.stringify({
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            state: 'OPEN',
            isDraft: false,
            title: 't',
            reviewDecision: null,
            mergedAt: null,
            headRefName: 'feat/x',
            commits: { nodes: [] },
            reviewThreads: { totalCount: 1, nodes: [{ isResolved: false }] },
          },
        ],
      },
    },
  },
});

/** The value of a `-f`/`-F` field in a gh api argv. */
function field(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && args[i + 1]!.startsWith(`${name}=`)) {
      return args[i + 1]!.slice(name.length + 1);
    }
  }
  return undefined;
}

let restore: GhRunner | null = null;
afterEach(() => {
  if (restore) setGhRunner(restore);
  restore = null;
});

function install(fn: GhRunner): Array<[GhProgram, string[], string | undefined]> {
  const calls: Array<[GhProgram, string[], string | undefined]> = [];
  restore = setGhRunner(async (program, args, cwd) => {
    calls.push([program, args, cwd]);
    return fn(program, args, cwd);
  });
  return calls;
}

describe('prLookupBranch', () => {
  it('skips the base branch, detached HEAD, and option-like names', () => {
    expect(prLookupBranch({ branch: 'feat/x', baseBranch: 'main' })).toBe('feat/x');
    expect(prLookupBranch({ branch: 'main', baseBranch: 'main' })).toBeNull();
    expect(prLookupBranch({ branch: 'HEAD', baseBranch: 'main' })).toBeNull();
    expect(prLookupBranch({ branch: '', baseBranch: 'main' })).toBeNull();
    expect(prLookupBranch({ branch: '--web', baseBranch: 'main' })).toBeNull();
  });
});

describe('gh runner', () => {
  it('falls through to Homebrew when gh is not on PATH, and remembers it', async () => {
    const calls = install(async (program) => {
      if (program !== 'gh-homebrew') throw new Error('program not found');
      return { code: 0, stdout: '', stderr: '' };
    });
    expect(await gh(['--version'])).not.toBeNull();
    expect(await gh(['--version'])).not.toBeNull();
    expect(calls.map((c) => c[0])).toEqual(['gh', 'gh-homebrew', 'gh-homebrew']);
  });

  it('returns null when no gh can be spawned at all', async () => {
    install(async () => {
      throw new Error('program not found');
    });
    expect(await gh(['--version'])).toBeNull();
  });
});

describe('fetchPrStatus', () => {
  it('asks one `gh api graphql` request in the worktree, threads included (#278)', async () => {
    const calls = install(async () => ({ code: 0, stdout: PR_JSON, stderr: '' }));
    const pr = await fetchPrStatus(task);
    expect(pr?.number).toBe(7);
    expect(pr?.reviewThreads).toEqual({ total: 1, unresolved: 1 });
    expect(calls).toHaveLength(1);
    const args = calls[0]![1];
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(calls[0]?.[2]).toBe('/wt/x');
    // gh fills the placeholders from the folder's remote, through -F only.
    expect(args).toEqual(expect.arrayContaining(['-F', 'owner={owner}', '-F', 'repo={repo}']));
    // The branch raw (-f): -F would make a branch named "193" a number.
    expect(args[args.indexOf('branch=feat/x') - 1]).toBe('-f');
    expect(field(args, 'query')).toContain('reviewThreads(first: 100) { totalCount nodes { isResolved } }');
  });

  it('a branch whose name is a number is still a branch (#278)', async () => {
    const calls = install(async () => ({ code: 0, stdout: PR_JSON.replace('"feat/x"', '"193"'), stderr: '' }));
    expect((await fetchPrStatus({ ...task, branch: '193' }))?.number).toBe(7);
    expect(calls[0]![1][calls[0]![1].indexOf('branch=193') - 1]).toBe('-f');
  });

  it('is silent for a GraphQL error answer and for no PR at all', async () => {
    install(async () => ({
      code: 1,
      stdout: '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]}',
      stderr: 'gh: Could not resolve to a Repository',
    }));
    expect(await fetchPrStatus(task)).toBeNull();
    install(async () => ({ code: 0, stdout: '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}', stderr: '' }));
    expect(await fetchPrStatus(task)).toBeNull();
  });

  it('is silent for "no pull requests found" and for logged-out gh', async () => {
    install(async () => ({ code: 1, stdout: '', stderr: 'no pull requests found for branch "feat/x"' }));
    expect(await fetchPrStatus(task)).toBeNull();
    install(async () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' }));
    expect(await fetchPrStatus(task)).toBeNull();
  });

  it('falls back to the repo when the worktree is gone', async () => {
    const calls = install(async (_p, _a, cwd) => {
      if (cwd === '/wt/x') throw new Error('No such file or directory');
      return { code: 0, stdout: PR_JSON, stderr: '' };
    });
    expect((await fetchPrStatus(task))?.number).toBe(7);
    expect(calls.at(-1)?.[2]).toBe('/repo');
  });

  it('rejects a PR whose head is a different branch', async () => {
    install(async () => ({ code: 0, stdout: PR_JSON.replace('"feat/x"', '"other"'), stderr: '' }));
    expect(await fetchPrStatus(task)).toBeNull();
  });

  it('never spawns for the base branch', async () => {
    const calls = install(async () => ({ code: 0, stdout: PR_JSON, stderr: '' }));
    expect(await fetchPrStatus({ ...task, branch: 'main' })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('shell scope', () => {
  // A name missing from the capability fails only at runtime, as a spawn error
  // gh() swallows -- so on the platform that needs it, the badge just never
  // appears. Check the names against the file instead.
  const caps = JSON.parse(readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  const exec = caps.permissions.find((p: { identifier?: string }) => p.identifier === 'shell:allow-execute');
  const allowed = new Set((exec.allow as { name: string }[]).map((a) => a.name));

  it('allows every gh location the runner tries', () => {
    for (const p of GH_PROGRAMS) expect(allowed).toContain(p);
  });

  it('allows the URL opener of both platforms', () => {
    expect(allowed).toContain(urlOpener('macos'));
    expect(allowed).toContain(urlOpener('linux'));
  });
});

describe('parsePrBase', () => {
  it('reads the base of the PR whose head is the branch', () => {
    const out = JSON.stringify({ number: 42, title: 'Fix tz', baseRefName: 'develop', headRefName: 'anna/fix-tz' });
    expect(parsePrBase(out, 'anna/fix-tz')).toEqual({ number: 42, title: 'Fix tz', base: 'develop' });
  });

  it('ignores a PR gh matched loosely, and anything that is not one', () => {
    const out = JSON.stringify({ number: 42, title: 'x', baseRefName: 'main', headRefName: 'other' });
    expect(parsePrBase(out, 'anna/fix-tz')).toBeNull();
    expect(parsePrBase('not json', 'b')).toBeNull();
    expect(parsePrBase('{"number":1}', 'b')).toBeNull();
  });
});

describe('viewerLogin (#180)', () => {
  afterEach(() => {
    resetViewerLoginForTests();
    vi.useRealTimers();
  });

  it('asks gh once per run, and asks for the PR fields it needs', async () => {
    resetViewerLoginForTests();
    const calls = install(async () => ({ code: 0, stdout: 'octo\n', stderr: '' }));
    expect(viewerLogin()).toBeNull();
    const [a, b] = await Promise.all([loadViewerLogin(), loadViewerLogin()]);
    expect([a, b]).toEqual(['octo', 'octo']);
    expect(await loadViewerLogin()).toBe('octo');
    expect(viewerLogin()).toBe('octo');
    expect(calls.map((c) => c[1])).toEqual([['api', 'user', '--jq', '.login']]);
  });

  it('a failure is unknown, and is not asked again for a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetViewerLoginForTests();
    const calls = install(async () => ({ code: 1, stdout: '', stderr: 'not logged in' }));
    expect(await loadViewerLogin()).toBeNull();
    expect(await loadViewerLogin()).toBeNull();
    expect(calls.length).toBe(1);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await loadViewerLogin()).toBeNull();
    expect(calls.length).toBe(2);
  });

  it("takes an Enterprise managed user's login, which has an underscore", async () => {
    resetViewerLoginForTests();
    install(async () => ({ code: 0, stdout: 'alice_acme\n', stderr: '' }));
    expect(await loadViewerLogin()).toBe('alice_acme');
  });

  it('the PR query asks for reviews, requests and the author', async () => {
    const calls = install(async () => ({ code: 0, stdout: PR_JSON, stderr: '' }));
    await fetchPrStatus(task);
    const query = field(calls[0]![1], 'query')!;
    for (const f of ['reviewDecision', 'latestReviews(first: 100)', 'reviewRequests(first: 100)', 'author {']) {
      expect(query).toContain(f);
    }
  });
});

describe('fetchPrStatus asks for what the merge action needs (#236)', () => {
  it('requests mergeable and mergeStateStatus, with the preview gh sends for it', async () => {
    const calls = install(async () => ({ code: 0, stdout: PR_JSON, stderr: '' }));
    await fetchPrStatus(task);
    const query = field(calls[0]![1], 'query')!;
    expect(query).toMatch(/\bmergeable\b/);
    expect(query).toContain('mergeStateStatus');
    expect(calls[0]![1]).toEqual(expect.arrayContaining(['-H', 'Accept: application/vnd.github.merge-info-preview+json']));
  });
});

describe('mergePr (#236)', () => {
  const pr = { number: 7, headRefName: 'feat/x' };
  const ok = { code: 0, stdout: '', stderr: '' };

  it('squash-merges in the worktree, never with --admin, and keeps the branch when asked', async () => {
    const calls = install(async () => ok);
    expect(await mergePr(pr, task, { deleteBranch: false })).toEqual({ ok: true });
    expect(calls).toEqual([['gh', ['pr', 'merge', '7', '--squash'], '/wt/x']]);
    expect(calls.flatMap((c) => c[1])).not.toContain('--admin');
    // gh's own --delete-branch would delete the local branch and move the worktree off it.
    expect(calls.flatMap((c) => c[1])).not.toContain('--delete-branch');
  });

  it('deletes only the branch on GitHub, through the API, after the merge', async () => {
    const calls = install(async () => ok);
    expect(await mergePr(pr, task, { deleteBranch: true })).toEqual({ ok: true });
    expect(calls.map((c) => c[1])).toEqual([
      ['pr', 'merge', '7', '--squash'],
      ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/git/refs/heads/feat/x'],
    ]);
    expect(calls.flatMap((c) => c[1])).not.toContain('--admin');
  });

  it('merges only the head that was shown, when it is known', async () => {
    const calls = install(async () => ok);
    await mergePr({ ...pr, headSha: 'abc1234def' }, task, { deleteBranch: false });
    expect(calls[0]![1]).toEqual(['pr', 'merge', '7', '--squash', '--match-head-commit', 'abc1234def']);
    // Nothing that is not a sha reaches gh's argv.
    const more = install(async () => ok);
    await mergePr({ ...pr, headSha: '--admin' }, task, { deleteBranch: false });
    expect(more[0]![1]).toEqual(['pr', 'merge', '7', '--squash']);
  });

  it('a 422 that is not "already gone" is a branch not deleted', async () => {
    install(async (_p, args) =>
      args[0] === 'api' ? { code: 1, stdout: '', stderr: 'gh: Cannot delete a protected branch (HTTP 422)' } : ok,
    );
    expect(await mergePr(pr, task, { deleteBranch: true })).toEqual({
      ok: true,
      branchNotDeleted: 'gh: Cannot delete a protected branch (HTTP 422)',
    });
  });

  it('a branch GitHub already deleted is what was asked', async () => {
    install(async (_p, args) =>
      args[0] === 'api' ? { code: 1, stdout: '', stderr: 'gh: Reference does not exist (HTTP 422)' } : ok,
    );
    expect(await mergePr(pr, task, { deleteBranch: true })).toEqual({ ok: true });
  });

  it('merged, but the branch could not be deleted: says so, still a merge', async () => {
    install(async (_p, args) => (args[0] === 'api' ? { code: 1, stdout: '', stderr: 'HTTP 403: forbidden' } : ok));
    expect(await mergePr(pr, task, { deleteBranch: true })).toEqual({ ok: true, branchNotDeleted: 'HTTP 403: forbidden' });
  });

  it("a refusal is gh's own message, colour codes stripped, and nothing else runs", async () => {
    const calls = install(async () => ({
      code: 1,
      stdout: '',
      stderr: '\x1b[31mX\x1b[0m Pull request #7 is not mergeable: the base branch policy prohibits the merge.\n',
    }));
    expect(await mergePr(pr, task, { deleteBranch: true })).toEqual({
      ok: false,
      message: 'X Pull request #7 is not mergeable: the base branch policy prohibits the merge.',
    });
    expect(calls).toHaveLength(1);
  });

  it('falls back to the main checkout when the worktree is gone', async () => {
    const calls = install(async (_p, _a, cwd) => {
      if (cwd === '/wt/x') throw new Error('No such file or directory');
      return ok;
    });
    expect(await mergePr(pr, task, { deleteBranch: false })).toEqual({ ok: true });
    expect(calls.at(-1)?.[2]).toBe('/repo');
  });

  it('says so when gh cannot be run at all, and refuses a non-number', async () => {
    install(async () => {
      throw new Error('program not found');
    });
    expect(await mergePr(pr, task, { deleteBranch: false })).toEqual({ ok: false, message: 'GitHub CLI (gh) could not be run.' });
    const calls = install(async () => ok);
    expect((await mergePr({ number: 0, headRefName: 'x' }, task, { deleteBranch: false })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
