/**
 * probeResumePlace when the session's branch is gone too (#395): what it asks
 * origin, what it fetches, and what it offers. git is faked at the runner; the
 * task that ran in the folder names the repo, unless a test says otherwise.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitResult } from './worktree';

const findTaskByWorktreePath = vi.fn(
  async (_cwd: string): Promise<{ repoPath: string; baseBranch: string } | null> => ({
    repoPath: '/w/shop',
    baseBranch: 'main',
  }),
);
const listProjects = vi.fn(async () => [
  { id: 1, repoPath: '/w/shop', worktreeRoot: '/w/shop-worktree', defaultBaseBranch: 'main' },
]);
vi.mock('../db', () => ({ findTaskByWorktreePath }));
vi.mock('../db/projects', () => ({ listProjects }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/m' }));

const { probeResumePlace } = await import('./resumePlace');
const { setGitRunner, setPathExistsProbe } = await import('./worktree');

const CWD = '/w/shop-worktree/412-use-max-availability';
const BRANCH = '412-use-max-availability';
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const code = (n: number): GitResult => ({ code: n, stdout: '', stderr: 'fatal' });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.clearAllMocks();
  findTaskByWorktreePath.mockImplementation(async () => ({ repoPath: '/w/shop', baseBranch: 'main' }));
});

function fake(o: {
  localBranch?: boolean;
  /** ls-remote's exit code: 0 has it, 2 has not, 128 could not be asked. */
  lsRemote: number;
  trackingRef?: boolean;
  occupied?: boolean;
  /** Hold every ls-remote until this resolves. */
  hold?: Promise<void>;
}) {
  const calls: string[][] = [];
  const prevRunner = setGitRunner(async (args) => {
    calls.push(args);
    const a = args.join(' ');
    if (a === `rev-parse --verify --quiet refs/heads/${BRANCH}`) return o.localBranch ? ok('abc') : code(1);
    if (a === `rev-parse --verify --quiet refs/remotes/origin/${BRANCH}`) return o.trackingRef ? ok('abc') : code(1);
    if (a === 'rev-parse --verify --quiet refs/heads/main') return ok('abc');
    if (a === 'worktree list --porcelain') return ok('worktree /w/shop\nHEAD abc\nbranch refs/heads/main\n\n');
    if (a === 'remote') return ok('origin\n');
    if (a.startsWith('ls-remote ')) {
      await o.hold;
      return o.lsRemote === 0 ? ok(`abc\trefs/heads/${BRANCH}\n`) : code(o.lsRemote);
    }
    if (a.startsWith(`fetch --quiet --no-tags -- origin +refs/heads/${BRANCH}:`)) return ok();
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

const remoteCalls = (calls: string[][]) => calls.filter((a) => a[0] === 'fetch' || a[0] === 'ls-remote');

describe('probeResumePlace, the branch gone too', () => {
  it('asks origin about that one branch, fetches it, and recreates from it', async () => {
    const calls = fake({ lsRemote: 0 });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan).toMatchObject({ source: 'remote', origin: 'present', preselect: true, startPoint: `origin/${BRANCH}` });
    expect(remoteCalls(calls)).toEqual([
      ['ls-remote', '--exit-code', '--heads', '--', 'origin', `refs/heads/${BRANCH}`],
      ['fetch', '--quiet', '--no-tags', '--', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`],
    ]);
  });

  it('origin says it is gone: a new branch from the freshly fetched base, preselected', async () => {
    const calls = fake({ lsRemote: 2, trackingRef: true });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan).toMatchObject({ source: 'base', origin: 'absent', preselect: true, baseBranch: 'main' });
    // Local main is 3 behind origin/main, so the cut comes from origin/main.
    expect(plan?.startPoint).toBe('origin/main');
    expect(remoteCalls(calls).map((a) => a.slice(-2))).toEqual([
      ['origin', `refs/heads/${BRANCH}`],
      ['origin', 'refs/heads/main'],
    ]);
  });

  it('origin unreachable, with a copy from the last fetch: recreates from that copy', async () => {
    fake({ lsRemote: 128, trackingRef: true });
    expect(await probeResumePlace(CWD, BRANCH)).toMatchObject({ source: 'remote', origin: 'unknown', preselect: true });
  });

  it('origin unreachable, no copy: offers the base without choosing it', async () => {
    fake({ lsRemote: 128 });
    expect(await probeResumePlace(CWD, BRANCH)).toMatchObject({ source: 'base', origin: 'unknown', preselect: false });
  });

  it('cuts from the local name of a base recorded as origin/main', async () => {
    findTaskByWorktreePath.mockImplementation(async () => ({ repoPath: '/w/shop', baseBranch: 'origin/main' }));
    const calls = fake({ lsRemote: 2 });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan?.startPoint).toBe('origin/main');
    // freshBase asked about `main`, not `origin/main`.
    expect(calls).toContainEqual(['config', '--get', 'branch.main.remote']);
    expect(calls.some((a) => a.join(' ').includes('branch.origin/main'))).toBe(false);
  });

  it('offers nothing, and asks origin nothing, while something is at the old path', async () => {
    const calls = fake({ lsRemote: 0, occupied: true });
    expect(await probeResumePlace(CWD, BRANCH)).toBeNull();
    expect(remoteCalls(calls)).toEqual([]);
  });

  it('never asks origin for a detached session', async () => {
    const calls = fake({ lsRemote: 0 });
    expect(await probeResumePlace(CWD, 'HEAD')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('leaves a branch that still exists as it was: origin is not asked', async () => {
    const calls = fake({ localBranch: true, lsRemote: 0 });
    const plan = await probeResumePlace(CWD, BRANCH);
    expect(plan).toMatchObject({ source: 'local', origin: null, preselect: true });
    expect(plan?.main?.path).toBe('/w/shop');
    expect(remoteCalls(calls)).toEqual([]);
  });

  it('shares one probe between two asks for the same repo and branch', async () => {
    let release = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const calls = fake({ lsRemote: 0, hold });
    const first = probeResumePlace(CWD, BRANCH);
    const second = probeResumePlace(CWD, BRANCH);
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'ls-remote')).toHaveLength(1));
    // Give the second ask time to reach the probe too.
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await first)?.source).toBe('remote');
    expect((await second)?.source).toBe('remote');
    expect(calls.filter((a) => a[0] === 'ls-remote')).toHaveLength(1);
    // Settled: the next ask goes to origin again.
    await probeResumePlace(CWD, BRANCH);
    expect(calls.filter((a) => a[0] === 'ls-remote')).toHaveLength(2);
  });

  describe('without a task, through the project', () => {
    it('offers a worktree exactly one level under the worktree root', async () => {
      findTaskByWorktreePath.mockImplementation(async () => null);
      fake({ lsRemote: 0 });
      expect((await probeResumePlace(CWD, BRANCH))?.source).toBe('remote');
    });

    it('never for a subfolder a session started in', async () => {
      findTaskByWorktreePath.mockImplementation(async () => null);
      const calls = fake({ lsRemote: 0 });
      expect(await probeResumePlace(`${CWD}/app`, BRANCH)).toBeNull();
      expect(remoteCalls(calls)).toEqual([]);
    });
  });
});
