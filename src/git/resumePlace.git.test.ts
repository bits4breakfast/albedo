/**
 * A gone session's worktree put back at its old path when its branch is gone
 * too (#395), against real git, end to end: probeResumePlace on a clone whose
 * worktree and branch were removed, then recreateWorktree. Origin has the
 * branch, has deleted it, or cannot be reached. Temp folders only.
 */

import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const task = { repoPath: '', baseBranch: 'main', ownsWorktree: true, worktreePath: '' };
vi.mock('../db', () => ({ findTaskByWorktreePath: async () => task }));
vi.mock('../db/projects', () => ({ listProjects: async () => [] }));

const { probeResumePlace, recreateWorktree } = await import('./resumePlace');
const { remoteBranchState, setGitRunner, setPathExistsProbe } = await import('./worktree');
const { realGit, sh } = await import('./reviewRepo.fixture');
type GitRunner = import('./worktree').GitRunner;
type PathExistsProbe = import('./worktree').PathExistsProbe;

const BRANCH = '412-use-max-availability';
let root: string;
let up: string;
let local: string;
let cwd: string;
let restoreRunner: GitRunner;
let restoreProbe: PathExistsProbe;

function commit(dir: string, file: string, message: string) {
  writeFileSync(join(dir, file), `${message}\n`);
  sh(dir, 'add', file);
  sh(dir, 'commit', '-q', '-m', message);
}

/** A clone whose task worktree on BRANCH was pushed, then removed with its branch. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'albedo-resume-'));
  up = join(root, 'up');
  local = join(root, 'shop');
  cwd = join(root, 'shop-worktree', BRANCH);
  sh(root, 'init', '-q', '-b', 'main', up);
  commit(up, 'a.txt', 'Start');
  sh(root, 'clone', '-q', up, local);
  sh(local, 'worktree', 'add', '-q', '-b', BRANCH, cwd);
  commit(cwd, 'b.txt', 'The work');
  sh(cwd, 'push', '-q', '-u', 'origin', BRANCH);
  sh(local, 'worktree', 'remove', cwd);
  sh(local, 'branch', '-q', '-D', BRANCH);
  // main moves on upstream after the clone last fetched it.
  commit(up, 'c.txt', 'Main moves');
  task.repoPath = local;
  task.worktreePath = cwd;
  restoreRunner = realGit();
  restoreProbe = setPathExistsProbe(async (p) => existsSync(p));
}, 30_000);
afterEach(() => {
  setGitRunner(restoreRunner);
  setPathExistsProbe(restoreProbe);
  rmSync(root, { recursive: true, force: true });
});

const head = (dir: string, rev = 'HEAD') => sh(dir, 'rev-parse', rev).trim();

describe('a gone branch, end to end', { timeout: 30_000 }, () => {
  it('origin still has it: recreates the worktree on a local branch tracking it', async () => {
    const plan = await probeResumePlace(cwd, BRANCH);
    expect(plan).toMatchObject({ source: 'remote', origin: 'present', preselect: true });
    await recreateWorktree(plan!, cwd);
    expect(head(cwd)).toBe(head(up, BRANCH));
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(BRANCH);
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe(`origin/${BRANCH}`);
  });

  it('deleted on origin too: a new, untracked branch from the freshly fetched main', async () => {
    sh(up, 'branch', '-q', '-D', BRANCH);
    // The clone still has a tracking ref from before: it must not count.
    expect(head(local, `refs/remotes/origin/${BRANCH}`)).not.toBe('');
    const plan = await probeResumePlace(cwd, BRANCH);
    expect(plan).toMatchObject({ source: 'base', origin: 'absent', preselect: true, baseBranch: 'main' });
    await recreateWorktree(plan!, cwd);
    // Cut from upstream main, which moved on after the last fetch.
    expect(head(cwd)).toBe(head(up, 'main'));
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(BRANCH);
    expect(() => sh(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
  });

  it('origin unreachable but still holding it: recreates from the last fetch, never calls it gone', async () => {
    const pushed = head(up, BRANCH);
    renameSync(up, `${up}-offline`);
    const plan = await probeResumePlace(cwd, BRANCH);
    expect(plan).toMatchObject({ source: 'remote', origin: 'unknown', preselect: true });
    await recreateWorktree(plan!, cwd);
    expect(head(cwd)).toBe(pushed);
  });

  it('origin unreachable and no copy: offers main without choosing it, and not as "gone from origin"', async () => {
    sh(local, 'update-ref', '-d', `refs/remotes/origin/${BRANCH}`);
    renameSync(up, `${up}-offline`);
    const plan = await probeResumePlace(cwd, BRANCH);
    expect(plan).toMatchObject({ source: 'base', origin: 'unknown', preselect: false });
  });

  it('a folder now at the old path: nothing is offered', async () => {
    sh(root, 'init', '-q', cwd);
    expect(await probeResumePlace(cwd, BRANCH)).toBeNull();
  });
});

describe('remoteBranchState', { timeout: 30_000 }, () => {
  it('present, absent, or unknown when origin cannot be asked', async () => {
    expect(await remoteBranchState(local, 'origin', BRANCH)).toBe('present');
    expect(await remoteBranchState(local, 'origin', 'never-pushed')).toBe('absent');
    // No such remote: could not be asked, which is not "gone".
    expect(await remoteBranchState(local, 'nowhere', BRANCH)).toBe('unknown');
  });
});
