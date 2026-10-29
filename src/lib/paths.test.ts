/**
 * Containment is the point of this module, so the bulk of what follows is
 * escape attempts. Two probes are exercised:
 *
 *  - a `fs.realpath`-backed probe running against a real temporary directory,
 *    which is the only way to show that a *string* check is not enough; and
 *  - the default Tauri probe, with `@tauri-apps/plugin-fs` mocked, to pin down
 *    its fail-closed behaviour on symlinked components.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { lstatMock, invokeMock } = vi.hoisted(() => ({ lstatMock: vi.fn(), invokeMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: lstatMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { parsePathRef, resolveInWorktree, setWorktreeProbe } from './paths';
import type { WorktreeProbe } from './paths';

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * What a POSIX `realpath` would do, and what the Rust `canonicalize_path`
 * command does: resolve the deepest existing ancestor and re-attach the
 * segments that do not exist yet, so a file the agent mentioned before creating
 * it still resolves.
 */
const nodeProbe: WorktreeProbe = async (absolutePath) => {
  const tail: string[] = [];
  let cursor = absolutePath;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return tail.length === 0 ? real : `${real}/${[...tail].reverse().join('/')}`;
    } catch {
      const slash = cursor.lastIndexOf('/');
      if (slash <= 0) return null;
      tail.push(cursor.slice(slash + 1));
      cursor = cursor.slice(0, slash);
    }
  }
};

/** Lexical only -- what the module would do if layer 2 did not exist. */
const stringOnlyProbe: WorktreeProbe = async (absolutePath) => absolutePath;

// ---------------------------------------------------------------------------
// Fixture worktree
// ---------------------------------------------------------------------------

let root = '';
let outside = '';

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'albedo-paths-')));
  root = join(base, 'worktree');
  outside = join(base, 'outside');

  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, 'src', 'Foo.php'), '<?php\n');
  await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'export {};\n');
  await writeFile(join(outside, 'secret.txt'), 'top secret\n');

  // A symlink that stays inside, and two that leave.
  await symlink(join(root, 'src', 'Foo.php'), join(root, 'inside-link.php'));
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  await symlink(outside, join(root, 'src', 'escape-dir'));

  // …and a symlinked worktree root, the `~/agents on another volume` case.
  await symlink(root, join(base, 'wt-link'));
});

afterAll(async () => {
  if (root) await rm(join(root, '..'), { recursive: true, force: true });
});

beforeEach(() => {
  setWorktreeProbe(nodeProbe);
  lstatMock.mockReset();
  invokeMock.mockReset();
});

afterEach(() => {
  setWorktreeProbe(null);
});

// ---------------------------------------------------------------------------
// resolveInWorktree — the happy path
// ---------------------------------------------------------------------------

