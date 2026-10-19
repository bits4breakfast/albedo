import { describe, expect, it } from 'vitest';
import {
  type ClassifyInput,
  albedoOwnsWorktree,
  checkWorktreeRoot,
  type DiskCandidate,
  type RepoScan,
  classifyOrphans,
  expandTilde,
  gitdirToRepoPath,
  isUnder,
  normalizePath,
  parseDotGitFile,
  pathKey,
  resolveAgainst,
  reclaimableTaskPaths,
  worktreeSharedWithLiveTask,
  rootContaining,
  validateWorktreeRoot,
} from './reconcile';
import { parseWorktreePorcelain } from './worktree';

const HOME = '/Users/m';

function scan(repoPath: string, porcelain: string): RepoScan {
  return { repoPath, worktrees: parseWorktreePorcelain(porcelain) };
}

/**
 * classifyOrphans with a default project worktree root, so the existing cases
 * keep testing what they were written to test. ~/agents is now just "the root
 * this project happens to use", not a hardcoded location.
 */
function classify(input: Omit<ClassifyInput, 'worktreeRoots'> & { worktreeRoots?: string[] }) {
  return classifyOrphans({ worktreeRoots: ['/Users/m/agents'], ...input });
}

// ---------------------------------------------------------------------------
// Path normalisation -- the whole correctness of orphan detection rests here
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it('strips trailing and duplicate slashes', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
    expect(normalizePath('/a//b///c/')).toBe('/a/b/c');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('');
  });

  it('resolves . and .. segments', () => {
    expect(normalizePath('/a/./b')).toBe('/a/b');
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('/a/../../b')).toBe('/b');
  });

  it('applies the macOS firmlinks so /tmp and /private/tmp compare equal', () => {
    expect(normalizePath('/tmp/x')).toBe('/private/tmp/x');
    expect(normalizePath('/tmp')).toBe('/private/tmp');
    expect(normalizePath('/var/folders/y')).toBe('/private/var/folders/y');
    expect(normalizePath('/etc/hosts')).toBe('/private/etc/hosts');
    // Not a firmlink prefix -- must be left alone.
    expect(normalizePath('/tmpfoo/x')).toBe('/tmpfoo/x');
    expect(normalizePath('/Users/m/tmp/x')).toBe('/Users/m/tmp/x');
  });

  it('preserves case (display) while pathKey folds it (comparison)', () => {
    expect(normalizePath('/Users/M/Agents/Repo')).toBe('/Users/M/Agents/Repo');
    expect(pathKey('/Users/M/Agents/Repo/')).toBe('/users/m/agents/repo');
    // HFS+/APFS default is case-insensitive: these are one directory.
    expect(pathKey('/Users/m/agents/Albedo/fix')).toBe(pathKey('/users/m/AGENTS/albedo/FIX'));
    expect(pathKey('/tmp/x/')).toBe(pathKey('/private/tmp/x'));
  });
});

describe('expandTilde', () => {
  it('expands ~ and ~/ only at the start', () => {
    expect(expandTilde('~', HOME)).toBe('/Users/m');
    expect(expandTilde('~/agents/a', HOME)).toBe('/Users/m/agents/a');
    expect(expandTilde('/abs/~/x', HOME)).toBe('/abs/~/x');
    expect(expandTilde('~other/x', HOME)).toBe('~other/x');
    expect(expandTilde('~/x', '/Users/m/')).toBe('/Users/m/x');
  });
});

