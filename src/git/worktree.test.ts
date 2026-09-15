import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitError,
  type GitResult,
  agentsRoot,
  basename,
  classifyGitError,
  composeWorktreePath,
  createWorktree,
  describeStatusEntry,
  listBranches,
  listWorktrees,
  parseCommitCount,
  parseRefList,
  parseStatusPorcelain,
  parseUpstream,
  parseWorktreePorcelain,
  removeWorktree,
  revRange,
  setGitRunner,
  shortenRef,
  uncommittedChanges,
  unmergedCommits,
} from './worktree';

// ---------------------------------------------------------------------------
// Fake runner: records argv so we can assert on the exact commands we issue.
// ---------------------------------------------------------------------------

interface Call {
  args: string[];
  cwd?: string;
}

function fakeGit(replies: (call: Call) => GitResult | undefined) {
  const calls: Call[] = [];
  const restore = setGitRunner(async (args, cwd) => {
    calls.push({ args, cwd });
    return replies({ args, cwd }) ?? { code: 0, stdout: '', stderr: '' };
  });
  return { calls, restore };
}

let restoreRunner: (() => void) | null = null;
afterEach(() => {
  if (restoreRunner) restoreRunner();
  restoreRunner = null;
  vi.restoreAllMocks();
});

function install(replies: (call: Call) => GitResult | undefined) {
  const f = fakeGit(replies);
  restoreRunner = () => setGitRunner(f.restore);
  return f.calls;
}

// ---------------------------------------------------------------------------
// git worktree list --porcelain
// ---------------------------------------------------------------------------

