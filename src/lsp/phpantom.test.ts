import { describe, expect, it } from 'vitest';
import { changeType, CREATED, DELETED, fileUri, isPhpPath, isWatchedPath, relativeFromUri, toLocations } from './phpantom';
import { locationsAsResult } from '../ui/editor/symbolNav';

const ROOT = '/Users/me/www/wt/task-1';

describe('isPhpPath', () => {
  it('is the one gate for starting a server', () => {
    expect(isPhpPath('src/A.php')).toBe(true);
    expect(isPhpPath('src/A.PHP')).toBe(true);
    for (const p of ['src/a.ts', 'README.md', 'composer.json', 'a.php.bak', 'phpunit.xml']) expect(isPhpPath(p)).toBe(false);
  });
});

describe('URIs', () => {
  it('round-trips a path with spaces and non-ASCII', () => {
    const abs = `${ROOT}/src/Dir With Space/Café.php`;
    expect(fileUri(abs)).toBe('file:///Users/me/www/wt/task-1/src/Dir%20With%20Space/Caf%C3%A9.php');
    expect(relativeFromUri(ROOT, fileUri(abs))).toBe('src/Dir With Space/Café.php');
  });

  it('rejects a location outside the worktree, including a sibling with a common prefix', () => {
    expect(relativeFromUri(ROOT, 'file:///Users/me/www/wt/task-10/src/A.php')).toBeNull();
    expect(relativeFromUri(ROOT, 'file:///elsewhere/A.php')).toBeNull();
  });
});

describe('isWatchedPath', () => {
  it('forwards PHP and composer files only, never vendor or .git', () => {
    expect(isWatchedPath(ROOT, `${ROOT}/src/A.php`)).toBe(true);
    expect(isWatchedPath(ROOT, `${ROOT}/composer.json`)).toBe(true);
    expect(isWatchedPath(ROOT, `${ROOT}/.phpantom.toml`)).toBe(true);
    expect(isWatchedPath(ROOT, `${ROOT}/vendor/x/A.php`)).toBe(false);
    expect(isWatchedPath(ROOT, `${ROOT}/lib/vendor/A.php`)).toBe(false);
    expect(isWatchedPath(ROOT, `${ROOT}/.git/index`)).toBe(false);
    expect(isWatchedPath(ROOT, `${ROOT}/src/a.ts`)).toBe(false);
    expect(isWatchedPath(ROOT, `${ROOT}-other/A.php`)).toBe(false);
  });
});

describe('changeType', () => {
  it('reports an existing file as CREATED, a missing one as DELETED', () => {
    // CHANGED would be ignored for a new file the server never parsed.
    expect(changeType(true)).toBe(CREATED);
    expect(changeType(false)).toBe(DELETED);
  });
});

describe('toLocations', () => {
  it('reads Location, Location[] and LocationLink[], 1-based, inside the worktree only', () => {
    const loc = (p: string, line: number) => ({ uri: fileUri(`${ROOT}/${p}`), range: { start: { line, character: 0 } } });
    expect(toLocations(ROOT, loc('a.php', 0))).toEqual([{ path: 'a.php', line: 1 }]);
    expect(toLocations(ROOT, [loc('a.php', 4), { uri: 'file:///outside/b.php', range: { start: { line: 1 } } }])).toEqual([
      { path: 'a.php', line: 5 },
    ]);
    expect(
      toLocations(ROOT, [{ targetUri: fileUri(`${ROOT}/c.php`), targetSelectionRange: { start: { line: 9 } }, targetRange: { start: { line: 7 } } }]),
    ).toEqual([{ path: 'c.php', line: 10 }]);
    expect(toLocations(ROOT, null)).toEqual([]);
  });
});

describe('locationsAsResult', () => {
  it('shows each line from disk with the name marked, sorted and de-duplicated', async () => {
    const files: Record<string, string> = {
      [`${ROOT}/b.php`]: 'x\nnew Foo(); $foo = Foo::class;',
      [`${ROOT}/a.php`]: 'use App\\Foo;',
    };
    const r = await locationsAsResult(
      ROOT,
      [
        { path: 'b.php', line: 2 },
        { path: 'a.php', line: 1 },
        { path: 'b.php', line: 2 },
        { path: 'gone.php', line: 3 },
      ],
      'Foo',
      async (p) => {
        if (!(p in files)) throw new Error('missing');
        return files[p]!;
      },
    );
    expect(r.groups.map((g) => g.path)).toEqual(['a.php', 'b.php', 'gone.php']);
    expect(r.count).toBe(3);
    const b = r.groups[1]!.matches[0]!;
    // `$foo` is a variable, not the class.
    expect(b.ranges.map(([s, e]) => b.text.slice(s, e))).toEqual(['Foo', 'Foo']);
    expect(r.groups[2]!.matches[0]).toMatchObject({ text: '', ranges: [] });
  });
});
