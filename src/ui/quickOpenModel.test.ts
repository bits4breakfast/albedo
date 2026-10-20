import { describe, expect, it } from 'vitest';
import type { CodeIndex } from '../git/codeIndex';
import { parseQuery, prepareIndex, search, worktreeRelative } from './quickOpenModel';

const index: CodeIndex = {
  root: '/w',
  builtAt: 0,
  took: 0,
  files: [
    'src/ui/Terminal.tsx',
    'src/terminal/index.ts',
    'tests/McpParameterRestrictionTest.php',
    'src/Domain/UserService.php',
    'README.md',
  ],
  symbols: [
    { name: 'McpParameterRestrictionTest', kind: 'class', path: 'tests/McpParameterRestrictionTest.php', line: 9 },
    { name: 'mapReport', kind: 'method', path: 'src/Reports.php', line: 40 },
    { name: 'UserService', kind: 'class', path: 'src/Domain/UserService.php', line: 7 },
    { name: 'find', kind: 'method', path: 'src/Domain/UserService.php', line: 20 },
    { name: 'save', kind: 'method', path: 'src/Domain/UserService.php', line: 12 },
    { name: 'finder', kind: 'function', path: 'src/lib/find.ts', line: 3 },
    { name: 'Props', kind: 'type', path: 'src/ui/Terminal.tsx', line: 5 },
  ],
};
const p = prepareIndex(index);

describe('parseQuery', () => {
  it('splits a trailing :line', () => {
    expect(parseQuery('Foo.php:120')).toEqual({ text: 'Foo.php', line: 120 });
    expect(parseQuery('Foo.php')).toEqual({ text: 'Foo.php', line: null });
    expect(parseQuery(':12')).toEqual({ text: ':12', line: null });
    expect(parseQuery('a:b')).toEqual({ text: 'a:b', line: null });
    expect(parseQuery('x:0')).toEqual({ text: 'x', line: null });
  });
});

describe('worktreeRelative', () => {
  it('strips the root from absolute paths and ./ from relative ones', () => {
    expect(worktreeRelative('/w/', '/w/src/a.ts')).toBe('src/a.ts');
    expect(worktreeRelative('/w', './src/a.ts')).toBe('src/a.ts');
    expect(worktreeRelative('/w', 'src/a.ts')).toBe('src/a.ts');
    expect(worktreeRelative('/w', '/elsewhere/a.ts')).toBeNull();
    expect(worktreeRelative('/w', '/wx/a.ts')).toBeNull();
  });
});

describe('search', () => {
  it('file mode ranks basename hits first and splits the highlight', () => {
    const r = search(p, 'file', 'term', null);
    expect(r.items.slice(0, 2).map((i) => i.file)).toEqual(['src/ui/Terminal.tsx', 'src/terminal/index.ts']);
    const [first, second] = r.items;
    expect(first).toMatchObject({ kind: 'file', name: 'Terminal.tsx', path: 'src/ui', nameHits: [0, 1, 2, 3] });
    expect(second!.pathHits).toEqual([4, 5, 6, 7]);
  });

  it('file mode carries a :line through to the item', () => {
    expect(search(p, 'file', 'readme:3', null).items[0]).toMatchObject({ file: 'README.md', line: 3 });
  });

  it('class mode lists only type kinds, CamelCase first', () => {
    const r = search(p, 'class', 'mprt', null);
    expect(r.items.map((i) => i.name)).toEqual(['McpParameterRestrictionTest']);
    expect(search(p, 'symbol', 'mprt', null).items[0]!.name).toBe('McpParameterRestrictionTest');
  });

  it('symbol mode puts the open file first', () => {
    const r = search(p, 'symbol', 'find', 'src/Domain/UserService.php');
    expect(r.items[0]).toMatchObject({ name: 'find', current: true });
    const elsewhere = search(p, 'symbol', 'find', 'src/other.php');
    expect(elsewhere.items.every((i) => !i.current)).toBe(true);
  });

  it('an empty query shows the open file outline in line order', () => {
    const r = search(p, 'symbol', '', 'src/Domain/UserService.php');
    expect(r.items.map((i) => i.name)).toEqual(['UserService', 'save', 'find']);
    expect(search(p, 'class', '', 'src/Domain/UserService.php').items.map((i) => i.name)).toEqual(['UserService']);
    expect(search(p, 'file', '', 'src/Domain/UserService.php').items).toEqual([]);
    expect(search(p, 'symbol', '', null).items).toEqual([]);
  });

  it('all mode mixes files and symbols, a class ahead of its own file on a tie', () => {
    const r = search(p, 'all', 'UserService', null);
    expect(r.items.slice(0, 2).map((i) => i.kind)).toEqual(['class', 'file']);
  });

  it('caps the rendered list but reports the total', () => {
    const r = search(p, 'symbol', 'e', null, 2);
    expect(r.items).toHaveLength(2);
    expect(r.total).toBeGreaterThan(2);
  });
});
