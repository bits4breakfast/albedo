import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInfo, githubRepoUrl, gitRunner, parseHistory, splitSubject, type GitRunner } from './buildEmbed';

const NOW = new Date('2026-10-30T09:00:00Z');

describe('splitSubject', () => {
  it('takes the trailing PR number off a squash subject', () => {
    expect(splitSubject('Outbox: hold messages during a running turn (#71)')).toEqual({
      subject: 'Outbox: hold messages during a running turn',
      pr: 71,
    });
  });

  it('takes only the last number: issue #57 merged as PR #68', () => {
    expect(splitSubject('Editor header: one row, the file named once (#57) (#68)')).toEqual({
      subject: 'Editor header: one row, the file named once (#57)',
      pr: 68,
    });
  });

  it('leaves a direct commit, and a number mid-subject, alone', () => {
    expect(splitSubject('Initial commit')).toEqual({ subject: 'Initial commit', pr: null });
    expect(splitSubject('Revert (#12) because of x')).toEqual({ subject: 'Revert (#12) because of x', pr: null });
    expect(splitSubject('(#5)')).toEqual({ subject: '(#5)', pr: null });
  });
});

describe('parseHistory', () => {
  it('reads unit- and record-separated log output, newest first', () => {
    const raw = 'abc1234\x1fFirst (#2)\x1e\ndef5678\x1fSecond line | with pipes; and "quotes"\x1e\n';
    expect(parseHistory(raw)).toEqual([
      { sha: 'abc1234', subject: 'First', pr: 2 },
      { sha: 'def5678', subject: 'Second line | with pipes; and "quotes"', pr: null },
    ]);
  });

  it('skips what is not a record', () => {
    expect(parseHistory('')).toEqual([]);
    expect(parseHistory('warning: something\x1e\nnot-a-sha\x1fx\x1e')).toEqual([]);
  });
});

describe('githubRepoUrl', () => {
  it('normalises every form of a GitHub remote', () => {
    for (const remote of [
      'git@github.com:bits4breakfast/albedo.git',
      'git@github.com:bits4breakfast/albedo',
      'ssh://git@github.com/bits4breakfast/albedo.git',
      'https://github.com/bits4breakfast/albedo.git',
      'https://github.com/bits4breakfast/albedo/',
      'https://token@github.com/bits4breakfast/albedo.git\n',
    ]) {
      expect(githubRepoUrl(remote)).toBe('https://github.com/bits4breakfast/albedo');
    }
  });

  it('is null for anything else', () => {
    expect(githubRepoUrl('git@gitlab.com:o/r.git')).toBeNull();
    expect(githubRepoUrl('https://github.com.evil.example/o/r')).toBeNull();
    expect(githubRepoUrl('/srv/git/albedo.git')).toBeNull();
    expect(githubRepoUrl('')).toBeNull();
  });
});

describe('buildInfo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is null, not a thrown error, when git is not installed', () => {
    expect(buildInfo(gitRunner(undefined, '/nonexistent/albedo-test/git'), NOW)).toBeNull();
  });

  it('is null outside a git checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'albedo-build-'));
    dirs.push(dir);
    expect(buildInfo(gitRunner(dir), NOW)).toBeNull();
  });

  it('keeps the commit when only the history or the remote cannot be read', () => {
    const git: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return 'abc1234';
      if (args[0] === 'status') return ' M src/x.ts';
      throw new Error(`${args[0]} failed`);
    };
    expect(buildInfo(git, NOW)).toEqual({
      sha: 'abc1234',
      dirty: true,
      at: '2026-10-30T09:00:00.000Z',
      repo: null,
      history: [],
    });
  });

  it('embeds this checkout: HEAD first in its history (a shallow clone has just one)', () => {
    const info = buildInfo(gitRunner(), NOW);
    expect(info).not.toBeNull();
    expect(info!.history!.length).toBeGreaterThanOrEqual(1);
    expect(info!.history!.length).toBeLessThanOrEqual(300);
    expect(info!.history![0]!.sha).toBe(info!.sha);
  });
});
