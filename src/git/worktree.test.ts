import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseCommitFileTimes,
  parseCommitLog,
  parseNumstat,
  GitError,
  type GitResult,
  type WorkAtRisk,
  ackLabel,
  assessLoss,
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
  RiskChangedError,
  branchCreatedWithTask,
  parseBranchCreation,
  removeWorktree,
  riskGrew,
  taskCreatedBranch,
  undoCreateWorktree,
  repoRootFor,
  repoRootFromCommonDir,
  revRange,
  defaultWorktreeRoot,
  setGitRunner,
  setPathExistsProbe,
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
let restoreProbe: (() => void) | null = null;
afterEach(() => {
  if (restoreRunner) restoreRunner();
  if (restoreProbe) restoreProbe();
  restoreRunner = null;
  restoreProbe = null;
  vi.restoreAllMocks();
});

/**
 * Install a fake git runner. Also stubs the path-existence probe, which
 * defaults to "nothing exists" -- the happy path for createWorktree. Pass
 * `existingPaths` to make specific paths look occupied.
 */
function install(replies: (call: Call) => GitResult | undefined, existingPaths: string[] = []) {
  const f = fakeGit(replies);
  restoreRunner = () => setGitRunner(f.restore);
  const prevProbe = setPathExistsProbe(async (path) => existingPaths.includes(path));
  restoreProbe = () => setPathExistsProbe(prevProbe);
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

// ---------------------------------------------------------------------------
// What a removal would destroy -- shared by both confirmation dialogs
// ---------------------------------------------------------------------------

describe('assessLoss', () => {
  const clean: WorkAtRisk = { files: [], ahead: 0, aheadBase: 'main' };
  const dirty: WorkAtRisk = { files: ['?? a.txt', ' M b.ts'], ahead: 0, aheadBase: 'main' };
  const unmerged: WorkAtRisk = { files: [], ahead: 2, aheadBase: 'origin/main' };

  it('sees nothing at risk in a clean, merged worktree', () => {
    for (const deleteBranch of [true, false]) {
      expect(assessLoss(clean, { deleteBranch })).toEqual({
        dirty: false,
        unmerged: false,
        unknown: false,
        needsAck: false,
      });
    }
  });

  it('counts uncommitted changes whether or not the branch is deleted', () => {
    // The working tree dies with the worktree either way.
    expect(assessLoss(dirty, { deleteBranch: false })).toMatchObject({
      dirty: true,
      needsAck: true,
    });
    expect(assessLoss(dirty, { deleteBranch: true })).toMatchObject({ dirty: true, needsAck: true });
  });

  it('counts unmerged commits ONLY when the branch is deleted', () => {
    // Keeping the branch leaves committed work reachable by name, so warning
    // about it would be crying wolf -- and would train the user to tick past it.
    expect(assessLoss(unmerged, { deleteBranch: false })).toEqual({
      dirty: false,
      unmerged: false,
      unknown: false,
      needsAck: false,
    });
    expect(assessLoss(unmerged, { deleteBranch: true })).toMatchObject({
      unmerged: true,
      needsAck: true,
    });
  });

  it('treats an unreadable status as a loss, always', () => {
    const unknownFiles: WorkAtRisk = { files: null, ahead: 0, aheadBase: 'main' };
    expect(assessLoss(unknownFiles, { deleteBranch: false })).toMatchObject({
      unknown: true,
      needsAck: true,
    });
  });

  it('treats an unknown commit count as a loss only when deleting the branch', () => {
    const unknownAhead: WorkAtRisk = { files: [], ahead: null, aheadBase: 'main' };
    expect(assessLoss(unknownAhead, { deleteBranch: false })).toMatchObject({
      unknown: false,
      needsAck: false,
    });
    expect(assessLoss(unknownAhead, { deleteBranch: true })).toMatchObject({
      unknown: true,
      needsAck: true,
    });
  });
});

describe('ackLabel', () => {
  it('names the uncommitted count', () => {
    expect(ackLabel({ files: ['?? a', ' M b'], ahead: 0, aheadBase: 'main' }, { deleteBranch: false }))
      .toBe('I understand 2 uncommitted change(s) will be permanently lost.');
  });

  it('names the unmerged count and the base it was compared against', () => {
    expect(ackLabel({ files: [], ahead: 3, aheadBase: 'origin/main' }, { deleteBranch: true })).toBe(
      'I understand 3 commit(s) not merged into origin/main will be permanently lost.',
    );
  });

  it('names both counts when both apply', () => {
    expect(
      ackLabel({ files: ['?? a'], ahead: 2, aheadBase: 'origin/main' }, { deleteBranch: true }),
    ).toBe(
      'I understand 1 uncommitted change(s) and 2 commit(s) not merged into origin/main ' +
        'will be permanently lost.',
    );
  });

  it('drops the unmerged half when the branch is kept', () => {
    expect(
      ackLabel({ files: ['?? a'], ahead: 2, aheadBase: 'origin/main' }, { deleteBranch: false }),
    ).toBe('I understand 1 uncommitted change(s) will be permanently lost.');
  });

  it('says so when it could not check', () => {
    expect(ackLabel({ files: null, ahead: 0, aheadBase: 'main' }, { deleteBranch: false })).toMatch(
      /could not check/,
    );
    expect(
      ackLabel({ files: ['?? a'], ahead: null, aheadBase: 'main' }, { deleteBranch: true }),
    ).toBe(
      'I understand 1 uncommitted change(s) will be permanently lost, and that some of this ' +
        'worktree could not be checked.',
    );
  });

  it('falls back to a phrase when there is no base branch name', () => {
    expect(ackLabel({ files: [], ahead: 1, aheadBase: null }, { deleteBranch: true })).toContain(
      'not merged into the base branch',
    );
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

describe('composeWorktreePath', () => {
  it('builds <worktreeRoot>/<slug>, with no repo segment of our own', () => {
    // The root is per-project now, so the directory the user chose IS the
    // namespace. Inserting a <repo> segment would defeat the point.
    expect(composeWorktreePath('/Users/m/www/worktrees', 'fix-login')).toBe(
      '/Users/m/www/worktrees/fix-login',
    );
  });

  it('expands a leading ~ when a home directory is supplied', () => {
    expect(composeWorktreePath('~/agents/albedo', 'fix', '/Users/m')).toBe(
      '/Users/m/agents/albedo/fix',
    );
    expect(composeWorktreePath('~', 'fix', '/Users/m')).toBe('/Users/m/fix');
  });

  it('is insensitive to stray slashes and redundant segments', () => {
    expect(composeWorktreePath('/Users/m/wt/', 'fix')).toBe('/Users/m/wt/fix');
    expect(composeWorktreePath('/Users/m//wt///', '/fix/')).toBe('/Users/m/wt/fix');
    expect(composeWorktreePath('/Users/m/a/../wt', 'fix')).toBe('/Users/m/wt/fix');
  });
});

describe('defaultWorktreeRoot', () => {
  it('suggests ~/agents/<name>, matching the migration backfill', () => {
    expect(defaultWorktreeRoot('albedo')).toBe('~/agents/albedo');
    expect(defaultWorktreeRoot('  albedo  ')).toBe('~/agents/albedo');
    expect(defaultWorktreeRoot('')).toBe('~/agents/project');
    expect(defaultWorktreeRoot('/weird/')).toBe('~/agents/weird');
  });
});

describe('repoRootFromCommonDir', () => {
  it('strips the .git of a normal repo', () => {
    // The case that matters: identical from the main checkout and from any
    // linked worktree, which is what --show-toplevel could not give us.
    expect(repoRootFromCommonDir('/Users/m/www/acme/.git', false)).toBe(
      '/Users/m/www/acme',
    );
    expect(repoRootFromCommonDir('/Users/m/www/acme/.git/', false)).toBe(
      '/Users/m/www/acme',
    );
  });

  it('keeps a bare repo as itself — the directory IS the repository', () => {
    // dirname() here would yield /srv, which is not a repo at all.
    expect(repoRootFromCommonDir('/srv/mirror.git', true)).toBe('/srv/mirror.git');
  });

  it('refuses a relative common dir rather than letting `.git` through', () => {
    // Without --path-format=absolute, git prints exactly this from the main
    // repo. A project whose repo_path was the literal string `.git` would be a
    // memorable bug.
    expect(repoRootFromCommonDir('.git', false)).toBeNull();
    expect(repoRootFromCommonDir('.git', true)).toBeNull();
    expect(repoRootFromCommonDir('../.git', false)).toBeNull();
    expect(repoRootFromCommonDir('', false)).toBeNull();
    expect(repoRootFromCommonDir('   ', false)).toBeNull();
  });

  it('returns null for a layout it cannot map back to a working tree', () => {
    // --separate-git-dir: the common dir is unrelated to the tree, so the
    // caller falls back rather than inventing a path.
    expect(repoRootFromCommonDir('/Users/m/elsewhere.git', false)).toBeNull();
    expect(repoRootFromCommonDir('/.git', false)).toBeNull();
  });

  it('is not fooled by a repo directory that ends in .git', () => {
    expect(repoRootFromCommonDir('/Users/m/www/thing.git/.git', false)).toBe(
      '/Users/m/www/thing.git',
    );
  });
});

describe('repoRootFor', () => {
  const revParseArgs = [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--is-bare-repository',
  ];

  it('asks for the common dir, absolute, in one call', async () => {
    const calls = install(() => ({
      code: 0,
      stdout: '/Users/m/www/acme/.git\nfalse\n',
      stderr: '',
    }));
    expect(await repoRootFor('/Users/m/www/acme-worktree/ACME-2398')).toBe(
      '/Users/m/www/acme',
    );
    expect(calls).toEqual([
      { args: revParseArgs, cwd: '/Users/m/www/acme-worktree/ACME-2398' },
    ]);
  });

  it('gives the same answer from a worktree as from the main checkout', async () => {
    // The actual bug: a task in a worktree of acme did not match the
    // acme project and fell into the "Other" tab.
    const reply = { code: 0, stdout: '/Users/m/www/acme/.git\nfalse\n', stderr: '' };
    install(() => reply);
    const fromMain = await repoRootFor('/Users/m/www/acme');
    install(() => reply);
    const fromWorktree = await repoRootFor('/Users/m/www/acme-worktree/ACME-2398');
    expect(fromWorktree).toBe(fromMain);
  });

  it('handles a bare repository', async () => {
    install(() => ({ code: 0, stdout: '/srv/mirror.git\ntrue\n', stderr: '' }));
    expect(await repoRootFor('/srv/mirror.git')).toBe('/srv/mirror.git');
  });

  it('falls back to the working tree for a layout it cannot map', async () => {
    const calls = install(({ args }) =>
      args.includes('--git-common-dir')
        ? { code: 0, stdout: '/Users/m/elsewhere.git\nfalse\n', stderr: '' }
        : { code: 0, stdout: '/Users/m/sep\n', stderr: '' },
    );
    expect(await repoRootFor('/Users/m/sep')).toBe('/Users/m/sep');
    expect(calls[1]?.args).toEqual(['rev-parse', '--show-toplevel']);
  });

  it('surfaces git stderr when the directory is not a repo', async () => {
    install(() => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }));
    const err = await repoRootFor('/Users/m/Documents').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('not-a-repo');
  });
});

describe('basename', () => {
  it('takes the last segment', () => {
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

  it('refuses a path that already exists rather than writing into it', async () => {
    // git only objects when the directory is NON-empty, so without this check an
    // empty folder the user made for something else quietly becomes a worktree.
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }), ['/wt']);
    const err = await createWorktree({
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fix',
      path: '/wt',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('path-exists');
    expect((err as GitError).message).toContain('/wt already exists');
    expect(calls).toHaveLength(0);
  });

  it('still creates when the path is free', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }), ['/somewhere-else']);
    await createWorktree({ repoPath: '/repo', baseBranch: 'main', branch: 'fix', path: '/wt' });
    expect(calls).toHaveLength(1);
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

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

/**
 * Replies for the probe {@link removeWorktree} runs before forcing. `files`
 * is raw `status -z` output, or null for "status fails"; every other command
 * succeeds silently.
 */
function probeReplies(o: { files: string | null; ahead: number; head?: string }) {
  return ({ args }: Call): GitResult | undefined => {
    if (args[0] === 'status') {
      return o.files === null
        ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
        : { code: 0, stdout: o.files, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args.includes('@{u}')) {
      return { code: 128, stdout: '', stderr: 'fatal: no upstream configured' };
    }
    if (args[0] === 'rev-list') return { code: 0, stdout: `${o.ahead}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('HEAD')) {
      return { code: 0, stdout: `${o.head ?? HEAD_A}\n`, stderr: '' };
    }
    return undefined;
  };
}

/** Only the commands that change anything. */
function mutating(calls: Call[]): string[][] {
  return calls.map((c) => c.args).filter((a) => a[0] === 'worktree' || a[0] === 'branch');
}

describe('riskGrew', () => {
  const acked: WorkAtRisk = { files: [' M a.ts'], ahead: 2, aheadBase: 'main', head: HEAD_A };
  const del = { deleteBranch: true };
  const keep = { deleteBranch: false };

  it('is false for the same facts', () => {
    expect(riskGrew(acked, { ...acked }, del)).toBe(false);
  });
  it('flags a new file, and an unreadable status', () => {
    expect(riskGrew(acked, { ...acked, files: [' M a.ts', '?? b.ts'] }, keep)).toBe(true);
    expect(riskGrew(acked, { ...acked, files: null }, keep)).toBe(true);
  });
  it('does not flag fewer files', () => {
    expect(riskGrew(acked, { ...acked, files: [] }, keep)).toBe(false);
  });
  it('flags more commits, a moved HEAD, or an unknown count -- only when deleting the branch', () => {
    expect(riskGrew(acked, { ...acked, ahead: 3, head: HEAD_B }, del)).toBe(true);
    expect(riskGrew(acked, { ...acked, head: HEAD_B }, del)).toBe(true); // reset + recommit
    expect(riskGrew(acked, { ...acked, ahead: null }, del)).toBe(true);
    expect(riskGrew(acked, { ...acked, ahead: 3, head: HEAD_B }, keep)).toBe(false);
  });
  it('does not flag a branch that is now fully merged', () => {
    expect(riskGrew(acked, { ...acked, ahead: 0, head: HEAD_B }, del)).toBe(false);
  });
});

describe('undoCreateWorktree', () => {
  const opts = { repoPath: '/repo', baseBranch: 'main', branch: 'fix', path: '/wt' };

  it('removes the worktree unforced and deletes a branch it cut with -d', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    expect(await undoCreateWorktree(opts)).toBeNull();
    expect(mutating(calls)).toEqual([
      ['worktree', 'remove', '--', '/wt'],
      ['branch', '-d', '--', 'fix'],
      ['worktree', 'prune'],
    ]);
  });

  it('never deletes a branch that already existed', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    expect(await undoCreateWorktree({ ...opts, useExistingBranch: true })).toBeNull();
    expect(mutating(calls)).toEqual([
      ['worktree', 'remove', '--', '/wt'],
      ['worktree', 'prune'],
    ]);
  });

  it('says what was left behind instead of forcing', async () => {
    install(({ args }) =>
      args[0] === 'status' ? { code: 0, stdout: '?? new.txt\u0000', stderr: '' } : undefined,
    );
    const left = await undoCreateWorktree(opts);
    expect(left).toContain('/wt was left on disk');
    expect(left).toContain('branch fix was kept');
  });

  it('names a branch -d refused to delete', async () => {
    install(({ args }) =>
      args[0] === 'branch'
        ? { code: 1, stdout: '', stderr: "error: the branch 'fix' is not fully merged" }
        : undefined,
    );
    expect(await undoCreateWorktree(opts)).toContain('the branch fix was left behind');
  });
});

describe('branch provenance', () => {
  // 2026-10-19T10:00:00Z, in ms, as tasks.created_at stores it.
  const TASK_MS = 1_792_404_000_000;
  const T = TASK_MS / 1000;

  it('reads the creation entry from the oldest reflog line', () => {
    const out = `fix@{${T + 600}}\tcommit: x\nfix@{${T - 1}}\tbranch: Created from main\n`;
    expect(parseBranchCreation(out)).toEqual({ at: T - 1 });
  });
  it('returns null when the oldest surviving entry is not a creation', () => {
    expect(parseBranchCreation(`fix@{${T}}\tcommit: x\n`)).toBeNull();
    expect(parseBranchCreation(`fix@{${T}}\tBranch: renamed refs/heads/a to refs/heads/fix\n`)).toBeNull();
    expect(parseBranchCreation('')).toBeNull();
  });
  it('counts a branch as the task’s only if created alongside the row', () => {
    expect(branchCreatedWithTask({ at: T - 1 }, TASK_MS)).toBe(true);
    // "Check out the existing branch": made long before the task.
    expect(branchCreatedWithTask({ at: T - 86_400 }, TASK_MS)).toBe(false);
    expect(branchCreatedWithTask({ at: T + 3_600 }, TASK_MS)).toBe(false);
    expect(branchCreatedWithTask(null, TASK_MS)).toBe(false);
  });
  it('answers false, never throws, when the reflog cannot be read', async () => {
    install(() => ({ code: 128, stdout: '', stderr: 'fatal: ambiguous argument' }));
    expect(await taskCreatedBranch('/repo', 'fix', TASK_MS)).toBe(false);
  });
  it('asks git for the branch reflog with unix dates', async () => {
    const calls = install(() => ({
      code: 0,
      stdout: `fix@{${T}}\tbranch: Created from main\n`,
      stderr: '',
    }));
    expect(await taskCreatedBranch('/repo', 'fix', TASK_MS)).toBe(true);
    expect(calls[0]?.args).toEqual([
      'reflog', 'show', '--date=unix', '--format=%gd%x09%gs', 'refs/heads/fix', '--',
    ]);
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
    const calls = install(probeReplies({ files: '', ahead: 0 }));
    await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: true,
      acknowledged: { risk: { files: [], ahead: 0, aheadBase: 'main', head: HEAD_A }, baseBranch: 'main' },
    });
    expect(mutating(calls)).toEqual([
      ['worktree', 'remove', '--force', '--', '/wt'],
      ['branch', '-D', '--', 'fix'],
      ['worktree', 'prune'],
    ]);
  });

  it('leaves the branch alone when deleteBranch is false', async () => {
    const calls = install(probeReplies({ files: '', ahead: 0 }));
    await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: false,
      acknowledged: { risk: { files: [], ahead: 0, aheadBase: 'main', head: HEAD_A }, baseBranch: 'main' },
    });
    expect(mutating(calls)).toEqual([
      ['worktree', 'remove', '--force', '--', '/wt'],
      ['worktree', 'prune'],
    ]);
  });

  // --- the acknowledgement is only good for what it described -------------

  it('refuses to force without the acknowledged state, before spawning anything', async () => {
    const calls = install(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(
      removeWorktree({ repoPath: '/repo', path: '/wt', branch: 'fix', force: true, deleteBranch: true }),
    ).rejects.toThrow(/without the acknowledged state/);
    expect(calls).toHaveLength(0);
  });

  it('aborts when Claude committed after the tick, and hands back the new facts', async () => {
    // Acknowledged: 1 dirty file, 0 unmerged. Now: 3 commits, HEAD moved.
    const calls = install(probeReplies({ files: '', ahead: 3, head: HEAD_B }));
    const err = await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: true,
      acknowledged: {
        risk: { files: [' M a.ts'], ahead: 0, aheadBase: 'main', head: HEAD_A },
        baseBranch: 'main',
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskChangedError);
    expect((err as RiskChangedError).now.risk).toMatchObject({ ahead: 3, head: HEAD_B, files: [] });
    expect(mutating(calls)).toEqual([]);
  });

  it('aborts when a new uncommitted file appeared after the tick', async () => {
    const calls = install(probeReplies({ files: ' M a.ts\u0000?? b.ts\u0000', ahead: 0 }));
    const err = await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: false,
      acknowledged: { risk: { files: [' M a.ts'], ahead: 0, aheadBase: 'main', head: HEAD_A }, baseBranch: 'main' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskChangedError);
    expect(mutating(calls)).toEqual([]);
  });

  it('proceeds when the work only shrank (the dirty file was committed, branch kept)', async () => {
    const calls = install(probeReplies({ files: '', ahead: 1, head: HEAD_B }));
    await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: false,
      acknowledged: { risk: { files: [' M a.ts'], ahead: 0, aheadBase: 'main', head: HEAD_A }, baseBranch: 'main' },
    });
    expect(mutating(calls)[0]).toEqual(['worktree', 'remove', '--force', '--', '/wt']);
  });

  it('aborts when status became unreadable after the tick', async () => {
    const calls = install(probeReplies({ files: null, ahead: 0 }));
    const err = await removeWorktree({
      repoPath: '/repo',
      path: '/wt',
      branch: 'fix',
      force: true,
      deleteBranch: false,
      acknowledged: { risk: { files: [], ahead: 0, aheadBase: 'main', head: HEAD_A }, baseBranch: 'main' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskChangedError);
    expect(mutating(calls)).toEqual([]);
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

describe('parseNumstat', () => {
  it('reads counts per path, binary as null, and skips junk', () => {
    const m = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tlogo.png\n\nnot a line\n0\t7\tdocs/x y.md\n');
    expect(m.get('src/a.ts')).toEqual({ added: 12, deleted: 3 });
    expect(m.get('logo.png')).toEqual({ added: null, deleted: null });
    expect(m.get('docs/x y.md')).toEqual({ added: 0, deleted: 7 });
    expect(m.size).toBe(3);
  });
});

describe('parseCommitFileTimes', () => {
  it('keeps the newest commit time per path', () => {
    const out = '\u00001700000200\n\nsrc/a.ts\nsrc/b.ts\n\u00001700000100\n\nsrc/a.ts\nsrc/c.ts\n';
    const m = parseCommitFileTimes(out);
    expect(m.get('src/a.ts')).toBe(1700000200_000);
    expect(m.get('src/b.ts')).toBe(1700000200_000);
    expect(m.get('src/c.ts')).toBe(1700000100_000);
    expect(m.size).toBe(3);
  });
  it('is empty for empty output', () => {
    expect(parseCommitFileTimes('').size).toBe(0);
  });
});

describe('parseCommitLog', () => {
  it('reads commits newest first, each with its files and counts', () => {
    const out =
      '\u0000aaa111\t1700000200\tSecond: fix\tthing\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n' +
      '\u0000bbb222\t1700000100\tFirst\n\n10\t0\tsrc/a.ts\n';
    const commits = parseCommitLog(out);
    expect(commits.map((c) => c.sha)).toEqual(['aaa111', 'bbb222']);
    expect(commits[0]?.subject).toBe('Second: fix\tthing');
    expect(commits[0]?.at).toBe(1700000200_000);
    expect(commits[0]?.files.get('src/a.ts')).toEqual({ added: 3, deleted: 1 });
    expect(commits[0]?.files.get('img.png')).toEqual({ added: null, deleted: null });
    expect(commits[1]?.files.size).toBe(1);
  });
});
