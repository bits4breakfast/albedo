import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { urlOpener } from '../lib/platform';
import { GH_PROGRAMS, fetchPrStatus, gh, parsePrBase, prLookupBranch, setGhRunner, type GhRunner, type GhProgram } from './gh';

const task = {
  branch: 'feat/x',
  baseBranch: 'main',
  worktreePath: '/wt/x',
  repoPath: '/repo',
};

const PR_JSON = JSON.stringify({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  title: 't',
  reviewDecision: '',
  statusCheckRollup: [],
  mergedAt: null,
  headRefName: 'feat/x',
});

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
  it('runs `gh pr view <branch>` in the worktree', async () => {
    const calls = install(async () => ({ code: 0, stdout: PR_JSON, stderr: '' }));
    const pr = await fetchPrStatus(task);
    expect(pr?.number).toBe(7);
    expect(calls[0]?.[1].slice(0, 3)).toEqual(['pr', 'view', 'feat/x']);
    expect(calls[0]?.[2]).toBe('/wt/x');
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
