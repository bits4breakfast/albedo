import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../types';
import {
  directlyUnder,
  planResumePlace,
  projectOwningPath,
  recreateWorktree,
  stripRemote,
  switchMainCheckout,
  type ResumePlacePlan,
} from './resumePlace';
import { setGitRunner, setPathExistsProbe, type GitRunner, type ParsedWorktree, type PathExistsProbe } from './worktree';

function wt(path: string, branch: string | null, extra: Partial<ParsedWorktree> = {}): ParsedWorktree {
  return {
    path,
    branch,
    head: 'abc',
    locked: false,
    bare: false,
    detached: branch === null,
    lockedReason: null,
    prunable: false,
    prunableReason: null,
    ...extra,
  };
}

const base = {
  cwd: '/w/albedo-agents/polishing',
  repoPath: '/w/albedo',
  branch: 'polishing',
  branchExists: true,
  baseBranch: 'main',
};

describe('planResumePlace', () => {
  it('offers recreating when the branch is not checked out anywhere', () => {
    const plan = planResumePlace({ ...base, worktrees: [wt('/w/albedo', 'main')] });
    expect(plan).toEqual({
      repoPath: '/w/albedo',
      branch: 'polishing',
      recreate: true,
      source: 'local',
      startPoint: null,
      origin: null,
      preselect: true,
      elsewhere: null,
      main: { path: '/w/albedo', current: 'main', dirty: null },
      needsPrune: false,
      baseBranch: 'main',
    });
  });

  it('offers switching the main checkout, carrying its uncommitted count', () => {
    const plan = planResumePlace({ ...base, worktrees: [wt('/w/albedo', 'main')], mainDirty: 3 });
    expect(plan?.main).toEqual({ path: '/w/albedo', current: 'main', dirty: 3 });
  });

  it('does not offer switching when the branch is checked out somewhere', () => {
    const inMain = planResumePlace({ ...base, worktrees: [wt('/w/albedo', 'polishing')], mainDirty: 0 });
    expect(inMain?.main).toBeNull();
    const inOther = planResumePlace({
      ...base,
      worktrees: [wt('/w/albedo', 'main'), wt('/w/other', 'polishing')],
      mainDirty: 0,
    });
    expect(inOther?.main).toBeNull();
    expect(inOther?.elsewhere).toBe('/w/other');
  });

  it('never offers a bare repository as the main checkout', () => {
    const plan = planResumePlace({ ...base, worktrees: [wt('/w/albedo.git', null, { bare: true })] });
    expect(plan?.main).toBeNull();
  });

  it('suggests the checkout that has the branch, and then cannot recreate', () => {
    const plan = planResumePlace({ ...base, worktrees: [wt('/w/albedo', 'polishing')] });
    expect(plan?.recreate).toBe(false);
    expect(plan?.elsewhere).toBe('/w/albedo');
  });

  it('prunes a stale registration of the old path instead of counting it as a checkout', () => {
    const plan = planResumePlace({
      ...base,
      worktrees: [
        wt('/w/albedo', 'main'),
        wt('/w/albedo-agents/polishing', 'polishing', { prunable: true, prunableReason: 'gitdir file points to non-existent location' }),
      ],
    });
    expect(plan?.recreate).toBe(true);
    expect(plan?.elsewhere).toBeNull();
    expect(plan?.needsPrune).toBe(true);
  });

  it('prunes a stale registration elsewhere that still holds the branch', () => {
    // git refuses `worktree add` with "'polishing' is already used by worktree
    // at /w/elsewhere" even though that folder is gone.
    const plan = planResumePlace({
      ...base,
      worktrees: [wt('/w/elsewhere', 'polishing', { prunable: true })],
    });
    expect(plan?.recreate).toBe(true);
    expect(plan?.elsewhere).toBeNull();
    expect(plan?.needsPrune).toBe(true);
  });

  it('does not prune for stale registrations that block nothing', () => {
    const plan = planResumePlace({
      ...base,
      worktrees: [wt('/w/other', 'other', { prunable: true })],
    });
    expect(plan?.needsPrune).toBe(false);
  });

  it('offers nothing when the branch is detached or missing', () => {
    expect(planResumePlace({ ...base, branch: 'HEAD', worktrees: [] })).toBeNull();
    expect(planResumePlace({ ...base, branch: null, worktrees: [] })).toBeNull();
  });

  it('marks a branch that exists as local, with nothing to cut from', () => {
    const plan = planResumePlace({ ...base, worktrees: [] });
    expect(plan?.source).toBe('local');
    expect(plan?.startPoint).toBeNull();
  });
});

