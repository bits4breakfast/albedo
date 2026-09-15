/**
 * Runtime fs-scope grants.
 *
 * The bug this exists to prevent shipped once already: the static capability
 * scope covered `~/agents`, configurable worktree roots were built on top of
 * it, and the scope was never widened — so no file in any project outside
 * `~/agents` could be opened, which was most of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  fail: new Set<string>(),
  missing: new Set<string>(),
  home: '/Users/x',
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: { path: string }) => {
    state.calls.push(args.path);
    if (state.missing.has(args.path)) {
      throw new Error(`cannot resolve ${args.path}: No such file or directory (os error 2)`);
    }
    if (state.fail.has(args.path)) throw new Error(`could not grant ${args.path}: permission denied`);
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(async () => state.home),
}));

import {
  describeGrantFailures,
  grantProjectAccess,
  projectAccessPaths,
  resetProjectAccess,
} from './projectAccess';
import type { Project, Task } from '../types';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'acme',
    repoPath: '/Users/x/www/acme',
    worktreeRoot: '/Users/x/www/worktrees',
    defaultBaseBranch: null,
    taskPromptTemplate: null,
    createdAt: 1,
    archivedAt: null,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 't',
    projectId: 1,
    repoPath: '/Users/x/www/acme',
    baseBranch: 'main',
    branch: 'b',
    worktreePath: '/Users/x/www/acme-ACME-2368',
    sessionId: null,
    ownsWorktree: true,
    status: 'idle',
    createdAt: 1,
    lastActivityAt: null,
    ...over,
  };
}

beforeEach(() => {
  resetProjectAccess();
  state.calls = [];
  state.fail = new Set();
  state.missing = new Set();
  state.home = '/Users/x';
});

afterEach(() => vi.clearAllMocks());

describe('projectAccessPaths — which directories need granting', () => {
  it('covers repoPath, worktreeRoot and worktreePath', () => {
    const paths = projectAccessPaths([project()], [task()], '/Users/x');
    expect(paths).toEqual([
      '/Users/x/www/acme',
      '/Users/x/www/worktrees',
      '/Users/x/www/acme-ACME-2368',
    ]);
  });

  it('includes a task whose worktree is outside its project root', () => {
    // The exact case from the report: the worktree is a sibling of the repo,
    // under neither the project's worktreeRoot nor the static scope.
    const paths = projectAccessPaths(
      [project({ worktreeRoot: '/Users/x/agents/acme' })],
      [task({ worktreePath: '/Users/x/www/acme-ACME-2368' })],
      '/Users/x',
    );
    expect(paths).toContain('/Users/x/www/acme-ACME-2368');
  });

  it('EXPANDS a leading ~ — the Rust side refuses relative paths', () => {
    // `~/agents/<repo>` is what the pre-projects backfill stores as a default,
    // so this is the common case, not an edge one.
    const paths = projectAccessPaths(
      [project({ worktreeRoot: '~/agents/acme' })],
      [],
      '/Users/x',
    );
    expect(paths).toContain('/Users/x/agents/acme');
    expect(paths.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('de-duplicates, including across trailing slashes', () => {
    const paths = projectAccessPaths(
      [project(), project({ id: 2, repoPath: '/Users/x/www/acme/' })],
      [task({ worktreePath: '/Users/x/www/acme' })],
      '/Users/x',
    );
    expect(paths.filter((p) => p === '/Users/x/www/acme')).toHaveLength(1);
  });

  it('drops blanks and anything still relative after expansion', () => {
    const paths = projectAccessPaths(
      [project({ repoPath: '   ', worktreeRoot: 'relative/path' })],
      [task({ worktreePath: '' })],
      '/Users/x',
    );
    expect(paths).toEqual([]);
  });

  it('is pure — no host needed', () => {
    projectAccessPaths([project()], [task()], '/Users/x');
    expect(state.calls).toEqual([]);
  });
});

describe('grantProjectAccess', () => {
  it('grants every directory exactly once', async () => {
    const report = await grantProjectAccess([project()], [task()]);
    expect(state.calls).toEqual([
      '/Users/x/www/acme',
      '/Users/x/www/worktrees',
      '/Users/x/www/acme-ACME-2368',
    ]);
    expect(report.granted).toHaveLength(3);
    expect(report.failed).toEqual([]);
  });

  it('does not re-send a directory already granted this process', async () => {
    await grantProjectAccess([project()], [task()]);
    state.calls = [];

    // what happens on every onProjectsChanged
    const again = await grantProjectAccess([project()], [task()]);
    expect(state.calls).toEqual([]);
    expect(again.granted).toEqual([]);
    expect(again.skipped).toBe(3);
  });

  it('grants a project added mid-session without a relaunch', async () => {
    await grantProjectAccess([project()], []);
    state.calls = [];

    const added = project({ id: 2, repoPath: '/Users/x/www/newrepo', worktreeRoot: '/Users/x/wt2' });
    const report = await grantProjectAccess([project(), added], []);
    expect(state.calls).toEqual(['/Users/x/www/newrepo', '/Users/x/wt2']);
    expect(report.granted).toHaveLength(2);
  });

  it('collects failures without throwing, and keeps granting the rest', async () => {
    state.fail.add('/Users/x/www/worktrees');
    const report = await grantProjectAccess([project()], [task()]);

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.path).toBe('/Users/x/www/worktrees');
    // the directories after the failure were still attempted
    expect(report.granted).toContain('/Users/x/www/acme-ACME-2368');
  });

  it('RETRIES a failure on the next call — only successes are remembered', async () => {
    state.fail.add('/Users/x/www/worktrees');
    await grantProjectAccess([project()], []);
    state.calls = [];

    state.fail.clear(); // the directory reappears
    const report = await grantProjectAccess([project()], []);
    expect(state.calls).toEqual(['/Users/x/www/worktrees']);
    expect(report.granted).toEqual(['/Users/x/www/worktrees']);
  });

  it('still grants absolute paths when homeDir is unavailable', async () => {
    const { homeDir } = await import('@tauri-apps/api/path');
    vi.mocked(homeDir).mockRejectedValueOnce(new Error('no home'));
    const report = await grantProjectAccess([project()], []);
    expect(report.granted).toContain('/Users/x/www/acme');
  });

  it('does nothing with nothing to grant', async () => {
    const report = await grantProjectAccess([], []);
    expect(state.calls).toEqual([]);
    expect(report).toEqual({ granted: [], failed: [], skipped: 0, pending: [] });
  });
});

describe('a worktree root that does not exist yet', () => {
  it('is PENDING, not a failure — the root is created on demand', async () => {
    // Verified against the user's real rows: two of their five directories are
    // in this state, so treating it as an error would put a banner over two
    // perfectly healthy projects on first launch.
    state.missing.add('/Users/x/www/worktrees');
    const report = await grantProjectAccess([project()], [task()]);

    expect(report.pending).toEqual(['/Users/x/www/worktrees']);
    expect(report.failed).toEqual([]);
    expect(describeGrantFailures(report)).toBeNull();
  });

  it('is granted once the directory appears', async () => {
    state.missing.add('/Users/x/www/worktrees');
    await grantProjectAccess([project()], []);
    state.calls = [];

    state.missing.clear(); // the worktree root gets created
    const report = await grantProjectAccess([project()], []);
    expect(state.calls).toContain('/Users/x/www/worktrees');
    expect(report.granted).toContain('/Users/x/www/worktrees');
  });

  it('still reports a real failure as a failure', async () => {
    state.fail.add('/Users/x/www/worktrees');
    const report = await grantProjectAccess([project()], []);
    expect(report.pending).toEqual([]);
    expect(report.failed[0]?.error).toContain('permission denied');
    expect(describeGrantFailures(report)).not.toBeNull();
  });
});

describe('describeGrantFailures', () => {
  it('is null when everything worked', () => {
    expect(describeGrantFailures({ granted: ['/a'], failed: [], skipped: 0, pending: [] })).toBeNull();
  });

  it('names the directory and the underlying error', () => {
    const msg = describeGrantFailures({
      granted: [],
      failed: [{ path: '/Users/x/gone', error: 'permission denied' }],
      skipped: 0,
      pending: [],
    });
    expect(msg).toContain('/Users/x/gone');
    expect(msg).toContain('permission denied');
    expect(msg).toContain('cannot be opened');
  });

  it('counts the rest rather than listing them all', () => {
    const msg = describeGrantFailures({
      granted: [],
      failed: [
        { path: '/a', error: 'x' },
        { path: '/b', error: 'y' },
        { path: '/c', error: 'z' },
      ],
      skipped: 0,
      pending: [],
    });
    expect(msg).toContain('/a');
    expect(msg).toContain('and 2 more');
  });
});