describe('resolveInWorktree: paths that belong to the worktree', () => {
  it('resolves a relative path against the task checkout', async () => {
    await expect(resolveInWorktree(root, 'src/Foo.php')).resolves.toEqual({
      absolute: join(root, 'src', 'Foo.php'),
      relative: 'src/Foo.php',
    });
  });

  it('resolves an absolute path inside the worktree to itself', async () => {
    const abs = join(root, 'src', 'nested', 'deep.ts');
    await expect(resolveInWorktree(root, abs)).resolves.toEqual({
      absolute: abs,
      relative: 'src/nested/deep.ts',
    });
  });

  it('accepts a file that does not exist yet', async () => {
    await expect(resolveInWorktree(root, 'src/NotYet.php')).resolves.toEqual({
      absolute: join(root, 'src', 'NotYet.php'),
      relative: 'src/NotYet.php',
    });
  });

  it('strips `./` and collapses interior `.` segments', async () => {
    const expected = { absolute: join(root, 'src', 'Foo.php'), relative: 'src/Foo.php' };
    await expect(resolveInWorktree(root, './src/Foo.php')).resolves.toEqual(expected);
    await expect(resolveInWorktree(root, 'src/./Foo.php')).resolves.toEqual(expected);
    await expect(resolveInWorktree(root, 'src//Foo.php')).resolves.toEqual(expected);
  });

  it('allows `..` that stays inside the worktree', async () => {
    await expect(resolveInWorktree(root, 'src/nested/../Foo.php')).resolves.toEqual({
      absolute: join(root, 'src', 'Foo.php'),
      relative: 'src/Foo.php',
    });
  });

  it('tolerates a trailing slash on the worktree root', async () => {
    await expect(resolveInWorktree(`${root}/`, 'src/Foo.php')).resolves.toEqual({
      absolute: join(root, 'src', 'Foo.php'),
      relative: 'src/Foo.php',
    });
  });

  it('follows a symlink that stays inside the worktree', async () => {
    await expect(resolveInWorktree(root, 'inside-link.php')).resolves.toEqual({
      absolute: join(root, 'src', 'Foo.php'),
      relative: 'src/Foo.php',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveInWorktree — traversal
// ---------------------------------------------------------------------------

describe('resolveInWorktree: `..` traversal', () => {
  const traversals = [
    '../outside/secret.txt',
    '../../etc/passwd',
    'src/../../outside/secret.txt',
    'src/nested/../../../outside/secret.txt',
    '..',
    '../',
    './../outside/secret.txt',
    'src/./../../outside/secret.txt',
    // Repeated / doubled-up separators around the traversal.
    'src//..//..//outside//secret.txt',
    '....//....//outside/secret.txt'.replace('....//....//', '../../'),
    'a/b/c/../../../../outside/secret.txt',
  ];

  for (const raw of traversals) {
    it(`rejects ${JSON.stringify(raw)}`, async () => {
      await expect(resolveInWorktree(root, raw)).resolves.toBeNull();
    });
  }

  it('rejects percent-encoded traversal without ever decoding it', async () => {
    for (const raw of [
      '..%2f..%2foutside/secret.txt',
      '%2e%2e/%2e%2e/outside/secret.txt',
      'src/%2E%2E/%2E%2E/outside/secret.txt',
      'src%2fsecret.txt',
      'src/..%5c..%5coutside',
    ]) {
      await expect(resolveInWorktree(root, raw)).resolves.toBeNull();
    }
  });

  it('treats a literal `....` segment as a filename, not traversal', async () => {
    // Not an escape: it is a (silly) directory name that normalises to itself.
    const r = await resolveInWorktree(root, '..../x.ts');
    expect(r).toEqual({ absolute: join(root, '....', 'x.ts'), relative: '..../x.ts' });
  });
});

// ---------------------------------------------------------------------------
// resolveInWorktree — absolute paths and other shapes
// ---------------------------------------------------------------------------

describe('resolveInWorktree: paths that are not ours', () => {
  it('rejects an absolute path outside the worktree', async () => {
    await expect(resolveInWorktree(root, '/etc/passwd')).resolves.toBeNull();
    await expect(resolveInWorktree(root, join(outside, 'secret.txt'))).resolves.toBeNull();
  });

  it('rejects a sibling directory that merely shares the root prefix', async () => {
    // `/…/worktree-evil` must not count as inside `/…/worktree`.
    await expect(resolveInWorktree(root, `${root}-evil/x.ts`)).resolves.toBeNull();
  });

  it('rejects the worktree root itself — there is no file to open there', async () => {
    await expect(resolveInWorktree(root, root)).resolves.toBeNull();
    await expect(resolveInWorktree(root, '.')).resolves.toBeNull();
    await expect(resolveInWorktree(root, '')).resolves.toBeNull();
  });

  it('rejects Windows paths, URLs, `~` and NUL', async () => {
    for (const raw of [
      'C:\\Windows\\system32\\drivers\\etc\\hosts',
      'C:/Windows/system32',
      '\\\\server\\share\\x.ts',
      'src\\Foo.php',
      'https://example.com/a.ts',
      'file:///etc/passwd',
      '~/.ssh/id_rsa',
      'src/Foo\0.php',
    ]) {
      await expect(resolveInWorktree(root, raw)).resolves.toBeNull();
    }
  });

  it('rejects a non-absolute or empty worktree root', async () => {
    await expect(resolveInWorktree('relative/root', 'src/Foo.php')).resolves.toBeNull();
    await expect(resolveInWorktree('', 'src/Foo.php')).resolves.toBeNull();
    await expect(resolveInWorktree('/', 'src/Foo.php')).resolves.toBeNull();
  });

  it('rejects an absurdly long path', async () => {
    await expect(resolveInWorktree(root, `src/${'a'.repeat(5000)}.ts`)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The part a string check cannot do
// ---------------------------------------------------------------------------

describe('resolveInWorktree: symlinks leaving the worktree', () => {
  it('rejects a symlinked file whose target is outside', async () => {
    await expect(resolveInWorktree(root, 'escape.txt')).resolves.toBeNull();
  });

  it('rejects a path through a symlinked directory whose target is outside', async () => {
    await expect(resolveInWorktree(root, 'src/escape-dir/secret.txt')).resolves.toBeNull();
  });

  it('demonstrates that a string-only check is not sufficient', async () => {
    // Same input, same normalisation. With physical resolution switched off the
    // escape sails through and points at a file outside the checkout; with it
    // on, the path is refused. This is the whole reason layer 2 exists.
    setWorktreeProbe(stringOnlyProbe);
    const naive = await resolveInWorktree(root, 'src/escape-dir/secret.txt');
    expect(naive).not.toBeNull();
    expect(naive?.absolute).toBe(join(root, 'src', 'escape-dir', 'secret.txt'));
    expect(await realpath(naive!.absolute)).toBe(join(outside, 'secret.txt'));

    setWorktreeProbe(nodeProbe);
    await expect(resolveInWorktree(root, 'src/escape-dir/secret.txt')).resolves.toBeNull();
  });

  it('rejects when the probe cannot determine a real location', async () => {
    setWorktreeProbe(async () => null);
    await expect(resolveInWorktree(root, 'src/Foo.php')).resolves.toBeNull();
  });

  it('rejects when the probe returns a location outside the worktree', async () => {
    // Belt and braces: the module re-checks containment on whatever comes back,
    // so a buggy or compromised probe still cannot hand out an escape.
    setWorktreeProbe(async () => '/etc/passwd');
    await expect(resolveInWorktree(root, 'src/Foo.php')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The default (Tauri) probe
// ---------------------------------------------------------------------------

describe('a symlinked worktree root', () => {
  it('is canonicalised, so containment still works through it', async () => {
    // `~/agents` on a real machine may be a symlink to another volume. The root
    // is resolved once and every comparison is made against the canonical form.
    const viaLink = join(root, '..', 'wt-link');
    await expect(resolveInWorktree(viaLink, 'src/Foo.php')).resolves.toEqual({
      absolute: join(root, 'src', 'Foo.php'),
      relative: 'src/Foo.php',
    });
    await expect(resolveInWorktree(viaLink, '../outside/secret.txt')).resolves.toBeNull();
    await expect(resolveInWorktree(viaLink, 'escape.txt')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The default probe: `canonicalize_path`, and the degraded fallback
// ---------------------------------------------------------------------------

const WT = '/home/u/agents/repo/slug';

/** An `invoke` that canonicalises according to a symlink map. */
function fakeCanonicalize(links: Record<string, string> = {}, missing: string[] = []) {
  return async (cmd: string, args?: { path?: string }) => {
    if (cmd !== 'canonicalize_path') throw new Error(`unexpected command ${cmd}`);
    const p = args?.path ?? '';
    // `canonicalize` fails for the named path and anything beneath it, which is
    // what `std::fs::canonicalize` does for a missing or unresolvable component.
    if (missing.some((m) => p === m || p.startsWith(`${m}/`))) {
      throw new Error(`cannot resolve ${p}: No such file or directory`);
    }
    for (const [from, to] of Object.entries(links)) {
      if (p === from) return to;
      if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
    }
    return p;
  };
}

describe('the default probe, with canonicalize_path available', () => {
  beforeEach(() => setWorktreeProbe(null));

  it('follows an in-tree symlink to its target and accepts it', async () => {
    // The real case: `frontend/app/node_modules/usg-lib` -> `packages/usg-lib`.
    invokeMock.mockImplementation(
      fakeCanonicalize({ [`${WT}/app/node_modules/usg-lib`]: `${WT}/packages/usg-lib` }),
    );

    await expect(
      resolveInWorktree(WT, 'app/node_modules/usg-lib/src/index.ts'),
    ).resolves.toEqual({
      absolute: `${WT}/packages/usg-lib/src/index.ts`,
      relative: 'packages/usg-lib/src/index.ts',
    });
  });

  it('rejects a symlink whose target leaves the worktree', async () => {
    invokeMock.mockImplementation(fakeCanonicalize({ [`${WT}/vendor`]: '/opt/shared' }));
    await expect(resolveInWorktree(WT, 'vendor/lib/Thing.php')).resolves.toBeNull();
  });

  it('opens a file that does not exist yet, by resolving its nearest ancestor', async () => {
    // The editor must be able to open a path the agent named before creating
    // it; that buffer starts empty and Cmd+S creates the file.
    invokeMock.mockImplementation(fakeCanonicalize({}, [`${WT}/src/NotYet.php`]));
    lstatMock.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveInWorktree(WT, 'src/NotYet.php')).resolves.toEqual({
      absolute: `${WT}/src/NotYet.php`,
      relative: 'src/NotYet.php',
    });
  });

  it('resolves the ancestor through a symlink before re-attaching the new name', async () => {
    invokeMock.mockImplementation(
      fakeCanonicalize({ [`${WT}/app`]: `${WT}/packages/app` }, [`${WT}/app/src/New.ts`]),
    );
    lstatMock.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveInWorktree(WT, 'app/src/New.ts')).resolves.toEqual({
      absolute: `${WT}/packages/app/src/New.ts`,
      relative: 'packages/app/src/New.ts',
    });
  });

  it('fails closed when a component exists but will not canonicalise', async () => {
    // A dangling symlink, or an unreadable parent. We cannot say where it
    // points, so we must not skip over it and write through it later.
    invokeMock.mockImplementation(fakeCanonicalize({}, [`${WT}/src/dangling`]));
    // `x.ts` is genuinely absent, so the walk-up would normally skip it -- but
    // `dangling` is *there* and still would not resolve, which is where it has
    // to stop. Skipping it would re-attach `dangling/x.ts` to the worktree and
    // a later save would write straight through the link.
    lstatMock.mockImplementation(async (p: string) => {
      if (p === `${WT}/src/dangling/x.ts`) throw new Error('ENOENT');
      return { isSymlink: true };
    });

    await expect(resolveInWorktree(WT, 'src/dangling/x.ts')).resolves.toBeNull();
    expect(lstatMock).toHaveBeenCalledWith(`${WT}/src/dangling`);
  });

  it('re-checks containment on whatever the command returns', async () => {
    // Belt and braces: a command that lies is still not allowed to hand out an
    // escape, because the decision is made here and not in Rust.
    invokeMock.mockImplementation(fakeCanonicalize({ [`${WT}/src`]: '/etc' }));
    await expect(resolveInWorktree(WT, 'src/passwd')).resolves.toBeNull();
  });

  it('asks whether the command exists only once per session', async () => {
    invokeMock.mockImplementation(fakeCanonicalize());
    await resolveInWorktree(WT, 'src/a.ts');
    await resolveInWorktree(WT, 'src/b.ts');
    const probes = invokeMock.mock.calls.filter((c) => (c[1] as { path: string }).path === '/');
    expect(probes).toHaveLength(1);
  });

  it('never reaches the host for a lexically hostile path', async () => {
    await expect(resolveInWorktree(WT, '../../../etc/passwd')).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(lstatMock).not.toHaveBeenCalled();
  });
});

describe('the degraded fallback, without canonicalize_path', () => {
  beforeEach(() => {
    setWorktreeProbe(null);
    // An older binary: the command is not registered, so every invoke rejects.
    invokeMock.mockRejectedValue(new Error('Command canonicalize_path not found'));
  });

  it('lstats every component below the root and accepts when none is a link', async () => {
    lstatMock.mockResolvedValue({ isSymlink: false });

    await expect(resolveInWorktree(WT, 'src/nested/deep.ts')).resolves.toEqual({
      absolute: `${WT}/src/nested/deep.ts`,
      relative: 'src/nested/deep.ts',
    });
    expect(lstatMock.mock.calls.map((c) => c[0])).toEqual([
      `${WT}/src`,
      `${WT}/src/nested`,
      `${WT}/src/nested/deep.ts`,
    ]);
  });

  it('refuses a symlinked component rather than allowing it', async () => {
    // Degrading to "refuses symlinks" is correct. Degrading to "allows
    // anything" would not be.
    lstatMock.mockImplementation(async (p: string) =>
      p === `${WT}/src/link` ? { isSymlink: true } : { isSymlink: false },
    );
    await expect(resolveInWorktree(WT, 'src/link/x.ts')).resolves.toBeNull();
  });

  it('stops walking at the first component that does not exist', async () => {
    lstatMock.mockImplementation(async (p: string) => {
      if (p === `${WT}/src`) return { isSymlink: false };
      throw new Error('ENOENT');
    });

    await expect(resolveInWorktree(WT, 'src/New.php')).resolves.toEqual({
      absolute: `${WT}/src/New.php`,
      relative: 'src/New.php',
    });
  });

  it('takes the worktree root as given, since Albedo created it', async () => {
    lstatMock.mockResolvedValue({ isSymlink: false });
    const r = await resolveInWorktree(WT, 'src/a.ts');
    expect(r?.relative).toBe('src/a.ts');
    // The root is never lstat-walked -- only what came from the transcript is.
    expect(lstatMock.mock.calls.every((c) => String(c[0]).startsWith(`${WT}/`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parsePathRef
// ---------------------------------------------------------------------------

describe('parsePathRef: forms we recognise', () => {
  const cases: Array<[string, { path: string; line: number | null }]> = [
    ['src/Foo.php:42', { path: 'src/Foo.php', line: 42 }],
    ['src/Foo.php:42:7', { path: 'src/Foo.php', line: 42 }],
    ['    at renderRow (src/ui/Row.tsx:118:23)', { path: 'src/ui/Row.tsx', line: 118 }],
    ['at /Users/m/agents/app/src/index.ts:9', { path: '/Users/m/agents/app/src/index.ts', line: 9 }],
    ['File "src/app.py", line 42, in <module>', { path: 'src/app.py', line: 42 }],
    ["File 'src/app.py', line 7", { path: 'src/app.py', line: 7 }],
    ['#0 /app/src/Service.php(88): App\\Service->run()', { path: '/app/src/Service.php', line: 88 }],
    [
      'PHP Fatal error: Uncaught TypeError in /var/www/src/Foo.php on line 120',
      { path: '/var/www/src/Foo.php', line: 120 },
    ],
    ['Edited src/lib/diff.ts', { path: 'src/lib/diff.ts', line: null }],
    ['see src/lib/diff.ts.', { path: 'src/lib/diff.ts', line: null }],
    ['(src/lib/diff.ts)', { path: 'src/lib/diff.ts', line: null }],
    ['`src/lib/diff.ts`', { path: 'src/lib/diff.ts', line: null }],
    ['src/Foo.php:42.', { path: 'src/Foo.php', line: 42 }],
    ['README.md:3', { path: 'README.md', line: 3 }],
    ['wrote .github/workflows/ci.yml', { path: '.github/workflows/ci.yml', line: null }],
    // grep -C separates a context line from its number with `-`, not `:`.
    ['config/services/services.yaml-12-    foo: bar', { path: 'config/services/services.yaml', line: 12 }],
    ['src/Security/UserRole.php-89-', { path: 'src/Security/UserRole.php', line: 89 }],
    ['src/App.tsx-1-import React from "react";', { path: 'src/App.tsx', line: 1 }],
    // Greedy: the last viable split wins, so a hyphenated filename survives.
    ['src/a-1-b.ts-5-content', { path: 'src/a-1-b.ts', line: 5 }],
    ['src/Security/UserRole.php:90:    return $x;', { path: 'src/Security/UserRole.php', line: 90 }],
    // Extension-less, but explicitly rooted or explicitly relative.
    ['tail /var/log/syslog', { path: '/var/log/syslog', line: null }],
    ['ran ./bin/console', { path: './bin/console', line: null }],
  ];

  for (const [text, expected] of cases) {
    it(`parses ${JSON.stringify(text)}`, () => {
      expect(parsePathRef(text)).toEqual(expected);
    });
  }

  it('returns the first reference when a line holds several', () => {
    expect(parsePathRef('moved src/a.ts to src/b.ts')).toEqual({ path: 'src/a.ts', line: null });
  });

  it('prefers the richer form when two patterns start at the same place', () => {
    expect(parsePathRef('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 });
  });
});

describe('parsePathRef: things that are not paths', () => {
  const rejects = [
    '',
    'nothing to see here',
    'the build failed',
    // Clock times and version numbers.
    'started at 10:30',
    'took 1:02:03',
    'bumped to v1.2.3',
    'shiki 1.24.2',
    // Prose with a colon.
    'note: 42 rows affected',
    'TODO: 17',
    'Warning: 3 files changed',
    // Hosts and ports.
    'listening on localhost:3000',
    'connect to example.com:5432',
    'redis.io:6379',
    // URLs.
    'https://example.com/src/Foo.php:42',
    'http://localhost:1420/src/main.tsx:3:1',
    'see https://github.com/o/r/blob/main/src/a.ts',
    'file:///etc/passwd',
    // Windows.
    'C:\\Users\\dev\\app\\src\\Foo.php',
    'C:/Users/dev/app/src/Foo.php:12',
    'D:\\build\\out.log:9',
    // Bare words that happen to have dots.
    'node.js is installed',
    'run npm.cmd',
  ];

  for (const text of rejects) {
    it(`returns null for ${JSON.stringify(text)}`, () => {
      expect(parsePathRef(text)).toBeNull();
    });
  }

  it('rejects an implausible line number outright', () => {
    // Line zero is not a line. The shape says "path reference" and the number
    // says we did not understand it, so the honest answer is no reference --
    // not a half-recovered link to the file.
    expect(parsePathRef('src/a.ts:0')).toBeNull();
    expect(parsePathRef('src/a.ts:9999999')).toBeNull();
  });

  it('does not mistake a hyphenated filename for a grep context line', () => {
    // `src/my` has no extension, so the `-2-` split is refused and the whole
    // name stays one path.
    expect(parsePathRef('src/my-2-thing.ts')).toEqual({ path: 'src/my-2-thing.ts', line: null });
    expect(parsePathRef('logs/2024-01-15-report.txt')).toEqual({
      path: 'logs/2024-01-15-report.txt',
      line: null,
    });
    // Mid-line it is not grep output, and the token does not end in an
    // extension either, so nothing is claimed. Conservative, as intended.
    expect(parsePathRef('see src/App.tsx-1-import')).toBeNull();
  });

  it('still finds a later reference when an earlier one is vetoed', () => {
    expect(parsePathRef('src/a.ts:0 but see src/b.ts:5')).toEqual({
      path: 'src/b.ts',
      line: 5,
    });
  });

  it('does not treat a fragment of a URL path as a file reference', () => {
    // Every candidate inside the URL is preceded by `/` or `:`, so none of them
    // begins at a token boundary.
    expect(parsePathRef('fetch https://cdn.example.com/assets/app.js')).toBeNull();
  });
});

/**
 * Regression suite from the measurement over 60k real transcript lines: 17.2%
 * of hits were false positives and every one had the same signature -- an
 * extension-less bare `a/b` with no line number. These are the actual strings.
 */
describe('parsePathRef: extension-less `a/b` is not a file reference', () => {
  const offenders = [
    // Progress counters.
    'Processing 1/2',
    'step 2/2 complete',
    'passed 3/4 checks',
    'retry 1/1',
    // Git refs.
    'rebased onto origin/master',
    'pushed origin/ACME-2269',
    'merge origin/main into HEAD',
    // Prose with a slash.
    'blocked on I/O',
    'and/or',
    'export as CSV/PDF',
    'compare before/after',
    'the Request/Response cycle',
    // npm specifiers and MCP method names.
    'import { PostHogProvider } from posthog-js/react',
    'calls tools/list then server/discover',
    // Directories: correct to drop, this is a click-to-open-a-file affordance.
    'cleared var/cache',
    'look in src/lib',
  ];

  for (const text of offenders) {
    it(`returns null for ${JSON.stringify(text)}`, () => {
      expect(parsePathRef(text)).toBeNull();
    });
  }

  it('still links the same shapes once they carry a line number', () => {
    // The corroborating `:42` is what the narrower patterns rely on, and they
    // were measured clean -- so the tightening applies to bare paths only.
    expect(parsePathRef('var/cache:42')).toEqual({ path: 'var/cache', line: 42 });
  });

});

describe('parsePathRef: composes with resolveInWorktree', () => {
  it('hands a path the resolver accepts', async () => {
    const ref = parsePathRef('  at Foo.bar (src/Foo.php:12:4)');
    expect(ref).toEqual({ path: 'src/Foo.php', line: 12 });
    await expect(resolveInWorktree(root, ref!.path)).resolves.toEqual({
      absolute: join(root, 'src', 'Foo.php'),
      relative: 'src/Foo.php',
    });
  });

  it('hands an escaping path that the resolver then refuses', async () => {
    const ref = parsePathRef('at ../../outside/secret.txt:1');
    expect(ref?.path).toBe('../../outside/secret.txt');
    await expect(resolveInWorktree(root, ref!.path)).resolves.toBeNull();
  });
});

describe('bareFileRef', () => {
  it('takes a file name with a known extension, and its line', async () => {
    const { bareFileRef } = await import('./paths');
    expect(bareFileRef('RemoteMessageFactory.php')).toEqual({ path: 'RemoteMessageFactory.php', line: null });
    expect(bareFileRef('plan-v5-pr2.md')).toEqual({ path: 'plan-v5-pr2.md', line: null });
    expect(bareFileRef('Consumer.php:170')).toEqual({ path: 'Consumer.php', line: 170 });
    expect(bareFileRef('Consumer.php:170:4')).toEqual({ path: 'Consumer.php', line: 170 });
  });

  it('leaves calls and properties alone', async () => {
    const { bareFileRef } = await import('./paths');
    for (const t of ['JSON.parse', 'window.open', 'console.log', 'e.preventDefault', 'v1.2', 'src/a.ts', 'a b.php']) {
      expect(bareFileRef(t)).toBeNull();
    }
  });
});