describe('planResumePlace, the branch gone too (#395)', () => {
  const gone = { ...base, branchExists: false, worktrees: [wt('/w/albedo', 'main')], ownedPath: true };

  it('recreates from origin when origin has the branch, preselected', () => {
    expect(planResumePlace({ ...gone, origin: 'present', trackingRef: true, baseStart: null })).toEqual({
      repoPath: '/w/albedo',
      branch: 'polishing',
      recreate: true,
      source: 'remote',
      startPoint: 'origin/polishing',
      origin: 'present',
      preselect: true,
      elsewhere: null,
      main: null,
      needsPrune: false,
      baseBranch: 'main',
    });
  });

  it('cuts a new branch from the base, preselected, once origin says it is gone', () => {
    const plan = planResumePlace({ ...gone, origin: 'absent', baseStart: 'origin/main' });
    expect(plan?.source).toBe('base');
    expect(plan?.origin).toBe('absent');
    expect(plan?.preselect).toBe(true);
    expect(plan?.startPoint).toBe('origin/main');
    expect(plan?.baseBranch).toBe('main');
    // No branch to switch the main checkout to.
    expect(plan?.main).toBeNull();
  });

  it('origin unreachable: recreates from the last fetch’s copy when there is one', () => {
    const plan = planResumePlace({ ...gone, origin: 'unknown', trackingRef: true, baseStart: 'main' });
    expect(plan?.source).toBe('remote');
    expect(plan?.origin).toBe('unknown');
    expect(plan?.preselect).toBe(true);
  });

  it('origin unreachable and no copy: offers the base, but does not choose it', () => {
    const plan = planResumePlace({ ...gone, origin: 'unknown', trackingRef: false, baseStart: 'main' });
    expect(plan?.source).toBe('base');
    expect(plan?.origin).toBe('unknown');
    expect(plan?.preselect).toBe(false);
  });

  it('a stale tracking ref does not count once origin says the branch is gone', () => {
    expect(planResumePlace({ ...gone, origin: 'absent', trackingRef: true, baseStart: 'main' })?.source).toBe('base');
  });

  it('offers nothing when neither origin nor a base can make it', () => {
    expect(planResumePlace({ ...gone, origin: 'absent', baseStart: null })).toBeNull();
    expect(planResumePlace({ ...gone, origin: 'absent', baseStart: 'main', baseBranch: null })).toBeNull();
    // The base is the branch itself: no base at all.
    expect(planResumePlace({ ...gone, origin: 'absent', baseStart: 'polishing', baseBranch: 'polishing' })).toBeNull();
    expect(planResumePlace({ ...gone })).toBeNull();
  });

  it('offers nothing while something occupies the old path', () => {
    expect(planResumePlace({ ...gone, origin: 'present', pathOccupied: true })).toBeNull();
    const registered = planResumePlace({
      ...gone,
      origin: 'present',
      worktrees: [wt('/w/albedo', 'main'), wt('/w/albedo-agents/polishing', 'other')],
    });
    expect(registered).toBeNull();
  });

  it('offers nothing for a folder that was never a worktree of its own', () => {
    expect(planResumePlace({ ...gone, origin: 'present', ownedPath: false })).toBeNull();
    expect(planResumePlace({ ...gone, origin: 'present', ownedPath: undefined })).toBeNull();
  });

  it('prunes a stale registration of the old path first', () => {
    const plan = planResumePlace({
      ...gone,
      origin: 'present',
      worktrees: [wt('/w/albedo', 'main'), wt('/w/albedo-agents/polishing', 'polishing', { prunable: true })],
    });
    expect(plan?.source).toBe('remote');
    expect(plan?.needsPrune).toBe(true);
  });
});

describe('directlyUnder', () => {
  it('is true only one level under the root, expanding ~', () => {
    expect(directlyUnder('~/www/shop-worktree', '/Users/m/www/shop-worktree/412-x', '/Users/m')).toBe(true);
    expect(directlyUnder('/w/shop-worktree/', '/w/shop-worktree/412-x/', '/h')).toBe(true);
    expect(directlyUnder('/w/shop-worktree', '/w/shop-worktree/412-x/app', '/h')).toBe(false);
    expect(directlyUnder('/w/shop-worktree', '/w/shop-worktree', '/h')).toBe(false);
    expect(directlyUnder('/w/shop', '/w/shop-worktree/412-x', '/h')).toBe(false);
  });
});

