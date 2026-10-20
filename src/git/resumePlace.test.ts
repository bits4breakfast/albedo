import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { planResumePlace, projectOwningPath, switchMainCheckout, type ResumePlacePlan } from './resumePlace';
import { setGitRunner, type GitRunner, type ParsedWorktree } from './worktree';

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

  it('offers nothing when the branch is gone, detached or missing', () => {
    expect(planResumePlace({ ...base, branchExists: false, worktrees: [] })).toBeNull();
    expect(planResumePlace({ ...base, branch: 'HEAD', worktrees: [] })).toBeNull();
    expect(planResumePlace({ ...base, branch: null, worktrees: [] })).toBeNull();
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
