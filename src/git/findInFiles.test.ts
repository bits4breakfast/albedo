import { afterEach, describe, expect, it } from 'vitest';
import {
  displayLine,
  FIND_CAP,
  findArgs,
  FindError,
  groupHits,
  highlighter,
  matchRanges,
  runFind,
  splitRuns,
} from './findInFiles';
import { grepFlavour } from './codeIndex';
import { setGitRunner, type GitRunner } from './worktree';

const FIXED = { regex: false, matchCase: false };

describe('findArgs', () => {
  it('is fixed-string and case-insensitive by default, untracked included', () => {
    expect(findArgs('foo(', FIXED)).toEqual([
      'grep', '-n', '-z', '-I', '--no-color', '--untracked', '-F', '-i', '-e', 'foo(', '--',
    ]);
  });

  it('uses the regex engine and drops -i when asked', () => {
    const args = findArgs('a.+b', { regex: true, matchCase: true }, '-E');
    expect(args).toContain('-E');
    expect(args).not.toContain('-F');
    expect(args).not.toContain('-i');
  });

  it('never lets a query be read as a flag', () => {
    const args = findArgs('--exec', FIXED);
    expect(args[args.indexOf('--exec') - 1]).toBe('-e');
  });
});

describe('highlighter and matchRanges', () => {
  it('escapes fixed strings', () => {
    expect(matchRanges('call foo(1); foo(2)', highlighter('foo(', FIXED))).toEqual([
      [5, 9],
      [13, 17],
    ]);
  });

  it('honours case', () => {
    expect(matchRanges('Foo foo', highlighter('foo', { regex: false, matchCase: true }))).toEqual([[4, 7]]);
    expect(matchRanges('Foo foo', highlighter('foo', FIXED))).toHaveLength(2);
  });

  it('returns null for a pattern JS cannot compile, and no ranges', () => {
    const re = highlighter('(?<!x', { regex: true, matchCase: false });
    expect(re).toBeNull();
    expect(matchRanges('anything', re)).toEqual([]);
  });

  it('skips empty matches without looping', () => {
    expect(matchRanges('baab', highlighter('a*', { regex: true, matchCase: false }))).toEqual([[1, 3]]);
  });
});

describe('groupHits', () => {
  const hit = (path: string, line: number, text = 'x foo y') => ({ path, line, text });

  it('groups by file in order, locating matches', () => {
    const r = groupHits([hit('a.ts', 1), hit('a.ts', 9), hit('b.ts', 3)], 'foo', FIXED);
    expect(r.capped).toBe(false);
    expect(r.count).toBe(3);
    expect(r.groups.map((g) => [g.path, g.matches.map((m) => m.line)])).toEqual([
      ['a.ts', [1, 9]],
      ['b.ts', [3]],
    ]);
    expect(r.groups[0]!.matches[0]!.ranges).toEqual([[2, 5]]);
  });

  it('caps and says so', () => {
    const hits = Array.from({ length: FIND_CAP + 5 }, (_, i) => hit(`f${i % 3}.ts`, i + 1));
    const r = groupHits(hits, 'foo', FIXED);
    expect(r.count).toBe(FIND_CAP);
    expect(r.capped).toBe(true);
    expect(r.groups.reduce((n, g) => n + g.matches.length, 0)).toBe(FIND_CAP);
  });

  it('is not capped at exactly the cap', () => {
    const hits = Array.from({ length: 3 }, (_, i) => hit('a.ts', i + 1));
    expect(groupHits(hits, 'foo', FIXED, 3).capped).toBe(false);
  });
});

describe('displayLine', () => {
  it('drops indentation and shifts ranges', () => {
    expect(displayLine({ text: '    return foo;', ranges: [[11, 14]] })).toEqual({ text: 'return foo;', ranges: [[7, 10]] });
  });

  it('windows a long line around the first match', () => {
    const text = 'x'.repeat(1000) + 'NEEDLE' + 'y'.repeat(1000);
    const out = displayLine({ text, ranges: [[1000, 1006]] });
    expect(out.text.startsWith('…')).toBe(true);
    expect(out.text.endsWith('…')).toBe(true);
    const [a, b] = out.ranges[0]!;
    expect(out.text.slice(a, b)).toBe('NEEDLE');
  });
});

describe('splitRuns', () => {
  it('alternates plain and hit runs', () => {
    expect(splitRuns('a foo b foo', [[2, 5], [8, 11]])).toEqual([
      { text: 'a ', hit: false },
      { text: 'foo', hit: true },
      { text: ' b ', hit: false },
      { text: 'foo', hit: true },
    ]);
  });

  it('is one plain run with no ranges', () => {
    expect(splitRuns('plain', [])).toEqual([{ text: 'plain', hit: false }]);
  });
});

describe('runFind', () => {
  let restore: GitRunner | null = null;
  afterEach(() => {
    if (restore) setGitRunner(restore);
    restore = null;
  });

  it('parses -z output into groups', async () => {
    const calls: string[][] = [];
    restore = setGitRunner(async (args) => {
      calls.push(args);
      return { code: 0, stdout: 'src/a.ts\x003\x00const foo = 1\nsrc/b:1:c.ts\x007\x00foo()\n', stderr: '' };
    });
    const r = await runFind('/w', 'foo', FIXED);
    expect(calls[0]).toContain('-F');
    expect(r.groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/b:1:c.ts']);
    expect(r.groups[1]!.matches[0]).toMatchObject({ line: 7, ranges: [[0, 3]] });
  });

  it('treats exit 1 as no matches', async () => {
    restore = setGitRunner(async () => ({ code: 1, stdout: '', stderr: '' }));
    expect(await runFind('/w', 'zzz', FIXED)).toEqual({ groups: [], count: 0, capped: false });
  });

  it('reports an invalid pattern without downgrading the engine', async () => {
    const calls: string[][] = [];
    restore = setGitRunner(async (args) => {
      calls.push(args);
      return { code: 128, stdout: '', stderr: "fatal: command line, '(': missing closing parenthesis\n" };
    });
    await expect(runFind('/w', '(', { regex: true, matchCase: false })).rejects.toThrow(FindError);
    expect(calls).toHaveLength(1);
    expect(grepFlavour()).toBe('-P');
  });

  it('falls back to ERE once when git has no PCRE', async () => {
    const calls: string[][] = [];
    restore = setGitRunner(async (args) => {
      calls.push(args);
      if (args.includes('-P'))
        return { code: 128, stdout: '', stderr: 'fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE\n' };
      return { code: 0, stdout: 'a.ts\x001\x00foo\n', stderr: '' };
    });
    const r = await runFind('/w', 'fo+', { regex: true, matchCase: false });
    expect(r.count).toBe(1);
    expect(calls.map((a) => a.includes('-E'))).toEqual([false, true]);
    expect(grepFlavour()).toBe('-E');
  });
});
