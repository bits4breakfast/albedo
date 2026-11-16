/**
 * The worktree put back at a gone session's old path when its branch is gone
 * too (#395), against real git: one branch fetched from origin and a local
 * branch tracking it, or -- gone from origin as well -- a new branch of the
 * same name from the base. Temp folders only.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recreateWorktree, type ResumePlacePlan } from './resumePlace';
import { fetchRemoteBranch, setGitRunner, setPathExistsProbe, type GitRunner, type PathExistsProbe } from './worktree';
import { realGit, sh } from './reviewRepo.fixture';

const BRANCH = '412-use-max-availability';
let root: string;
let up: string;
let local: string;
let restoreRunner: GitRunner;
let restoreProbe: PathExistsProbe;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'albedo-resume-'));
  up = join(root, 'up');
  local = join(root, 'shop');
  sh(root, 'init', '-q', '-b', 'main', up);
  writeFileSync(join(up, 'a.txt'), 'a\n');
  sh(up, 'add', 'a.txt');
  sh(up, 'commit', '-q', '-m', 'Start');
  sh(root, 'clone', '-q', up, local);
  sh(up, 'switch', '-q', '-c', BRANCH);
  writeFileSync(join(up, 'b.txt'), 'b\n');
  sh(up, 'add', 'b.txt');
  sh(up, 'commit', '-q', '-m', 'The work');
  sh(up, 'switch', '-q', 'main');
  restoreRunner = realGit();
  restoreProbe = setPathExistsProbe(async (p) => existsSync(p));
}, 30_000);
afterEach(() => {
  setGitRunner(restoreRunner);
  setPathExistsProbe(restoreProbe);
  rmSync(root, { recursive: true, force: true });
});

const plan = (o: Partial<ResumePlacePlan>): ResumePlacePlan => ({
  repoPath: local,
  branch: BRANCH,
  recreate: true,
  source: 'local',
  startPoint: null,
  elsewhere: null,
  main: null,
  needsPrune: false,
  baseBranch: 'main',
  ...o,
});

describe('a gone branch, put back at the old path', { timeout: 30_000 }, () => {
  it('fetches the branch origin still has and tracks it', async () => {
    expect(await fetchRemoteBranch(local, 'origin', BRANCH)).toBe(true);
    const cwd = join(root, 'shop-worktree', BRANCH);
    await recreateWorktree(plan({ source: 'remote', startPoint: `origin/${BRANCH}` }), cwd);
    expect(sh(cwd, 'rev-parse', 'HEAD').trim()).toBe(sh(up, 'rev-parse', BRANCH).trim());
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(BRANCH);
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe(`origin/${BRANCH}`);
  });

  it('says origin lacks it once it is deleted there, even with a stale tracking ref', async () => {
    expect(await fetchRemoteBranch(local, 'origin', BRANCH)).toBe(true);
    sh(up, 'branch', '-q', '-D', BRANCH);
    expect(await fetchRemoteBranch(local, 'origin', BRANCH)).toBe(false);
    expect(await fetchRemoteBranch(local, 'nowhere', BRANCH)).toBe(false);
  });

  it('cuts a new, untracked branch of the same name from the base', async () => {
    const cwd = join(root, 'shop-worktree', BRANCH);
    await recreateWorktree(plan({ source: 'base', startPoint: 'origin/main' }), cwd);
    expect(sh(cwd, 'rev-parse', 'HEAD').trim()).toBe(sh(up, 'rev-parse', 'main').trim());
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(BRANCH);
    expect(() => sh(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
  });
});
