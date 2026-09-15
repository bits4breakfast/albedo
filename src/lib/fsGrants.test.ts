/**
 * Runtime fs-scope grants.
 *
 * The bug this exists for shipped once: the static capability scope covered
 * `~/agents`, configurable worktree roots were built on top of it, and the
 * scope was never widened — so no file in any project outside `~/agents` could
 * be opened, which was most of them.
 *
 * The two cases below marked against LIVE DATA were found by running the path
 * set against the user's actual projects and tasks, not by imagining inputs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  missing: new Set<string>(),
  denied: new Set<string>(),
  home: '/Users/matteo',
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: { path: string }) => {
    state.calls.push(args.path);
    if (state.missing.has(args.path)) {
      throw new Error(`cannot resolve ${args.path}: No such file or directory (os error 2)`);
    }
    if (state.denied.has(args.path)) throw new Error(`could not grant ${args.path}: permission denied`);
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(async () => state.home),
}));

import { grantDir, grantProjectDirs, resetGrants } from './fsGrants';

beforeEach(() => {
  resetGrants();
  state.calls = [];
  state.missing = new Set();
  state.denied = new Set();
  state.home = '/Users/matteo';
});

afterEach(() => vi.clearAllMocks());

describe('grantProjectDirs — which directories get granted', () => {
  it('covers repo roots, worktree roots and task worktrees', async () => {
    const denied = await grantProjectDirs({
      repoPaths: ['/Users/matteo/www/upsellguru'],
      worktreeRoots: ['/Users/matteo/www/upsellguru-worktree'],
      worktreePaths: ['/Users/matteo/www/upsellguru-UP-2368'],
    });
    expect(state.calls).toEqual([
      '/Users/matteo/www/upsellguru',
      '/Users/matteo/www/upsellguru-worktree',
      '/Users/matteo/www/upsellguru-UP-2368',
    ]);
    expect(denied).toEqual([]);
  });

  it('covers the directory from the actual bug report', async () => {
    // "Could not read .../upsellguru-UP-2368/src/.../AuditLogRepository.php"
    await grantProjectDirs({ worktreePaths: ['/Users/matteo/www/upsellguru-UP-2368'] });
    expect(state.calls).toContain('/Users/matteo/www/upsellguru-UP-2368');
  });

  it('LIVE DATA: expands a leading ~, which the Rust side would refuse', async () => {
    // One of the user's two real projects has worktreeRoot `~/agents/...`,
    // stored by the pre-projects backfill. Sent raw it is a relative path.
    await grantProjectDirs({ worktreeRoots: ['~/agents/upsellguru-UP-2368'] });
    expect(state.calls).toEqual(['/Users/matteo/agents/upsellguru-UP-2368']);
    expect(state.calls.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('expands a bare ~ too', async () => {
    await grantProjectDirs({ repoPaths: ['~'] });
    expect(state.calls).toEqual(['/Users/matteo']);
  });

  it('skips blanks and nulls without calling out', async () => {
    const denied = await grantProjectDirs({
      repoPaths: [null, undefined, '   ', ''],
      worktreeRoots: [],
    });
    expect(state.calls).toEqual([]);
    expect(denied).toEqual([]);
  });

  it('de-duplicates, including across trailing slashes', async () => {
    await grantProjectDirs({
      repoPaths: ['/Users/matteo/www/upsellguru', '/Users/matteo/www/upsellguru/'],
      worktreePaths: ['/Users/matteo/www/upsellguru'],
    });
    expect(state.calls).toEqual(['/Users/matteo/www/upsellguru']);
  });
});

describe('a directory that does not exist yet', () => {
  it('LIVE DATA: is not a failure — a worktree root is created on demand', async () => {
    // Two of the user's five real directories are in this state. Reporting it
    // would put an error banner over two perfectly healthy projects.
    state.missing.add('/Users/matteo/www/upsellguru-worktree');
    const denied = await grantProjectDirs({
      repoPaths: ['/Users/matteo/www/upsellguru'],
      worktreeRoots: ['/Users/matteo/www/upsellguru-worktree'],
    });
    expect(denied).toEqual([]);
  });

  it('is granted once it appears', async () => {
    state.missing.add('/wt');
    await grantProjectDirs({ worktreeRoots: ['/wt'] });
    state.calls = [];

    state.missing.clear();
    await grantProjectDirs({ worktreeRoots: ['/wt'] });
    expect(state.calls).toEqual(['/wt']); // retried, not memoised as done
  });

  it('still reports a REAL failure', async () => {
    state.denied.add('/locked');
    const denied = await grantProjectDirs({ repoPaths: ['/locked'] });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toContain('/locked');
    expect(denied[0]).toContain('permission denied');
  });

  it('keeps granting the rest after one failure', async () => {
    state.denied.add('/locked');
    const denied = await grantProjectDirs({ repoPaths: ['/locked', '/fine'] });
    expect(state.calls).toEqual(['/locked', '/fine']);
    expect(denied).toHaveLength(1);
  });
});

describe('idempotence', () => {
  it('does not re-send a directory granted earlier this run', async () => {
    await grantProjectDirs({ repoPaths: ['/a'], worktreeRoots: ['/b'] });
    state.calls = [];

    await grantProjectDirs({ repoPaths: ['/a'], worktreeRoots: ['/b'] });
    expect(state.calls).toEqual([]);
  });

  it('grants a project added mid-session without a relaunch', async () => {
    await grantProjectDirs({ repoPaths: ['/a'] });
    state.calls = [];

    await grantProjectDirs({ repoPaths: ['/a', '/added'] });
    expect(state.calls).toEqual(['/added']);
  });

  it('retries a denied directory on the next call', async () => {
    state.denied.add('/flaky');
    await grantProjectDirs({ repoPaths: ['/flaky'] });
    state.calls = [];

    state.denied.clear();
    const denied = await grantProjectDirs({ repoPaths: ['/flaky'] });
    expect(state.calls).toEqual(['/flaky']);
    expect(denied).toEqual([]);
  });
});

describe('degraded host', () => {
  it('still grants absolute paths when homeDir fails', async () => {
    const { homeDir } = await import('@tauri-apps/api/path');
    vi.mocked(homeDir).mockRejectedValueOnce(new Error('no home'));
    const denied = await grantProjectDirs({ repoPaths: ['/Users/matteo/www/upsellguru'] });
    expect(state.calls).toEqual(['/Users/matteo/www/upsellguru']);
    expect(denied).toEqual([]);
  });

  it('grantDir alone works without a home, for absolute paths', async () => {
    expect(await grantDir('/abs/path')).toBeNull();
    expect(state.calls).toEqual(['/abs/path']);
  });
});
