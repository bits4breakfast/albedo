/**
 * probeResumePlace when the session's branch is gone too (#395): what it
 * fetches, and what it offers. git is faked at the runner; the task that ran
 * in the folder names the repo.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitResult } from './worktree';

vi.mock('../db', () => ({
  findTaskByWorktreePath: vi.fn(async () => ({ repoPath: '/w/shop', baseBranch: 'main' })),
}));
vi.mock('../db/projects', () => ({ listProjects: vi.fn(async () => []) }));

const { probeResumePlace } = await import('./resumePlace');
const { setGitRunner, setPathExistsProbe } = await import('./worktree');

const CWD = '/w/shop-worktree/412-use-max-availability';
const BRANCH = '412-use-max-availability';
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const fail: GitResult = { code: 128, stdout: '', stderr: 'fatal' };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function fake(o: { localBranch?: boolean; onRemote: boolean; occupied?: boolean }) {
  const calls: string[][] = [];
  const prevRunner = setGitRunner(async (args) => {
    calls.push(args);
    const a = args.join(' ');
    if (a === `rev-parse --verify --quiet refs/heads/${BRANCH}`) return o.localBranch ? ok('abc') : { code: 1, stdout: '', stderr: '' };
    if (a === 'rev-parse --verify --quiet refs/heads/main') return ok('abc');
    if (a === 'worktree list --porcelain') return ok('worktree /w/shop\nHEAD abc\nbranch refs/heads/main\n\n');
    if (a.startsWith(`fetch --quiet --no-tags -- origin +refs/heads/${BRANCH}:`)) return o.onRemote ? ok() : fail;
    if (a === 'config --get branch.main.remote') return ok('origin\n');
    if (a === 'config --get branch.main.merge') return ok('refs/heads/main\n');
    if (a === 'rev-parse --abbrev-ref main@{upstream}') return ok('origin/main\n');
    if (a === 'rev-list --left-right --count main...origin/main') return ok('0\t3\n');
    return ok();
  });
  const prevProbe = setPathExistsProbe(async () => o.occupied ?? false);
  restore = () => {
    setGitRunner(prevRunner);
    setPathExistsProbe(prevProbe);
  };
  return calls;
}

const fetches = (calls: string[][]) => calls.filter((a) => a[0] === 'fetch');

describe('probeResumePlace, the branch gone too', () => {
  it('fetches that one branch from origin and recreates from it', async () => {
    const calls = fake({ onRemote: true });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan?.source).toBe('remote');
    expect(plan?.startPoint).toBe(`origin/${BRANCH}`);
    // One fetch, of that branch only, into its remote-tracking ref.
    expect(fetches(calls)).toEqual([
      ['fetch', '--quiet', '--no-tags', '--', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`],
    ]);
  });

  it('falls back to a new branch from the freshly fetched base', async () => {
    const calls = fake({ onRemote: false });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan?.source).toBe('base');
    expect(plan?.baseBranch).toBe('main');
    // Local main is 3 behind origin/main, so the cut comes from origin/main.
    expect(plan?.startPoint).toBe('origin/main');
    expect(fetches(calls).map((a) => a.slice(-2))).toEqual([
      ['origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`],
      ['origin', 'refs/heads/main'],
    ]);
  });

  it('offers nothing, and fetches nothing, while something is at the old path', async () => {
    const calls = fake({ onRemote: true, occupied: true });
    expect(await probeResumePlace(CWD, BRANCH)).toBeNull();
    expect(fetches(calls)).toEqual([]);
  });

  it('never fetches for a detached session', async () => {
    const calls = fake({ onRemote: true });
    expect(await probeResumePlace(CWD, 'HEAD')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('leaves a branch that still exists as it was: no fetch', async () => {
    const calls = fake({ localBranch: true, onRemote: true });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan?.source).toBe('local');
    expect(plan?.main?.path).toBe('/w/shop');
    expect(fetches(calls)).toEqual([]);
  });
});
