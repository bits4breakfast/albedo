import { describe, expect, it } from 'vitest';
import {
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
} from './reconcile';
import { parseWorktreePorcelain } from './worktree';

const HOME = '/Users/m';

function scan(repoPath: string, porcelain: string): RepoScan {
  return { repoPath, worktrees: parseWorktreePorcelain(porcelain) };
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
    const out = classifyOrphans({
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
    const out = classifyOrphans({ scans, disk: [], knownPaths: [], home: HOME });
    const handMade = out.find((o) => o.path === '/Users/m/www/worktrees/hand-made');
    expect(handMade?.classification).toBe('unknown');
    expect(out.filter((o) => o.classification === 'orphan').map((o) => o.path)).toEqual([
      '/Users/m/agents/albedo/left-behind',
      '/Users/m/agents/albedo/tracked-task',
    ]);
  });

  it('never reports the main worktree, even when no task claims the repo', () => {
    const out = classifyOrphans({ scans, disk: [], knownPaths: [], home: HOME });
    expect(out.map((o) => o.path)).not.toContain('/Users/m/www/albedo');
  });

  it('skips bare repositories', () => {
    const out = classifyOrphans({
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
      const out = classifyOrphans({
        scans,
        disk: [],
        knownPaths: [known, '/Users/m/agents/albedo/tracked-task'],
        home: HOME,
      });
      expect(out.filter((o) => o.classification === 'orphan'), known).toEqual([]);
    }
  });

  it('matches /tmp against /private/tmp in both directions', () => {
    const tmpScan = [
      scan(
        '/private/tmp/repo',
        'worktree /private/tmp/repo\nHEAD a\nbranch refs/heads/main\n\n' +
          'worktree /private/tmp/wt\nHEAD b\nbranch refs/heads/x\n\n',
      ),
    ];
    const out = classifyOrphans({
      scans: tmpScan,
      disk: [],
      knownPaths: ['/tmp/wt'],
      home: HOME,
    });
    expect(out).toEqual([]);
  });

  it('marks a prunable worktree with git own reason', () => {
    const out = classifyOrphans({
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
    const out = classifyOrphans({
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

  it('flags a stale directory whose gitdir has gone as an orphan', () => {
    const out = classifyOrphans({
      scans: [],
      disk: [disk({ path: '/Users/m/agents/albedo/stale', gitdirExists: false })],
      knownPaths: [],
      home: HOME,
    });
    expect(out[0]).toMatchObject({
      classification: 'orphan',
      source: 'disk',
      prunable: true,
      branch: null,
    });
    expect(out[0]?.reason).toContain('no longer exists');
  });

  it('calls a live worktree of an unscanned repo unknown, not an orphan', () => {
    const out = classifyOrphans({
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
    const out = classifyOrphans({
      scans: [],
      disk: [disk({ path: '/Users/m/agents/albedo/notes', hasGitFile: false, gitdirExists: false })],
      knownPaths: [],
      home: HOME,
    });
    expect(out).toEqual([]);
  });

  it('ignores anything outside ~/agents and anything a task already claims', () => {
    const out = classifyOrphans({
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
    const out = classifyOrphans({
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
    const out = classifyOrphans({
      scans: [],
      disk: [
        disk({ path: '/Users/m/agents/a/zzz-live' }),
        disk({ path: '/Users/m/agents/a/aaa-stale', gitdirExists: false }),
      ],
      knownPaths: [],
      home: HOME,
    });
    expect(out.map((o) => o.classification)).toEqual(['orphan', 'unknown']);
  });
});
