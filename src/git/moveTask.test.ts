import { afterEach, describe, expect, it } from 'vitest';
import { decideMove, runMove, type MoveFacts, type MovePlan } from './moveTask';
import { setGitRunner, setPathExistsProbe, type GitResult } from './worktree';

const task = {
  id: 7,
  branch: 'fix-import',
  worktreePath: '/wt/fix-import',
  ownsWorktree: true,
  baseBranch: 'main',
};

function facts(over: Partial<MoveFacts> = {}): MoveFacts {
  return {
    task,
    busy: false,
    currentBranch: 'fix-import',
    dirtyHere: 0,
    main: { path: '/repo', current: 'main', dirty: 0 },
    newWorktreePath: '/wt/fix-import',
    newPathTaken: false,
    mainBackTo: 'main',
    ...over,
  };
}

describe('decideMove', () => {
  it('moves a worktree task to the main checkout, removing the worktree Albedo cut', () => {
    expect(decideMove(facts({ dirtyHere: 2 }))).toMatchObject({
      direction: 'to-main',
      from: '/wt/fix-import',
      to: '/repo',
      carry: 2,
      oldFolder: 'remove',
      blockers: [],
    });
  });

  it('only detaches a folder Albedo did not create', () => {
    expect(decideMove(facts({ task: { ...task, ownsWorktree: false } })).oldFolder).toBe('detach');
  });

  it('moves a main-checkout task to a worktree, sending the main checkout back', () => {
    const p = decideMove(facts({ task: { ...task, worktreePath: '/repo' }, main: { path: '/repo', current: 'fix-import', dirty: 1 } }));
    expect(p).toMatchObject({ direction: 'to-worktree', to: '/wt/fix-import', carry: 0, mainBackTo: 'main', blockers: [] });
  });

  it('refuses while the session works, on a detached HEAD, or onto a dirty main checkout', () => {
    expect(decideMove(facts({ busy: true })).blockers[0]).toMatch(/idle/);
    expect(decideMove(facts({ currentBranch: null })).blockers[0]).toMatch(/not on a branch/);
    expect(decideMove(facts({ main: { path: '/repo', current: 'main', dirty: 3 } })).blockers[0]).toMatch(
      /3 uncommitted change\(s\) of its own/,
    );
  });

  it('re-points a task left on a detached HEAD whose branch the main checkout already has', () => {
    const p = decideMove(facts({ currentBranch: null, dirtyHere: 0, main: { path: '/repo', current: 'fix-import', dirty: 2 } }));
    expect(p).toMatchObject({ direction: 'to-main', to: '/repo', switchMain: false, carry: 0, oldFolder: 'remove', blockers: [] });
    // Uncommitted work on no branch has nowhere safe to go.
    const dirty = decideMove(facts({ currentBranch: null, dirtyHere: 1, main: { path: '/repo', current: 'fix-import', dirty: 0 } }));
    expect(dirty.blockers[0]).toMatch(/on no branch/);
  });

  it('refuses a taken worktree folder, and sending main back to the same branch', () => {
    const inMain = { task: { ...task, worktreePath: '/repo' } };
    expect(decideMove(facts({ ...inMain, newPathTaken: true })).blockers[0]).toMatch(/already exists/);
    expect(decideMove(facts({ ...inMain, mainBackTo: 'fix-import' })).blockers[0]).toMatch(/another branch/);
  });
});

describe('runMove', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  /** A fake git: records argv, answers stash list with the stash it was given. */
  function fakeGit(fail?: (args: string[], cwd?: string) => boolean) {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    let stashMsg = '';
    const prevRunner = setGitRunner(async (args, cwd): Promise<GitResult> => {
      calls.push({ args, cwd });
      if (fail?.(args, cwd)) return { code: 1, stdout: '', stderr: `fatal: ${args.join(' ')} failed` };
      if (args[0] === 'stash' && args[1] === 'push') stashMsg = args[args.length - 1] ?? '';
      if (args[0] === 'stash' && args[1] === 'list') {
        const fmt = args[2] ?? '';
        return { code: 0, stdout: fmt.endsWith('%gs') ? `abc123 On fix-import: ${stashMsg}\n` : 'abc123 stash@{0}\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const prevProbe = setPathExistsProbe(async () => false);
    restore = () => {
      setGitRunner(prevRunner);
      setPathExistsProbe(prevProbe);
    };
    return calls;
  }

  const toMain: MovePlan = {
    direction: 'to-main',
    branch: 'fix-import',
    from: '/wt/fix-import',
    to: '/repo',
    carry: 2,
    oldFolder: 'remove',
    mainBackTo: null,
    switchMain: true,
    blockers: [],
  };

  it('stashes, removes the worktree, switches the main checkout, then applies and drops', async () => {
    const calls = fakeGit();
    const r = await runMove(toMain, '/repo', 7);
    expect(r).toEqual({ worktreePath: '/repo', ownsWorktree: false, stashLeft: null });
    const ran = calls.filter((c) => c.args[0] !== 'status').map((c) => `${c.cwd}: ${c.args.slice(0, 3).join(' ')}`);
    expect(ran).toEqual([
      '/wt/fix-import: stash push --include-untracked',
      '/wt/fix-import: stash list --format=%H %gs',
      '/repo: worktree remove --',
      '/repo: worktree prune',
      '/repo: switch fix-import',
      '/repo: stash apply --index',
      '/repo: stash list --format=%H %gd',
      '/repo: stash drop stash@{0}',
    ]);
    // By id, never by position: the stack is shared with other sessions.
    expect(calls.find((c) => c.args[1] === 'apply')?.args).toEqual(['stash', 'apply', '--index', 'abc123']);
  });

  it('puts the worktree and the changes back when the main checkout refuses', async () => {
    const calls = fakeGit((args) => args[0] === 'switch');
    await expect(runMove(toMain, '/repo', 7)).rejects.toThrow(/put back as it was/);
    const after = calls.slice(calls.findIndex((c) => c.args[0] === 'switch'));
    expect(after.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add' && c.args.includes('/wt/fix-import'))).toBe(true);
    expect(after.some((c) => c.cwd === '/wt/fix-import' && c.args[1] === 'apply')).toBe(true);
  });

  it('only removes the stale folder when the main checkout has the branch already', async () => {
    const calls = fakeGit();
    await runMove({ ...toMain, carry: 0, switchMain: false }, '/repo', 7);
    const ran = calls.filter((c) => c.args[0] !== 'status').map((c) => c.args.slice(0, 2).join(' '));
    expect(ran).toEqual(['worktree remove', 'worktree prune']);
  });

  it('moves to a worktree: the main checkout goes back first, then the worktree is added', async () => {
    const calls = fakeGit();
    const r = await runMove(
      { ...toMain, direction: 'to-worktree', from: '/repo', to: '/wt/fix-import', carry: 0, oldFolder: null, mainBackTo: 'main' },
      '/repo',
      7,
    );
    expect(r).toEqual({ worktreePath: '/wt/fix-import', ownsWorktree: true, stashLeft: null });
    const ran = calls.filter((c) => c.args[0] !== 'status').map((c) => c.args.join(' '));
    expect(ran).toEqual(['switch main', 'worktree add -- /wt/fix-import fix-import']);
  });
});