describe('isUnder', () => {
  it('matches the directory itself and its descendants', () => {
    expect(isUnder('/Users/m/agents', '/Users/m/agents')).toBe(true);
    expect(isUnder('/Users/m/agents', '/Users/m/agents/repo/slug')).toBe(true);
    expect(isUnder('/Users/m/agents/', '/Users/m/agents/repo')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    expect(isUnder('/Users/m/agents', '/Users/m/agents-old/x')).toBe(false);
    expect(isUnder('/Users/m/agents', '/Users/m/www/worktrees/x')).toBe(false);
  });
});

describe('resolveAgainst / parseDotGitFile / gitdirToRepoPath', () => {
  it('reads the gitdir pointer out of a worktree .git file', () => {
    expect(parseDotGitFile('gitdir: /Users/m/www/albedo/.git/worktrees/fix\n')).toBe(
      '/Users/m/www/albedo/.git/worktrees/fix',
    );
    expect(parseDotGitFile('gitdir: ../../.git/worktrees/fix')).toBe('../../.git/worktrees/fix');
    expect(parseDotGitFile('')).toBeNull();
    expect(parseDotGitFile('ref: refs/heads/main')).toBeNull();
    expect(parseDotGitFile('gitdir:   ')).toBeNull();
  });

  it('resolves a relative gitdir against the worktree directory', () => {
    expect(resolveAgainst('/Users/m/agents/albedo/fix', '../../../www/albedo/.git')).toBe(
      '/Users/m/www/albedo/.git',
    );
    expect(resolveAgainst('/Users/m/agents/albedo/fix', '/abs/.git')).toBe('/abs/.git');
  });

  it('derives the repo from a gitdir, or returns null rather than guessing', () => {
    expect(gitdirToRepoPath('/Users/m/www/albedo/.git/worktrees/fix')).toBe('/Users/m/www/albedo');
    expect(gitdirToRepoPath('/Users/m/www/albedo/.git')).toBeNull();
    expect(gitdirToRepoPath(null)).toBeNull();
    expect(gitdirToRepoPath('/.git/worktrees/x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

const albedoPorcelain = [
  'worktree /Users/m/www/albedo',
  'HEAD aaa',
  'branch refs/heads/main',
  '',
  'worktree /Users/m/agents/albedo/tracked-task',
  'HEAD bbb',
  'branch refs/heads/tracked-task',
  '',
  'worktree /Users/m/agents/albedo/left-behind',
  'HEAD ccc',
  'branch refs/heads/left-behind',
  '',
  'worktree /Users/m/www/worktrees/hand-made',
  'HEAD ddd',
  'branch refs/heads/hand-made',
  '',
].join('\n');

describe('classifyOrphans', () => {
  const scans = [scan('/Users/m/www/albedo', albedoPorcelain)];

  it('reports an unclaimed worktree under ~/agents as an orphan', () => {
    const out = classify({
      scans,
      disk: [],
      knownPaths: ['/Users/m/agents/albedo/tracked-task'],
      home: HOME,
    });
    const orphans = out.filter((o) => o.classification === 'orphan');
    expect(orphans.map((o) => o.path)).toEqual(['/Users/m/agents/albedo/left-behind']);
    expect(orphans[0]).toMatchObject({
      branch: 'left-behind',
      head: 'ccc',
      source: 'git',
      repoPath: '/Users/m/www/albedo',
    });
  });

  it("treats the user's own worktree roots as informational, never as orphans", () => {
    // ~/www/worktrees predates Albedo. Offering to delete it would be a bug.
    const out = classify({ scans, disk: [], knownPaths: [], home: HOME });
    const handMade = out.find((o) => o.path === '/Users/m/www/worktrees/hand-made');
    expect(handMade?.classification).toBe('unknown');
    expect(out.filter((o) => o.classification === 'orphan').map((o) => o.path)).toEqual([
      '/Users/m/agents/albedo/left-behind',
      '/Users/m/agents/albedo/tracked-task',
    ]);
  });

  it('never reports the main worktree, even when no task claims the repo', () => {
    const out = classify({ scans, disk: [], knownPaths: [], home: HOME });
    expect(out.map((o) => o.path)).not.toContain('/Users/m/www/albedo');
  });

  it('skips bare repositories', () => {
    const out = classify({
      scans: [scan('/srv/mirror.git', 'worktree /srv/main\nHEAD a\n\nworktree /srv/mirror.git\nbare\n\n')],
      disk: [],
      knownPaths: [],
      home: HOME,
    });
    expect(out).toEqual([]);
  });

  it('honours known paths given with ~, a trailing slash or different case', () => {
    for (const known of [
      '~/agents/albedo/left-behind',
      '/Users/m/agents/albedo/left-behind/',
      '/Users/M/Agents/Albedo/Left-Behind',
      '/Users/m/agents/albedo/../albedo/left-behind',
    ]) {
      const out = classify({
        scans,
        disk: [],
        knownPaths: [known, '/Users/m/agents/albedo/tracked-task'],
        home: HOME,
      });
      expect(out.filter((o) => o.classification === 'orphan'), known).toEqual([]);
    }
  });

  it('reports an archived task worktree, even though its row still exists', () => {
    // The bug this closes: archiveTask only flips a status, so the row (and its
    // worktreePath) survives. Without reclaimablePaths the worktree is both not
    // removed and never offered -- unreachable from the UI.
    const out = classify({
      scans,
      disk: [],
      knownPaths: [
        '/Users/m/agents/albedo/tracked-task',
        '/Users/m/agents/albedo/left-behind',
        '/Users/m/www/worktrees/hand-made',
      ],
      reclaimablePaths: ['/Users/m/agents/albedo/left-behind'],
      home: HOME,
    });
    expect(out.map((o) => o.path)).toEqual(['/Users/m/agents/albedo/left-behind']);
    expect(out[0]).toMatchObject({ classification: 'orphan', branch: 'left-behind' });
    expect(out[0]?.reason).toMatch(/archived/i);
  });

  it('reclaims an archived worktree outside ~/agents too', () => {
    // Normally a worktree outside ~/agents is only ever informational, but an
    // archived task is the user telling us they are done with that one.
    const out = classify({
      scans,
      disk: [],
      knownPaths: ['/Users/m/www/worktrees/hand-made'],
      reclaimablePaths: ['/Users/m/www/worktrees/hand-made'],
      home: HOME,
    });
    const row = out.find((o) => o.path === '/Users/m/www/worktrees/hand-made');
    expect(row?.classification).toBe('orphan');
  });

  it('normalises reclaimable paths the same way as known paths', () => {
    for (const reclaimable of [
      '~/agents/albedo/left-behind',
      '/Users/m/agents/albedo/left-behind/',
      '/Users/M/Agents/Albedo/Left-Behind',
    ]) {
      const out = classify({
        scans,
        disk: [],
        knownPaths: [
          '/Users/m/agents/albedo/tracked-task',
          '/Users/m/agents/albedo/left-behind',
          '/Users/m/www/worktrees/hand-made',
        ],
        reclaimablePaths: [reclaimable],
        home: HOME,
      });
      expect(out.map((o) => o.path), reclaimable).toEqual(['/Users/m/agents/albedo/left-behind']);
    }
  });

  it('still hides a live task worktree when reclaimablePaths is empty or absent', () => {
    const known = [
      '/Users/m/agents/albedo/tracked-task',
      '/Users/m/agents/albedo/left-behind',
      '/Users/m/www/worktrees/hand-made',
    ];
    expect(classify({ scans, disk: [], knownPaths: known, home: HOME })).toEqual([]);
    expect(
      classify({ scans, disk: [], knownPaths: known, reclaimablePaths: [], home: HOME }),
    ).toEqual([]);
  });

  it('matches /tmp against /private/tmp in both directions', () => {
    const tmpScan = [
      scan(
        '/private/tmp/repo',
        'worktree /private/tmp/repo\nHEAD a\nbranch refs/heads/main\n\n' +
          'worktree /private/tmp/wt\nHEAD b\nbranch refs/heads/x\n\n',
      ),
    ];
    const out = classify({
      scans: tmpScan,
      disk: [],
      knownPaths: ['/tmp/wt'],
      home: HOME,
    });
    expect(out).toEqual([]);
  });

  it('marks a prunable worktree with git own reason', () => {
    const out = classify({
      scans: [
        scan(
          '/Users/m/www/albedo',
          'worktree /Users/m/www/albedo\nHEAD a\nbranch refs/heads/main\n\n' +
            'worktree /Users/m/agents/albedo/gone\nHEAD b\nbranch refs/heads/gone\n' +
            'prunable gitdir file points to non-existent location\n\n',
        ),
      ],
      disk: [],
      knownPaths: [],
      home: HOME,
    });
    expect(out[0]).toMatchObject({
      classification: 'orphan',
      prunable: true,
      reason: expect.stringContaining('gitdir file points to non-existent location'),
    });
  });

  it('deduplicates a worktree reported by two repos', () => {
    const out = classify({
      scans: [
        scan(
          '/Users/m/www/albedo',
          'worktree /Users/m/www/albedo\nHEAD a\n\nworktree /Users/m/agents/albedo/dup\nHEAD b\n\n',
        ),
        scan(
          '/Users/m/www/other',
          'worktree /Users/m/www/other\nHEAD a\n\nworktree /Users/m/agents/albedo/dup/\nHEAD b\n\n',
        ),
      ],
      disk: [],
      knownPaths: [],
      home: HOME,
    });
    expect(out).toHaveLength(1);
  });
});

describe('classifyOrphans -- disk candidates', () => {
  const disk = (over: Partial<DiskCandidate> & { path: string }): DiskCandidate => ({
    hasGitFile: true,
    gitdirTarget: '/Users/m/www/albedo/.git/worktrees/x',
    gitdirExists: true,
    ...over,
  });

  it('never offers a directory whose gitdir is missing -- the repo may have moved', () => {
    // A moved/renamed repo, or one on an unmounted volume, leaves every one of
    // its worktrees looking exactly like this. Each is a full working tree.
    const out = classify({
      scans: [],
      disk: [disk({ path: '/Users/m/agents/albedo/stale', gitdirExists: false })],
      knownPaths: [],
      home: HOME,
    });
    expect(out[0]).toMatchObject({
      classification: 'unknown',
      source: 'disk',
      prunable: false,
      repoPath: null,
      branch: null,
      gitdir: 'missing',
    });
    expect(out[0]?.reason).toContain('work here is intact');
    expect(out[0]?.reason).not.toMatch(/stale/i);
  });

  it('treats a gitdir the filesystem would not answer for as unchecked, not missing', () => {
    const out = classify({
      scans: [],
      disk: [disk({ path: '/Users/m/agents/albedo/vol', gitdirExists: null })],
      knownPaths: [],
      home: HOME,
    });
    expect(out[0]).toMatchObject({
      classification: 'unknown',
      prunable: false,
      repoPath: null,
      gitdir: 'unchecked',
    });
    expect(out[0]?.reason).toContain('could not check');
  });

  it('calls a live worktree of an unscanned repo unknown, not an orphan', () => {
    const out = classify({
      scans: [],
      disk: [disk({ path: '/Users/m/agents/albedo/live' })],
      knownPaths: [],
      home: HOME,
    });
    expect(out[0]).toMatchObject({
      classification: 'unknown',
      repoPath: '/Users/m/www/albedo',
    });
  });

  it('ignores a directory with no .git -- we do not offer to delete plain folders', () => {
    const out = classify({
      scans: [],
      disk: [disk({ path: '/Users/m/agents/albedo/notes', hasGitFile: false, gitdirExists: false })],
      knownPaths: [],
      home: HOME,
    });
    expect(out).toEqual([]);
  });

  it('ignores anything outside ~/agents and anything a task already claims', () => {
    const out = classify({
      scans: [],
      disk: [
        disk({ path: '/Users/m/www/worktrees/mine', gitdirExists: false }),
        disk({ path: '/Users/m/agents/albedo/claimed', gitdirExists: false }),
      ],
      knownPaths: ['~/agents/albedo/claimed'],
      home: HOME,
    });
    expect(out).toEqual([]);
  });

  it('does not double-report a path git already told us about', () => {
    const out = classify({
      scans: [
        scan(
          '/Users/m/www/albedo',
          'worktree /Users/m/www/albedo\nHEAD a\n\nworktree /Users/m/agents/albedo/both\nHEAD b\nbranch refs/heads/both\n\n',
        ),
      ],
      disk: [disk({ path: '/Users/m/agents/albedo/both', gitdirExists: false })],
      knownPaths: [],
      home: HOME,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('git');
  });

  it('sorts orphans before unknowns', () => {
    const out = classify({
      scans: [
        scan(
          '/Users/m/www/albedo',
          'worktree /Users/m/www/albedo\nHEAD a\n\nworktree /Users/m/agents/albedo/zzz-git\nHEAD b\nbranch refs/heads/zzz\n\n',
        ),
      ],
      disk: [disk({ path: '/Users/m/agents/a/aaa-live' })],
      knownPaths: [],
      home: HOME,
    });
    expect(out.map((o) => o.classification)).toEqual(['orphan', 'unknown']);
  });
});

// ---------------------------------------------------------------------------
// Worktree-root validation
// ---------------------------------------------------------------------------

describe('validateWorktreeRoot', () => {
  const opts = { repoPath: '/Users/m/www/albedo', home: HOME };
  const ok = (root: string) => validateWorktreeRoot(root, opts);
  const reasonFor = (root: string) => {
    const r = validateWorktreeRoot(root, opts);
    return r.ok ? null : r.reason;
  };

  it('accepts a sensible root and returns the resolved path', () => {
    expect(ok('/Users/m/www/worktrees')).toEqual({
      ok: true,
      path: '/Users/m/www/worktrees',
      warning: null,
    });
    expect(ok('~/agents/albedo')).toMatchObject({ ok: true, path: '/Users/m/agents/albedo' });
    expect(ok('  ~/agents/albedo/  ')).toMatchObject({ ok: true, path: '/Users/m/agents/albedo' });
  });

  it('requires an absolute path', () => {
    expect(reasonFor('agents/albedo')).toMatch(/not an absolute path/);
    expect(reasonFor('./wt')).toMatch(/not an absolute path/);
    expect(reasonFor('')).toMatch(/Choose a directory/);
    expect(reasonFor('   ')).toMatch(/Choose a directory/);
  });

  it('refuses a root inside the project repository', () => {
    // git will create this happily and the repo then contains a checkout of
    // itself -- the single most regrettable thing a user can pick here.
    expect(reasonFor('/Users/m/www/albedo')).toMatch(/repository itself/);
    expect(reasonFor('/Users/m/www/albedo/worktrees')).toMatch(/inside the project repository/);
    expect(reasonFor('~/www/albedo/.worktrees')).toMatch(/inside the project repository/);
    // A sibling directory is fine.
    expect(ok('/Users/m/www/albedo-worktrees')).toMatchObject({ ok: true });
  });

  it('refuses the filesystem root and anything too close to it', () => {
    expect(reasonFor('/')).toMatch(/filesystem root/);
    expect(reasonFor('/Users')).toMatch(/too close to the filesystem root/);
    expect(reasonFor('/opt')).toMatch(/too close to the filesystem root/);
  });

  it('refuses a home directory, including someone else\'s', () => {
    expect(reasonFor('~')).toMatch(/home directory itself/);
    expect(reasonFor('/Users/m')).toMatch(/home directory itself/);
    expect(reasonFor('/Users/someone-else')).toMatch(/looks like a home directory/);
    // One level in is exactly what we want people to pick.
    expect(ok('/Users/m/agents')).toMatchObject({ ok: true });
  });

  it('warns, but allows, a root that contains the repository', () => {
    const r = ok('/Users/m/www');
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toMatch(/contains the repository itself/);
  });

  it('tolerates a missing repoPath rather than crashing', () => {
    expect(validateWorktreeRoot('/Users/m/wt', { repoPath: '', home: HOME })).toMatchObject({
      ok: true,
    });
  });
});

describe('checkWorktreeRoot', () => {
  it('short-circuits on a pure-rule failure without touching the filesystem', async () => {
    await expect(
      checkWorktreeRoot('/', { repoPath: '/Users/m/www/albedo', home: HOME }),
    ).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Multiple project roots
// ---------------------------------------------------------------------------

describe('rootContaining', () => {
  it('finds the root a path belongs to, and ignores prefix lookalikes', () => {
    const roots = ['/Users/m/agents', '/Users/m/www/worktrees'];
    expect(rootContaining(roots, '/Users/m/www/worktrees/x')).toBe('/Users/m/www/worktrees');
    expect(rootContaining(roots, '/Users/m/agents/a/b')).toBe('/Users/m/agents');
    expect(rootContaining(roots, '/Users/m/agents-old/x')).toBeNull();
    expect(rootContaining([], '/Users/m/agents/x')).toBeNull();
  });
});

describe('classifyOrphans with project roots', () => {
  const scans = [scan('/Users/m/www/albedo', albedoPorcelain)];

  it("makes the user's own ~/www/worktrees actionable once a project points there", () => {
    // This is the whole point of the projects change: same fixture, same
    // worktree, different answer, because the user named that root.
    const out = classifyOrphans({
      scans,
      disk: [],
      worktreeRoots: ['/Users/m/www/worktrees'],
      knownPaths: [],
      home: HOME,
    });
    const handMade = out.find((o) => o.path === '/Users/m/www/worktrees/hand-made');
    expect(handMade?.classification).toBe('orphan');
    // ...and ~/agents is no longer special, so those become informational.
    expect(out.find((o) => o.path === '/Users/m/agents/albedo/left-behind')?.classification).toBe(
      'unknown',
    );
  });

  it('treats several roots as equally known', () => {
    const out = classifyOrphans({
      scans,
      disk: [],
      worktreeRoots: ['/Users/m/agents', '/Users/m/www/worktrees'],
      knownPaths: [],
      home: HOME,
    });
    expect(out.every((o) => o.classification === 'orphan')).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('expands ~ in the roots it is given', () => {
    const out = classifyOrphans({
      scans,
      disk: [],
      worktreeRoots: ['~/www/worktrees'],
      knownPaths: [],
      home: HOME,
    });
    expect(out.find((o) => o.path === '/Users/m/www/worktrees/hand-made')?.classification).toBe(
      'orphan',
    );
  });

  it('offers nothing when no project has a root', () => {
    // No roots means Albedo has no claim on anything: never a remove button.
    const out = classifyOrphans({
      scans,
      disk: [],
      worktreeRoots: [],
      knownPaths: [],
      home: HOME,
    });
    expect(out.every((o) => o.classification === 'unknown')).toBe(true);
  });

  it('ignores disk candidates outside every root', () => {
    const out = classifyOrphans({
      scans: [],
      disk: [
        { path: '/Users/m/elsewhere/x', hasGitFile: true, gitdirTarget: null, gitdirExists: false },
      ],
      worktreeRoots: ['/Users/m/agents'],
      knownPaths: [],
      home: HOME,
    });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('reclaimableTaskPaths', () => {
  const cut = (over: Partial<Parameters<typeof reclaimableTaskPaths>[0][number]> = {}) => ({
    status: 'archived',
    worktreePath: '/Users/m/agents/albedo/cut-by-albedo',
    ownsWorktree: true,
    ...over,
  });

  it('offers an archived worktree Albedo cut', () => {
    expect(reclaimableTaskPaths([cut()])).toEqual(['/Users/m/agents/albedo/cut-by-albedo']);
  });

  it('never offers an archived worktree a live task still runs in', () => {
    // Archive-only, then resume the session: the resumed task is live there.
    const resumed = cut({ status: 'idle', ownsWorktree: false, worktreePath: '/Users/m/agents/albedo/Cut-By-Albedo/' });
    expect(reclaimableTaskPaths([cut(), resumed])).toEqual([]);
  });

  it('never offers a directory Albedo did not create', () => {
    // The catastrophic case: a resumed session whose cwd is the main checkout.
    expect(
      reclaimableTaskPaths([
        cut({ worktreePath: '/Users/m/www/acme', ownsWorktree: false }),
      ]),
    ).toEqual([]);
  });

  it('does not offer it even when the resumed task is archived alongside owned ones', () => {
    const paths = reclaimableTaskPaths([
      cut(),
      cut({ worktreePath: '/Users/m/www/acme', ownsWorktree: false }),
      cut({ worktreePath: '/Users/m/www/acme-worktree/ACME-2398', ownsWorktree: false }),
    ]);
    expect(paths).toEqual(['/Users/m/agents/albedo/cut-by-albedo']);
    // A hand-made LINKED worktree is the dangerous one: git will happily remove
    // it, so the flag is the only thing protecting it.
    expect(paths).not.toContain('/Users/m/www/acme-worktree/ACME-2398');
  });

  it('only considers archived tasks', () => {
    for (const status of ['idle', 'running', 'blocked', 'done']) {
      expect(reclaimableTaskPaths([cut({ status })]), status).toEqual([]);
    }
  });

  it('treats an absent flag as owned, matching the NOT NULL DEFAULT 1 column', () => {
    expect(reclaimableTaskPaths([cut({ ownsWorktree: undefined })])).toHaveLength(1);
  });

  it('drops empty paths rather than emitting them', () => {
    expect(reclaimableTaskPaths([cut({ worktreePath: '' })])).toEqual([]);
  });
});

describe('albedoOwnsWorktree', () => {
  it('is false only for an explicit false', () => {
    expect(albedoOwnsWorktree({ worktreePath: '/a', ownsWorktree: false })).toBe(false);
    expect(albedoOwnsWorktree({ worktreePath: '/a', ownsWorktree: true })).toBe(true);
    expect(albedoOwnsWorktree({ worktreePath: '/a' })).toBe(true);
  });
});

describe('worktreeSharedWithLiveTask', () => {
  const t = (id: number, status: string, worktreePath = '/Users/m/agents/albedo/up-2398') => ({ id, status, worktreePath });

  it('is true when another live task runs in the same directory', () => {
    expect(worktreeSharedWithLiveTask(t(1, 'idle'), [t(1, 'idle'), t(2, 'running')])).toBe(true);
  });

  it('ignores the task itself, archived tasks and other directories', () => {
    expect(worktreeSharedWithLiveTask(t(1, 'idle'), [t(1, 'idle')])).toBe(false);
    expect(worktreeSharedWithLiveTask(t(1, 'idle'), [t(2, 'archived')])).toBe(false);
    expect(worktreeSharedWithLiveTask(t(1, 'idle'), [t(2, 'idle', '/Users/m/agents/albedo/other')])).toBe(false);
  });
});
