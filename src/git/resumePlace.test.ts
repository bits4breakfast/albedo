import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { planResumePlace, projectOwningPath, recreateWorktree, switchMainCheckout, type ResumePlacePlan } from './resumePlace';
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
  const gone = { ...base, branchExists: false, worktrees: [wt('/w/albedo', 'main')] };

  it('recreates from origin when the remote still has the branch', () => {
    expect(planResumePlace({ ...gone, onRemote: true, baseStart: null })).toEqual({
      repoPath: '/w/albedo',
      branch: 'polishing',
      recreate: true,
      source: 'remote',
      startPoint: 'origin/polishing',
      elsewhere: null,
      main: null,
      needsPrune: false,
      baseBranch: 'main',
    });
  });

  it('cuts a new branch from the base when origin does not have it either', () => {
    const plan = planResumePlace({ ...gone, onRemote: false, baseStart: 'origin/main' });
    expect(plan?.source).toBe('base');
    expect(plan?.startPoint).toBe('origin/main');
    expect(plan?.baseBranch).toBe('main');
    expect(plan?.recreate).toBe(true);
    // No branch to switch the main checkout to.
    expect(plan?.main).toBeNull();
  });

  it('offers nothing when neither origin nor a base can make it', () => {
    expect(planResumePlace({ ...gone, onRemote: false, baseStart: null })).toBeNull();
    expect(planResumePlace({ ...gone, onRemote: false, baseStart: 'main', baseBranch: null })).toBeNull();
    // The base is the branch itself: no base at all.
    expect(planResumePlace({ ...gone, onRemote: false, baseStart: 'polishing', baseBranch: 'polishing' })).toBeNull();
    expect(planResumePlace({ ...gone })).toBeNull();
  });

  it('offers nothing while something occupies the old path', () => {
    expect(planResumePlace({ ...gone, onRemote: true, pathOccupied: true })).toBeNull();
    const registered = planResumePlace({
      ...gone,
      onRemote: true,
      worktrees: [wt('/w/albedo', 'main'), wt('/w/albedo-agents/polishing', 'other')],
    });
    expect(registered).toBeNull();
  });

  it('prunes a stale registration of the old path first', () => {
    const plan = planResumePlace({
      ...gone,
      onRemote: true,
      worktrees: [wt('/w/albedo', 'main'), wt('/w/albedo-agents/polishing', 'polishing', { prunable: true })],
    });
    expect(plan?.source).toBe('remote');
    expect(plan?.needsPrune).toBe(true);
  });

  it('never records the branch itself as its base: that hides its commits and its PR', () => {
    expect(planResumePlace({ ...base, baseBranch: null, worktrees: [] })?.baseBranch).toBeNull();
    expect(planResumePlace({ ...base, baseBranch: 'polishing', worktrees: [] })?.baseBranch).toBeNull();
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