describe('parseWorktreePorcelain', () => {
  // Captured verbatim from git 2.50.1.
  const sample = [
    'worktree /Users/m/www/albedo',
    'HEAD 262adc4f9663db9fbc68a577d5bee49eac310a5e',
    'branch refs/heads/main',
    '',
    'worktree /Users/m/agents/albedo/fix-login',
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/fix-login',
    '',
    'worktree /Users/m/agents/albedo/spike',
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'detached',
    '',
    'worktree /Users/m/agents/albedo/held',
    'HEAD cccccccccccccccccccccccccccccccccccccccc',
    'branch refs/heads/held',
    'locked in use by the release script',
    '',
    'worktree /Users/m/agents/albedo/gone',
    'HEAD dddddddddddddddddddddddddddddddddddddddd',
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  it('splits records on blank lines and shortens refs', () => {
    const wts = parseWorktreePorcelain(sample);
    expect(wts).toHaveLength(5);
    expect(wts[0]).toMatchObject({ path: '/Users/m/www/albedo', branch: 'main', detached: false });
    expect(wts[1]).toMatchObject({
      path: '/Users/m/agents/albedo/fix-login',
      branch: 'fix-login',
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('records detached, locked (with reason) and prunable', () => {
    const wts = parseWorktreePorcelain(sample);
    expect(wts[2]).toMatchObject({ detached: true, branch: null });
    expect(wts[3]).toMatchObject({ locked: true, lockedReason: 'in use by the release script' });
    expect(wts[4]).toMatchObject({
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    });
  });

  it('handles a bare repo entry and a bare `locked` with no reason', () => {
    const wts = parseWorktreePorcelain(
      ['worktree /srv/mirror.git', 'bare', '', 'worktree /srv/wt', 'HEAD abc', 'branch refs/heads/x', 'locked', ''].join(
        '\n',
      ),
    );
    expect(wts[0]).toMatchObject({ path: '/srv/mirror.git', bare: true, head: '', branch: null });
    expect(wts[1]).toMatchObject({ locked: true, lockedReason: null });
  });

  it('keeps paths containing spaces intact', () => {
    // This is exactly why we parse the porcelain form and not the aligned one.
    const wts = parseWorktreePorcelain(
      'worktree /Users/m/My Projects/a b\nHEAD abc\nbranch refs/heads/my branch\n\n',
    );
    expect(wts[0]?.path).toBe('/Users/m/My Projects/a b');
    expect(wts[0]?.branch).toBe('my branch');
  });

  it('tolerates CRLF, trailing blank lines and unknown labels', () => {
    const wts = parseWorktreePorcelain(
      'worktree /a\r\nHEAD abc\r\nbranch refs/heads/m\r\nsomethingnew value\r\n\r\n\r\n',
    );
    expect(wts).toHaveLength(1);
    expect(wts[0]).toMatchObject({ path: '/a', branch: 'm', head: 'abc' });
  });

  it('returns nothing for empty or junk input', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
    expect(parseWorktreePorcelain('\n\n')).toEqual([]);
    expect(parseWorktreePorcelain('HEAD abc\nbranch refs/heads/x\n')).toEqual([]);
  });
});

describe('shortenRef', () => {
  it('trims the well-known ref prefixes only', () => {
    expect(shortenRef('refs/heads/main')).toBe('main');
    expect(shortenRef('refs/remotes/origin/main')).toBe('origin/main');
    expect(shortenRef('refs/tags/v1')).toBe('v1');
    expect(shortenRef('refs/heads/feature/refs/heads/x')).toBe('feature/refs/heads/x');
    expect(shortenRef('main')).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// git status --porcelain -z
// ---------------------------------------------------------------------------

describe('parseStatusPorcelain', () => {
  it('parses the NUL-separated form, including the rename source field', () => {
    // Byte-for-byte what git 2.50.1 emitted for a rename + untracked files.
    const z = 'R  g h.txt\u0000f.txt\u0000?? d/deep.txt\u0000?? un tracked.txt\u0000';
    const entries = parseStatusPorcelain(z);
    expect(entries).toEqual([
      { x: 'R', y: ' ', path: 'g h.txt', origPath: 'f.txt' },
      { x: '?', y: '?', path: 'd/deep.txt', origPath: null },
      { x: '?', y: '?', path: 'un tracked.txt', origPath: null },
    ]);
  });

  it('keeps untracked files -- under-reporting here loses user work', () => {
    const entries = parseStatusPorcelain('?? secret-notes.md\u0000 M src/a.ts\u0000');
    expect(entries.map((e) => e.path)).toContain('secret-notes.md');
    expect(entries).toHaveLength(2);
  });

  it('does not mangle paths with spaces, quotes or newlines', () => {
    const weird = 'a "quoted" and\nnewline.txt';
    const entries = parseStatusPorcelain(`?? ${weird}\u0000`);
    expect(entries[0]?.path).toBe(weird);
  });

  it('handles copies, staged+unstaged pairs and an empty tree', () => {
    expect(parseStatusPorcelain('C  new.txt\u0000old.txt\u0000')[0]).toMatchObject({
      x: 'C',
      origPath: 'old.txt',
    });
    expect(parseStatusPorcelain('MM src/a.ts\u0000')[0]).toMatchObject({ x: 'M', y: 'M' });
    expect(parseStatusPorcelain('')).toEqual([]);
    expect(parseStatusPorcelain('\u0000')).toEqual([]);
  });

  it('does not swallow the next entry when a rename has no source field', () => {
    // Truncated output must not consume the following record.
    const entries = parseStatusPorcelain('R  a.txt\u0000');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origPath).toBeNull();
  });
});

describe('describeStatusEntry', () => {
  it('renders the status code and both sides of a rename', () => {
    expect(describeStatusEntry({ x: '?', y: '?', path: 'a.txt', origPath: null })).toBe('?? a.txt');
    expect(describeStatusEntry({ x: 'R', y: ' ', path: 'b', origPath: 'a' })).toBe('R  a -> b');
  });
});

// ---------------------------------------------------------------------------
// Unmerged commits -- the second kind of loss, distinct from a dirty tree
// ---------------------------------------------------------------------------

describe('parseCommitCount', () => {
  it('reads a count', () => {
    expect(parseCommitCount('2\n')).toBe(0 + 2);
    expect(parseCommitCount('0\n')).toBe(0);
    expect(parseCommitCount('  17  ')).toBe(17);
  });

  it('throws rather than guessing 0 when the output is not a count', () => {
    // 0 is the answer that tells the user "nothing will be lost". Never guess it.
    for (const junk of ['', '\n', 'fatal: ambiguous argument', '-1', '2 3', 'NaN', '1.5']) {
      expect(() => parseCommitCount(junk), junk).toThrow(/commit count/);
    }
  });
});

describe('parseUpstream', () => {
  it('reads the abbreviated upstream ref', () => {
    expect(parseUpstream('origin/main\n')).toBe('origin/main');
    expect(parseUpstream('upstream/release-1.2\n')).toBe('upstream/release-1.2');
  });

  it('returns null when there is none', () => {
    expect(parseUpstream('')).toBeNull();
    expect(parseUpstream('\n')).toBeNull();
    // git echoes the literal when it cannot resolve it.
    expect(parseUpstream('@{u}')).toBeNull();
    expect(parseUpstream('origin/main\nsomething else')).toBeNull();
  });
});

describe('revRange', () => {
  it('composes <base>..HEAD', () => {
    expect(revRange('main')).toBe('main..HEAD');
    expect(revRange('origin/main')).toBe('origin/main..HEAD');
  });

  it('refuses a base that would arrive at git as an option', () => {
    // `--all..HEAD` is a single argv element, so the array form does not save
    // us here -- the validation does.
    expect(() => revRange('--all')).toThrow(/Invalid base branch name/);
    expect(() => revRange('-b')).toThrow(/Invalid base branch name/);
    expect(() => revRange('a b')).toThrow(/Invalid base branch name/);
    expect(() => revRange('')).toThrow(/Invalid base branch name/);
  });
});

describe('unmergedCommits', () => {
  const upstreamArgs = ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'];

  it('counts against the upstream when the branch has one', async () => {
    const calls = install(({ args }) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'origin/main\n', stderr: '' };
      if (args[0] === 'rev-list') return { code: 0, stdout: '2\n', stderr: '' };
      return undefined;
    });
    expect(await unmergedCommits('/wt', 'main')).toEqual({ ahead: 2, upstream: 'origin/main' });
    expect(calls.map((c) => c.args)).toEqual([
      upstreamArgs,
      ['rev-list', '--count', 'origin/main..HEAD', '--'],
    ]);
    expect(calls.every((c) => c.cwd === '/wt')).toBe(true);
  });

  it('falls back to the task base branch when there is no upstream', async () => {
    const calls = install(({ args }) => {
      if (args[0] === 'rev-parse') {
        return { code: 128, stdout: '', stderr: "fatal: no upstream configured for branch 'feat'" };
      }
      if (args[0] === 'rev-list') return { code: 0, stdout: '3\n', stderr: '' };
      return undefined;
    });
    expect(await unmergedCommits('/wt', 'main')).toEqual({ ahead: 3, upstream: null });
    expect(calls[1]?.args).toEqual(['rev-list', '--count', 'main..HEAD', '--']);
  });

  it('reports 0 for a fully merged branch', async () => {
    install(({ args }) =>
      args[0] === 'rev-parse'
        ? { code: 128, stdout: '', stderr: 'fatal: no upstream' }
        : { code: 0, stdout: '0\n', stderr: '' },
    );
    expect(await unmergedCommits('/wt', 'main')).toEqual({ ahead: 0, upstream: null });
  });

  it('surfaces git stderr instead of reporting 0 when the base is unknown', async () => {
    install(({ args }) =>
      args[0] === 'rev-parse'
        ? { code: 128, stdout: '', stderr: 'fatal: HEAD does not point to a branch' }
        : {
            code: 128,
            stdout: '',
            stderr: "fatal: ambiguous argument 'nope..HEAD': unknown revision or path",
          },
    );
    const err = await unmergedCommits('/wt', 'nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('base-missing');
    expect((err as GitError).message).toContain('ambiguous argument');
  });

  it('throws on an unreadable count rather than returning 0', async () => {
    install(({ args }) =>
      args[0] === 'rev-parse'
        ? { code: 128, stdout: '', stderr: 'no upstream' }
        : { code: 0, stdout: 'warning: something\n', stderr: '' },
    );
    await expect(unmergedCommits('/wt', 'main')).rejects.toThrow(/commit count/);
  });

  it('never spawns git for an option-like base branch', async () => {
    const calls = install(({ args }) =>
      args[0] === 'rev-parse' ? { code: 128, stdout: '', stderr: 'no upstream' } : undefined,
    );
    await expect(unmergedCommits('/wt', '--all')).rejects.toThrow(/Invalid base branch name/);
    expect(calls.map((c) => c.args)).toEqual([upstreamArgs]);
  });
});

describe('parseRefList', () => {
  it('drops blanks and trims CRLF', () => {
    expect(parseRefList('main\r\nfeature/x\n\n  dev  \n')).toEqual(['main', 'feature/x', 'dev']);
    expect(parseRefList('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path composition
// ---------------------------------------------------------------------------

describe('composeWorktreePath / agentsRoot / basename', () => {
  it('builds ~/agents/<repo>/<slug>', () => {
    expect(composeWorktreePath('/Users/m', 'albedo', 'fix-login')).toBe(
      '/Users/m/agents/albedo/fix-login',
    );
  });

  it('is insensitive to stray slashes on the home directory', () => {
    expect(composeWorktreePath('/Users/m/', 'albedo', 'fix')).toBe('/Users/m/agents/albedo/fix');
    expect(composeWorktreePath('/Users/m//', '/albedo/', '/fix/')).toBe(
      '/Users/m/agents/albedo/fix',
    );
  });

  it('agentsRoot and basename agree with it', () => {
    expect(agentsRoot('/Users/m')).toBe('/Users/m/agents');
    expect(agentsRoot('/Users/m/')).toBe('/Users/m/agents');
    expect(basename('/Users/m/www/albedo')).toBe('albedo');
    expect(basename('/Users/m/www/albedo/')).toBe('albedo');
    expect(basename('albedo')).toBe('albedo');
    expect(basename('/')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// stderr classification -- wording pinned against git 2.50.1
// ---------------------------------------------------------------------------

describe('classifyGitError', () => {
  const cases: Array<[string, string]> = [
    ['fatal: not a git repository (or any of the parent directories): .git', 'not-a-repo'],
    ["fatal: a branch named 'feat-1' already exists", 'branch-exists'],
    ["fatal: 'feat-5' is already used by worktree at '/Users/m/agents/x/wt5'", 'branch-checked-out'],
    ["fatal: 'main' is already checked out at '/Users/m/www/albedo'", 'branch-checked-out'],
    ['fatal: invalid reference: nosuchbase', 'base-missing'],
    ["fatal: not a valid object name: 'nope'", 'base-missing'],
    [
      "fatal: '/Users/m/agents/x/wt1' contains modified or untracked files, use --force to delete it",
      'dirty',
    ],
    ["error: the branch 'feat' is not fully merged", 'branch-not-merged'],
    ["fatal: '/Users/m/agents/x/wt1' already exists", 'path-exists'],
    ['fatal: something we have never seen', 'unknown'],
    ['', 'unknown'],
  ];

  for (const [stderr, kind] of cases) {
    it(`classifies ${JSON.stringify(stderr.slice(0, 44))} as ${kind}`, () => {
      expect(classifyGitError(stderr)).toBe(kind);
    });
  }

  it('does not mistake a path containing the word "branch" for an existing branch', () => {
    // The naive check ("already exists" + "branch") gets this wrong.
    expect(classifyGitError("fatal: '/Users/m/agents/app/fix-branch' already exists")).toBe(
      'path-exists',
    );
  });
});

// ---------------------------------------------------------------------------
// Command construction -- the exact argv we hand to git
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  it('issues `worktree add -b <branch> -- <path> <base>`', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await createWorktree({
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fix-login',
      path: '/Users/m/agents/repo/fix-login',
    });
    expect(calls).toEqual([
      {
        args: ['worktree', 'add', '-b', 'fix-login', '--', '/Users/m/agents/repo/fix-login', 'main'],
        cwd: '/repo',
      },
    ]);
  });

  it('issues `worktree add -- <path> <branch>` when reusing an existing branch', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await createWorktree({
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fix-login',
      path: '/wt',
      useExistingBranch: true,
    });
    expect(calls[0]?.args).toEqual(['worktree', 'add', '--', '/wt', 'fix-login']);
  });

  it('signals branch-exists to the caller instead of guessing', async () => {
    install(() => ({
      code: 128,
      stdout: '',
      stderr: "fatal: a branch named 'fix-login' already exists",
    }));
    const err = await createWorktree({
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fix-login',
      path: '/wt',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('branch-exists');
    // stderr is surfaced verbatim; the dialog shows this.
    expect((err as GitError).message).toContain("a branch named 'fix-login' already exists");
  });

  it('never spawns git for an option-like branch, base or path', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    const base = { repoPath: '/repo', baseBranch: 'main', branch: 'ok', path: '/wt' };
    await expect(createWorktree({ ...base, branch: '--upload-pack=pwn' })).rejects.toThrow(
      /Invalid branch name/,
    );
    await expect(createWorktree({ ...base, baseBranch: '-x' })).rejects.toThrow(
      /Invalid base branch name/,
    );
    await expect(createWorktree({ ...base, path: '--force' })).rejects.toThrow(
      /starts with "-"/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('listWorktrees / listBranches / uncommittedChanges', () => {
  it('asks for the porcelain form', async () => {
    const calls = install(() => ({
      code: 0,
      stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n',
      stderr: '',
    }));
    const wts = await listWorktrees('/repo');
    expect(calls[0]?.args).toEqual(['worktree', 'list', '--porcelain']);
    expect(wts[0]).toMatchObject({ path: '/repo', branch: 'main', head: 'abc', locked: false });
  });

  it('throws with git stderr when the directory is not a repo', async () => {
    install(() => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }));
    const err = await listWorktrees('/nope').catch((e: unknown) => e);
    expect((err as GitError).kind).toBe('not-a-repo');
    expect((err as GitError).message).toContain('not a git repository');
  });

  it('lists local then remote branches and the current one', async () => {
    const calls = install(({ args }) => {
      if (args[2] === 'refs/heads') return { code: 0, stdout: 'main\nfix-login\n', stderr: '' };
      if (args[2] === 'refs/remotes') {
        return { code: 0, stdout: 'origin/HEAD\norigin/main\norigin/next\n', stderr: '' };
      }
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'main\n', stderr: '' };
      return undefined;
    });
    const { current, all } = await listBranches('/repo');
    expect(current).toBe('main');
    expect(all).toEqual(['main', 'fix-login', 'origin/main', 'origin/next']);
    expect(calls[0]?.args).toEqual(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  });

  it('falls back to the short commit id on a detached HEAD', async () => {
    install(({ args }) => {
      if (args[0] === 'for-each-ref') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'symbolic-ref') return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: '262adc4\n', stderr: '' };
      return undefined;
    });
    expect((await listBranches('/repo')).current).toBe('262adc4');
  });

  it('requests untracked files explicitly, in the -z form', async () => {
    const calls = install(() => ({
      code: 0,
      stdout: '?? a.txt\u0000 M b.txt\u0000',
      stderr: '',
    }));
    const r = await uncommittedChanges('/wt');
    expect(calls[0]).toEqual({
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      cwd: '/wt',
    });
    expect(r.dirty).toBe(true);
    expect(r.files).toEqual(['?? a.txt', ' M b.txt']);
  });

  it('reports a clean worktree as not dirty', async () => {
    install(() => ({ code: 0, stdout: '', stderr: '' }));
    expect(await uncommittedChanges('/wt')).toMatchObject({ dirty: false, files: [] });
  });
});

describe('removeWorktree', () => {
  const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];

  it('refuses a dirty worktree without force, and never reaches `worktree remove`', async () => {
    const calls = install(({ args }) =>
      args[0] === 'status' ? { code: 0, stdout: '?? notes.md\u0000', stderr: '' } : undefined,
    );
    const err = await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: false,
      deleteBranch: true,
    }).catch((e: unknown) => e);
    expect((err as GitError).kind).toBe('dirty');
    expect((err as GitError).message).toContain('?? notes.md');
    expect(calls.map((c) => c.args)).toEqual([statusArgs]);
  });

  it('removes, deletes the branch and prunes -- in that order', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await removeWorktree({
      repoPath: '/repo',
      path: '/Users/m/agents/repo/fix',
      branch: 'fix',
      force: false,
      deleteBranch: true,
    });
    expect(calls.map((c) => c.args)).toEqual([
      statusArgs,
      ['worktree', 'remove', '--', '/Users/m/agents/repo/fix'],
      ['branch', '-d', '--', 'fix'],
      ['worktree', 'prune'],
    ]);
  });

  it('uses --force and -D only when forced, and skips the dirty check', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: true,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['worktree', 'remove', '--force', '--', '/wt'],
      ['branch', '-D', '--', 'fix'],
      ['worktree', 'prune'],
    ]);
  });

  it('leaves the branch alone when deleteBranch is false', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: false,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['worktree', 'remove', '--force', '--', '/wt'],
      ['worktree', 'prune'],
    ]);
  });

  it('surfaces an unmerged-branch failure but still prunes', async () => {
    const calls = install(({ args }) =>
      args[0] === 'branch'
        ? { code: 1, stdout: '', stderr: "error: the branch 'fix' is not fully merged" }
        : undefined,
    );
    const err = await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: false,
      deleteBranch: true,
    }).catch((e: unknown) => e);
    expect((err as GitError).kind).toBe('branch-not-merged');
    expect(calls.map((c) => c.args)).toContainEqual(['worktree', 'prune']);
  });

  it('proceeds when the worktree directory has already vanished', async () => {
    // `git status` fails because the path is gone; removal must still be tried.
    const calls = install(({ args }) =>
      args[0] === 'status'
        ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
        : undefined,
    );
    await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: null,
      force: false,
      deleteBranch: false,
    });
    expect(calls.map((c) => c.args)).toEqual([
      statusArgs,
      ['worktree', 'remove', '--', '/wt'],
      ['worktree', 'prune'],
    ]);
  });

  it('refuses an option-like path or branch before spawning anything', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(
      removeWorktree({
        repoPath: '/repo',
        path: '--force',
        branch: null,
        force: true,
        deleteBranch: false,
      }),
    ).rejects.toThrow(/starts with "-"/);
    await expect(
      removeWorktree({
        repoPath: '/repo',
        path: '/wt',
        branch: '-D',
        force: true,
        deleteBranch: true,
      }),
    ).rejects.toThrow(/Invalid branch name/);
    expect(calls).toHaveLength(0);
  });
});