describe('stripRemote', () => {
  it('drops a leading remote, longest first, and leaves a local name alone', () => {
    expect(stripRemote('origin/main', ['origin'])).toBe('main');
    expect(stripRemote('team/upstream/main', ['team', 'team/upstream'])).toBe('main');
    expect(stripRemote('feature/main', ['origin'])).toBe('feature/main');
    expect(stripRemote('origin/', ['origin'])).toBe('origin/');
  });
});

describe('projectOwningPath', () => {
  const project = (id: number, worktreeRoot: string): Project => ({
    id,
    name: `p${id}`,
    repoPath: `/repo/${id}`,
    worktreeRoot,
    defaultBaseBranch: null,
    taskPromptTemplate: null,
    ciDetails: 'link',
    ciDetailsCommand: null,
    guideSetAside: null,
    guideCareful: null,
    createdAt: 0,
    archivedAt: null,
  });

  it('finds the project whose worktree root holds the folder, expanding ~', () => {
    const ps = [project(1, '~/www/other-worktrees'), project(2, '~/www/albedo-agents')];
    expect(projectOwningPath(ps, '/Users/m/www/albedo-agents/polishing', '/Users/m')?.id).toBe(2);
  });

  it('does not match a sibling folder that merely shares a prefix', () => {
    const ps = [project(1, '/w/albedo')];
    expect(projectOwningPath(ps, '/w/albedo-agents/polishing', '/h')).toBeNull();
  });
});

describe('recreateWorktree', () => {
  let restoreRunner: GitRunner | null = null;
  let restoreProbe: PathExistsProbe | null = null;
  afterEach(() => {
    if (restoreRunner) setGitRunner(restoreRunner);
    if (restoreProbe) setPathExistsProbe(restoreProbe);
    restoreRunner = null;
    restoreProbe = null;
  });

  function fake() {
    const calls: string[][] = [];
    restoreRunner = setGitRunner(async (args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    });
    restoreProbe = setPathExistsProbe(async () => false);
    return calls;
  }

  const plan: ResumePlacePlan = {
    repoPath: '/w/albedo',
    branch: 'polishing',
    recreate: true,
    source: 'local',
    startPoint: null,
    origin: null,
    preselect: true,
    elsewhere: null,
    main: null,
    needsPrune: false,
    baseBranch: 'main',
  };
  const cwd = '/w/albedo-agents/polishing';

  it('checks out the existing branch at the old path', async () => {
    const calls = fake();
    await recreateWorktree(plan, cwd);
    expect(calls).toEqual([['worktree', 'add', '--', cwd, 'polishing']]);
  });

  it('cuts a local branch tracking origin when only the remote has it', async () => {
    const calls = fake();
    await recreateWorktree({ ...plan, source: 'remote', startPoint: 'origin/polishing', needsPrune: true }, cwd);
    expect(calls).toEqual([
      ['worktree', 'prune'],
      ['worktree', 'add', '--track', '-b', 'polishing', '--', cwd, 'origin/polishing'],
    ]);
  });

  it('cuts a new, untracked branch of the same name from the base', async () => {
    const calls = fake();
    await recreateWorktree({ ...plan, source: 'base', startPoint: 'origin/main' }, cwd);
    expect(calls).toEqual([['worktree', 'add', '--no-track', '-b', 'polishing', '--', cwd, 'origin/main']]);
  });
});

describe('switchMainCheckout', () => {
  let restore: GitRunner | null = null;
  afterEach(() => {
    if (restore) setGitRunner(restore);
    restore = null;
  });

  const plan: ResumePlacePlan = {
    repoPath: '/w/albedo',
    branch: 'polishing',
    recreate: true,
    source: 'local',
    startPoint: null,
    origin: null,
    preselect: true,
    elsewhere: null,
    main: { path: '/w/albedo', current: 'main', dirty: 0 },
    needsPrune: false,
    baseBranch: 'main',
  };

  function fake(status: string) {
    const calls: string[][] = [];
    restore = setGitRunner(async (args) => {
      calls.push(args);
      return { code: 0, stdout: args[0] === 'status' ? status : '', stderr: '' };
    });
    return calls;
  }

  it('switches a main checkout that is still clean', async () => {
    const calls = fake('');
    expect(await switchMainCheckout(plan)).toBe('/w/albedo');
    expect(calls.at(-1)).toEqual(['switch', 'polishing']);
  });

  it('refuses, without switching, once the main checkout has changes', async () => {
    const calls = fake(' M src/App.tsx\0');
    await expect(switchMainCheckout(plan)).rejects.toThrow(/uncommitted change/);
    expect(calls.some((a) => a[0] === 'switch')).toBe(false);
  });
});
