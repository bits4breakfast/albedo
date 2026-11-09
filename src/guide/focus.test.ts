import { describe, expect, it } from 'vitest';
import {
  asFocus,
  DEFAULT_CAREFUL,
  DEFAULT_SET_ASIDE,
  firstMatch,
  globToRegExp,
  isSetAside,
  matchGlob,
  MAX_PATTERNS,
  parsePatterns,
  patternsFromJson,
  projectFocus,
} from './focus';

describe('matchGlob (#295)', () => {
  it.each([
    ['*.css', 'style.css', true],
    ['*.css', 'src/ui/guide.css', true],
    ['*.css', 'src/ui/guide.css.map', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/ui/a.ts', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/ui/x/a.ts', true],
    ['**/*.test.*', 'a.test.ts', true],
    ['**/*.test.*', 'src/guide/focus.test.ts', true],
    ['**/*.test.*', 'src/guide/test.ts', false],
    ['**/__tests__/**', 'src/__tests__/a.ts', true],
    ['**/__tests__/**', '__tests__/deep/b.js', true],
    ['**/migrations/**', 'src/db/migrations/0014_guide_focus.sql', true],
    ['**/migrations/**', 'src/db/migrations.ts', false],
    ['*.{css,scss,less}', 'a/b.scss', true],
    ['*.{css,scss,less}', 'a/b.sass', false],
    ['*.min.{js,css}', 'vendor/x.min.js', true],
    ['?.ts', 'a.ts', true],
    ['?.ts', 'ab.ts', false],
    ['package.json', 'package.json', true],
    ['package.json', 'apps/web/package.json', true],
    ['package.json', 'package.json5', false],
    ['/package.json', 'package.json', true],
    ['./src/*.ts', 'src/a.ts', true],
    ['.github/workflows/**', '.github/workflows/ci.yml', true],
    ['.github/workflows/**', 'x/.github/workflows/ci.yml', false],
    ['*schema.sql', 'src/db/schema.sql', true],
    ['a+b(c).ts', 'a+b(c).ts', true],
    ['a+b(c).ts', 'aab(c).ts', false],
    ['{a,b', '{a,b', true],
  ])('%s against %s: %s', (pattern, path, want) => {
    expect(matchGlob(pattern, path)).toBe(want);
  });

  it('an empty pattern matches nothing', () => {
    expect(globToRegExp('   ')).toBeNull();
    expect(matchGlob('', 'a.ts')).toBe(false);
  });

  it('firstMatch names the first pattern that matches', () => {
    expect(firstMatch(['*.md', 'src/**', '*.ts'], 'src/a.ts')).toBe('src/**');
    expect(firstMatch(['*.md'], 'src/a.ts')).toBeNull();
  });
});

describe('the lists', () => {
  it('parse one per line, dropping blanks, comments and repeats, capped', () => {
    expect(parsePatterns('  *.css \n\n# tests\n*.css\n**/*.test.*\n')).toEqual(['*.css', '**/*.test.*']);
    const many = Array.from({ length: MAX_PATTERNS + 5 }, (_, i) => `f${i}`).join('\n');
    expect(parsePatterns(many)).toHaveLength(MAX_PATTERNS);
    expect(parsePatterns(`${'x'.repeat(201)}\nok`)).toEqual(['ok']);
  });

  it('read back from a column: a JSON array of strings, else null', () => {
    expect(patternsFromJson('["*.css"," *.snap "]')).toEqual(['*.css', '*.snap']);
    expect(patternsFromJson('[]')).toEqual([]);
    expect(patternsFromJson(null)).toBeNull();
    expect(patternsFromJson('{"a":1}')).toBeNull();
    expect(patternsFromJson('[1]')).toBeNull();
    expect(patternsFromJson('not json')).toBeNull();
  });

  it('a project with no lists of its own uses Albedo’s; [] is none', () => {
    expect(projectFocus(null)).toEqual({ setAside: [...DEFAULT_SET_ASIDE], careful: [...DEFAULT_CAREFUL] });
    expect(projectFocus({ guideSetAside: [], guideCareful: null })).toEqual({ setAside: [], careful: [...DEFAULT_CAREFUL] });
  });

  it('a stored focus of the wrong shape is none', () => {
    expect(asFocus({ setAside: ['*.css'], careful: [] })).toEqual({ setAside: ['*.css'], careful: [] });
    expect(asFocus({ setAside: '*.css', careful: [] })).toBeUndefined();
    expect(asFocus(undefined)).toBeUndefined();
  });
});

describe('isSetAside, with Albedo’s starting set', () => {
  const focus = projectFocus(null);
  it.each([
    ['src/guide/focus.test.ts', true],
    ['src/ui/guide.css', true],
    ['Cargo.lock', true],
    ['package-lock.json', true],
    ['src/__snapshots__/a.snap', true],
    ['src/guide/focus.ts', false],
    ['src/db/migrations/0014_guide_focus.sql', false],
    // Careful wins: a flagged file is never set aside.
    ['src/db/migrations/0014.test.sql', false],
    ['package.json', false],
  ])('%s: %s', (path, want) => {
    expect(isSetAside(focus, path)).toBe(want);
  });
});
