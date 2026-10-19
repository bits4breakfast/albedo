import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findPhpUsages,
  findWord,
  parsePhpHeader,
  parseUseLine,
  phpTargetAt,
  referencesOn,
  resolveClassName,
} from './phpRefs';
import { setGitRunner, type GitRunner } from './worktree';

describe('parseUseLine', () => {
  it('reads plain, aliased, listed and grouped imports', () => {
    expect(parseUseLine('use App\\Dto\\Foo;')).toEqual([['foo', 'App\\Dto\\Foo']]);
    expect(parseUseLine('use \\App\\Dto\\Foo as Bar;')).toEqual([['bar', 'App\\Dto\\Foo']]);
    expect(parseUseLine('use App\\A, App\\B as C;')).toEqual([
      ['a', 'App\\A'],
      ['c', 'App\\B'],
    ]);
    expect(parseUseLine('use App\\Dto\\{Foo, Bar as Baz};')).toEqual([
      ['foo', 'App\\Dto\\Foo'],
      ['baz', 'App\\Dto\\Bar'],
    ]);
  });

  it('ignores function and const imports, and indented trait uses', () => {
    expect(parseUseLine('use function App\\helper;')).toBeNull();
    expect(parseUseLine('use const App\\LIMIT;')).toBeNull();
    expect(parseUseLine('    use SomeTrait;')).toBeNull();
  });
});

describe('resolveClassName', () => {
  const header = parsePhpHeader(['<?php', 'namespace App\\Service;', 'use App\\Dto\\Foo;', 'use App\\Model as M;']);

  it('resolves the way PHP does', () => {
    expect(resolveClassName('\\Other\\Foo', header)).toBe('Other\\Foo');
    expect(resolveClassName('Foo', header)).toBe('App\\Dto\\Foo');
    expect(resolveClassName('M\\User', header)).toBe('App\\Model\\User');
    expect(resolveClassName('Local', header)).toBe('App\\Service\\Local');
    expect(resolveClassName('Sub\\Thing', header)).toBe('App\\Service\\Sub\\Thing');
    expect(resolveClassName('namespace\\X', header)).toBe('App\\Service\\X');
  });

  it('is case-insensitive on imports, as PHP is', () => {
    expect(resolveClassName('foo', header)).toBe('App\\Dto\\Foo');
  });
});

describe('phpTargetAt', () => {
  const header = parsePhpHeader(['namespace App\\Service;', 'use App\\Dto\\Foo;']);

  it('resolves a reference under the cursor', () => {
    const line = '        $x = new Foo($y);';
    expect(phpTargetAt(line, line.indexOf('Foo') + 1, header)).toEqual({
      kind: 'reference',
      fqcn: 'App\\Dto\\Foo',
      written: 'Foo',
    });
  });

  it('treats a declaration name as the declaration', () => {
    const line = 'final class Handler extends Base';
    expect(phpTargetAt(line, line.indexOf('Handler'), header)).toEqual({
      kind: 'declaration',
      fqcn: 'App\\Service\\Handler',
    });
    // The parent class on the same line is a reference.
    expect(phpTargetAt(line, line.indexOf('Base'), header)).toMatchObject({ kind: 'reference', fqcn: 'App\\Service\\Base' });
  });

  it('reads an import as absolute', () => {
    const line = 'use App\\Dto\\{Foo, Bar};';
    expect(phpTargetAt(line, line.indexOf('Bar'), header)).toMatchObject({ fqcn: 'App\\Dto\\Bar' });
  });

  it('skips variables, members and self', () => {
    const line = '$foo->Foo; Foo::Foo; self::x();';
    expect(phpTargetAt(line, 2, header)).toBeNull();
    expect(phpTargetAt(line, line.indexOf('->') + 3, header)).toBeNull();
    expect(phpTargetAt(line, line.indexOf('::') + 3, header)).toBeNull();
    expect(phpTargetAt(line, line.indexOf('self') + 1, header)).toBeNull();
  });
});

describe('referencesOn', () => {
  const header = parsePhpHeader(['namespace App\\Service;', 'use App\\Dto\\Foo as Alias;']);

  it('marks every spelling that resolves to the class, and nothing else', () => {
    const line = 'fn(Alias $a, \\App\\Dto\\Foo $b, Foo $c, $foo): Alias';
    const spans = referencesOn(line, 'App\\Dto\\Foo', header).map(([a, b]) => line.slice(a, b));
    // Bare `Foo` here is App\Service\Foo: the file imports the Dto one as Alias.
    expect(spans).toEqual(['Alias', '\\App\\Dto\\Foo', 'Alias']);
  });

  it('does not count the declaration itself', () => {
    const own = parsePhpHeader(['namespace App\\Dto;']);
    expect(referencesOn('final class Foo', 'App\\Dto\\Foo', own)).toEqual([]);
    expect(referencesOn('class Bar extends Foo', 'App\\Dto\\Foo', own)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Against a real repository
// ---------------------------------------------------------------------------

describe('findPhpUsages', () => {
  let root = '';
  let restore: GitRunner | null = null;

  const files: Record<string, string> = {
    'src/Dto/Foo.php': '<?php\nnamespace App\\Dto;\n\nfinal class Foo {}\n',
    'src/Other/Foo.php': '<?php\nnamespace App\\Other;\n\nfinal class Foo {}\n',
    'src/Dto/SameNamespace.php': '<?php\nnamespace App\\Dto;\n\nclass SameNamespace { public Foo $foo; }\n',
    'src/Service/Imports.php': '<?php\nnamespace App\\Service;\n\nuse App\\Dto\\Foo;\n\nclass Imports { function f(): Foo {} }\n',
    'src/Service/Aliased.php': '<?php\nnamespace App\\Service;\n\nuse App\\Dto\\Foo as DtoFoo;\n\nclass Aliased { function f(DtoFoo $x) {} }\n',
    'src/Service/WrongFoo.php': '<?php\nnamespace App\\Service;\n\nuse App\\Other\\Foo;\n\nclass WrongFoo { function f(Foo $x) {} }\n',
    'src/Service/Qualified.php': '<?php\nnamespace App\\Service;\n\nclass Qualified { function f(\\App\\Dto\\Foo $x) {} }\n',
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'phprefs-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    restore = setGitRunner(async (args, cwd) => {
      try {
        const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    });
  });

  afterAll(() => {
    if (restore) setGitRunner(restore);
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the files that mean App\\Dto\\Foo, and only those', async () => {
    const r = await findPhpUsages(root, 'App\\Dto\\Foo');
    const where = r.groups.flatMap((g) => g.matches.map((m) => `${g.path}:${m.line}`));
    expect(where).toEqual([
      'src/Dto/SameNamespace.php:4',
      'src/Service/Aliased.php:4',
      'src/Service/Aliased.php:6',
      'src/Service/Imports.php:4',
      'src/Service/Imports.php:6',
      'src/Service/Qualified.php:4',
    ]);
  });

  it('falls back to whole-word text matches', async () => {
    const r = await findWord(root, 'Imports');
    expect(r.groups.map((g) => g.path)).toEqual(['src/Service/Imports.php']);
  });
});
