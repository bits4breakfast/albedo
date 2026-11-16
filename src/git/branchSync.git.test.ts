/**
 * The branch sync's one-per-repo read against real git (#365 review): every
 * worktree must be named exactly as `symbolic-ref --short HEAD` names it in
 * that folder -- the per-task read it replaces -- including branches that
 * share a name with a tag or a remote, where that read says `heads/x`.
 * Otherwise the stored branch would flip between the two spellings.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', async () => ({ ...(await vi.importActual('../db')), updateTask: async () => {} }));

import { checkedOutBranch, checkedOutBranches } from './branchSync';
import { setGitRunner, type GitRunner } from './worktree';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

let root = '';
let restore: GitRunner | null = null;

afterEach(() => {
  if (restore) setGitRunner(restore);
  restore = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('checkedOutBranches against real git (#365)', () => {
  it('names each worktree exactly as symbolic-ref --short does, ambiguous names included', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'branch-sync-')));
    const repo = join(root, 'repo');
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: ENV });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
    sh('commit', '-q', '--allow-empty', '-m', 'a');
    for (const b of ['tagged', 'remoted', 'plain', 'toplevel', 'deep/x']) sh('branch', b);
    sh('tag', 'tagged'); // a tag and a branch named alike: `heads/tagged`
    sh('update-ref', 'refs/remotes/remoted/HEAD', 'HEAD'); // a remote's HEAD
    sh('update-ref', 'refs/toplevel', 'HEAD'); // refs/<name>
    sh('update-ref', 'refs/remotes/deep/x', 'HEAD');
    const folders: Record<string, string> = { main: repo };
    for (const b of ['tagged', 'remoted', 'plain', 'toplevel', 'deep/x']) {
      folders[b] = join(root, `w-${b.replace('/', '_')}`);
      sh('worktree', 'add', '-q', folders[b]!, b);
    }
    folders['detached'] = join(root, 'w-detached');
    sh('worktree', 'add', '-q', '--detach', folders['detached']!);

    restore = setGitRunner(async (args, cwd) => {
      try {
        return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }), stderr: '' };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    });

    const known = await checkedOutBranches(repo);
    expect(known).not.toBeNull();
    for (const folder of Object.values(folders)) {
      expect(known!.has(folder)).toBe(true);
      expect(known!.get(folder)).toBe(await checkedOutBranch(folder));
    }
    expect(known!.get(folders['tagged']!)).toBe('heads/tagged');
    expect(known!.get(folders['plain']!)).toBe('plain');
    expect(known!.get(folders['detached']!)).toBeNull();
  });
});
