/**
 * Test fixture (#352): a real "GitHub" repository with a pull request ref, a
 * local clone of it, and a review copy checked out from the PR the way
 * openReview.ts makes one -- `review/<n>` fetched from `refs/pull/<n>/head`,
 * in a worktree of its own. Temp folders only; never a real review worktree.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
}

/** The app's git runner, on the real git, without the user's config. */
export function realGit(): GitRunner {
  return setGitRunner(async (args, cwd) => {
    try {
      const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  });
}

export interface ReviewRepo {
  root: string;
  /** The repository on "GitHub". */
  up: string;
  /** The local clone, the project. */
  local: string;
  /** The review copy: a worktree of `local` on `review/1`. */
  copy: string;
  /** Commit on the PR's branch upstream and point `refs/pull/1/head` at it. */
  pushToPr: (path: string, text: string, message: string) => string;
  /** Rewrite the PR: its branch from main again, with these files, force-pushed. */
  forcePushPr: (files: Record<string, string>, message: string) => string;
  /** Commit on main upstream. */
  pushToMain: (path: string, text: string, message: string) => string;
  head: (cwd: string) => string;
  read: (path: string) => string;
  write: (path: string, text: string) => void;
  cleanup: () => void;
}

export function makeReviewRepo(): ReviewRepo {
  const root = mkdtempSync(join(tmpdir(), 'review-update-'));
  const up = join(root, 'up');
  const local = join(root, 'local');
  const copy = join(root, 'review-1');
  execFileSync('git', ['init', '-q', '-b', 'main', up], { env: ENV });
  const commit = (path: string, text: string, message: string) => {
    writeFileSync(join(up, path), text);
    sh(up, 'add', path);
    sh(up, 'commit', '-q', '-m', message);
    return sh(up, 'rev-parse', 'HEAD').trim();
  };
  commit('a.txt', 'a1\na2\na3\n', 'base');
  commit('b.txt', 'b1\n', 'base two');
  sh(up, 'checkout', '-q', '-b', 'feature');
  commit('a.txt', 'a1\nA2\na3\n', 'Change a');
  sh(up, 'update-ref', 'refs/pull/1/head', 'feature');
  sh(up, 'checkout', '-q', 'main');
  execFileSync('git', ['clone', '-q', up, local], { env: ENV });
  sh(local, 'fetch', '-q', '--no-tags', 'origin', '+refs/pull/1/head:refs/heads/review/1');
  sh(local, 'worktree', 'add', '-q', copy, 'review/1');

  const onFeature = <T,>(fn: () => T): T => {
    sh(up, 'checkout', '-q', 'feature');
    try {
      return fn();
    } finally {
      sh(up, 'update-ref', 'refs/pull/1/head', 'feature');
      sh(up, 'checkout', '-q', 'main');
    }
  };
  return {
    root,
    up,
    local,
    copy,
    pushToPr: (path, text, message) => onFeature(() => commit(path, text, message)),
    forcePushPr: (files, message) =>
      onFeature(() => {
        sh(up, 'reset', '-q', '--hard', 'main');
        for (const [p, t] of Object.entries(files)) {
          writeFileSync(join(up, p), t);
          sh(up, 'add', p);
        }
        sh(up, 'commit', '-q', '-m', message);
        return sh(up, 'rev-parse', 'HEAD').trim();
      }),
    pushToMain: (path, text, message) => commit(path, text, message),
    head: (cwd) => sh(cwd, 'rev-parse', 'HEAD').trim(),
    read: (path) => readFileSync(join(copy, path), 'utf8'),
    write: (path, text) => writeFileSync(join(copy, path), text),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
