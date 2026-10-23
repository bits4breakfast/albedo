import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  declaredSpan,
  findPhpSubtypes,
  findPhpUsages,
  findWord,
  parsePhpHeader,
  parseUseLine,
  phpTargetAt,
  referencesOn,
  resolveClassName,
  type SupertypeKind,
  subtypeDeclaredOn,
  traitUseOn,
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

describe('declaredSpan', () => {
  it('marks the declared name, after any modifiers', () => {
    const line = 'final readonly class Square extends Polygon';
    const [a, b] = declaredSpan(line)!;
    expect(line.slice(a, b)).toBe('Square');
    expect(declaredSpan('    use Loggable;')).toBeNull();
    expect(declaredSpan('$x = new class extends Polygon {};')).toBeNull();
  });
});

describe('subtypeDeclaredOn', () => {
  const header = parsePhpHeader(['namespace App\\Other;', 'use App\\Model\\Shape;', 'use App\\Model as M;']);
  const named = (line: string, fqcn: string, kind: 'class' | 'interface' | 'any') => {
    const span = subtypeDeclaredOn(line, fqcn, kind, header);
    return span ? line.slice(span[0], span[1]) : null;
  };

  it('finds a class among an implements list, resolved through the imports', () => {
    expect(named('final class Circle implements \\Countable, Shape', 'App\\Model\\Shape', 'interface')).toBe('Circle');
    expect(named('class Oval implements M\\Shape {', 'App\\Model\\Shape', 'interface')).toBe('Oval');
    expect(named('enum Suit: string implements Shape', 'App\\Model\\Shape', 'interface')).toBe('Suit');
    // An interface extends an interface.
    expect(named('interface SolidShape extends \\Countable, Shape', 'App\\Model\\Shape', 'interface')).toBe('SolidShape');
  });

  it('finds a subclass by its extends, and only there', () => {
    expect(named('class Tiny extends M\\Square implements Shape', 'App\\Model\\Square', 'class')).toBe('Tiny');
    // Square named in the implements list is not an extends.
    expect(named('class Tiny extends Base implements M\\Square', 'App\\Model\\Square', 'class')).toBeNull();
    // A class does not "implement" a class, nor an interface "extend" one.
    expect(named('interface Odd extends M\\Square', 'App\\Model\\Square', 'class')).toBeNull();
    expect(named('class Odd extends Shape', 'App\\Model\\Shape', 'interface')).toBeNull();
  });

  it('keeps names that resolve elsewhere, in comments or in the body out', () => {
    // Fully qualified to another namespace's Shape.
    expect(named('class Wrong implements \\App\\Other\\Shape', 'App\\Model\\Shape', 'interface')).toBeNull();
    expect(named('class Plain // implements Shape', 'App\\Model\\Shape', 'interface')).toBeNull();
    expect(named('class Plain { public Shape $s; }', 'App\\Model\\Shape', 'interface')).toBeNull();
    // The declaration of the interface itself is not one of its implementers.
    const own = parsePhpHeader(['namespace App\\Model;']);
    expect(subtypeDeclaredOn('interface Shape extends Shape', 'App\\Model\\Shape', 'interface', own)).toBeNull();
  });

  it('for a type of unknown kind, takes either clause', () => {
    const fq = 'Vendor\\Kit\\Widget';
    expect(named('class Panel extends \\Vendor\\Kit\\Widget', fq, 'any')).toBe('Panel');
    expect(named('final class Panel implements \\Countable, \\Vendor\\Kit\\Widget', fq, 'any')).toBe('Panel');
    expect(named('interface Pane extends \\Vendor\\Kit\\Widget', fq, 'any')).toBe('Pane');
    expect(named('enum Size implements \\Vendor\\Kit\\Widget', fq, 'any')).toBe('Size');
    expect(named('class Panel { private \\Vendor\\Kit\\Widget $w; }', fq, 'any')).toBeNull();
  });

  it('cannot see a list that goes on to the next line', () => {
    // The documented limit: `implements` alone on the line names nothing yet.
    expect(named('class Oval implements', 'App\\Model\\Shape', 'interface')).toBeNull();
  });
});

describe('traitUseOn', () => {
  const header = parsePhpHeader(['namespace App\\Other;', 'use App\\Model\\Loggable;', 'use App\\Model as M;']);

  it('reads an indented use as a trait use, with a list, an alias or an adaptation block', () => {
    expect(traitUseOn('    use Loggable;', 'App\\Model\\Loggable', header)).toBe(true);
    expect(traitUseOn('    use M\\Tagged, Loggable {', 'App\\Model\\Loggable', header)).toBe(true);
    expect(traitUseOn('\tuse M\\Loggable;', 'App\\Model\\Loggable', header)).toBe(true);
  });

  it('is not an import, and not a name inside the adaptation block', () => {
    expect(traitUseOn('use App\\Model\\Loggable;', 'App\\Model\\Loggable', header)).toBe(false);
    expect(traitUseOn('    use Tagged { Loggable::log insteadof Tagged; }', 'App\\Model\\Loggable', header)).toBe(false);
    expect(traitUseOn('    use function App\\Model\\Loggable;', 'App\\Model\\Loggable', header)).toBe(false);
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

describe('findPhpSubtypes', () => {
  let root = '';
  let restore: GitRunner | null = null;

  const files: Record<string, string> = {
    'src/Model/Shape.php': '<?php\nnamespace App\\Model;\n\ninterface Shape {}\n',
    'src/Model/SolidShape.php': '<?php\nnamespace App\\Model;\n\ninterface SolidShape extends Shape {}\n',
    'src/Model/Polygon.php': '<?php\nnamespace App\\Model;\n\nabstract class Polygon implements Shape\n{\n    use Loggable;\n}\n',
    'src/Model/Square.php': '<?php\nnamespace App\\Model;\n\nclass Square extends Polygon {}\n',
    'src/Model/Loggable.php': '<?php\nnamespace App\\Model;\n\ntrait Loggable {}\n',
    'src/Model/Tagged.php': '<?php\nnamespace App\\Model;\n\ntrait Tagged\n{\n    use Loggable;\n}\n',
    'src/Other/Circle.php':
      '<?php\nnamespace App\\Other;\n\nuse App\\Model\\Shape as Form;\nuse App\\Model as M;\n\nfinal class Circle implements \\Countable, Form\n{\n    use M\\Loggable, M\\Tagged;\n    use M\\Loggable;\n}\n',
    'src/Other/Tiny.php': '<?php\nnamespace App\\Other;\n\nuse App\\Model\\Square;\n\nclass Tiny extends Square {}\n',
    'src/Other/Oval.php': '<?php\nnamespace App\\Other;\n\nuse App\\Model\\Shape;\n\nclass Oval implements\n    Shape\n{\n}\n',
    'src/Other/Shape.php': '<?php\nnamespace App\\Other;\n\ninterface Shape {}\nclass Decoy implements Shape {}\n',
    // Vendor\Kit\Widget is declared nowhere here, as a vendor type is not.
    'src/Other/Panel.php': '<?php\nnamespace App\\Other;\n\nuse Vendor\\Kit\\Widget;\n\nclass Panel extends Widget {}\n',
    'src/Other/Sheet.php': '<?php\nnamespace App\\Other;\n\nfinal class Sheet implements \\Vendor\\Kit\\Widget {}\n',
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'phpsubtypes-'));
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

  /** Each row as `path:line Name`, the marked name being the declared one. */
  const rows = async (fqcn: string, kind: SupertypeKind) => {
    const r = await findPhpSubtypes(root, fqcn, kind);
    return r.groups.flatMap((g) => g.matches.map((m) => `${g.path}:${m.line} ${m.text.slice(...m.ranges[0]!)}`));
  };

  it('lists the direct implementers of an interface and the interfaces extending it', async () => {
    expect(await rows('App\\Model\\Shape', 'interface')).toEqual([
      'src/Model/Polygon.php:4 Polygon',
      'src/Model/SolidShape.php:4 SolidShape',
      // Through an alias import, which the short-name grep alone would miss.
      'src/Other/Circle.php:7 Circle',
      // Not Square (indirect), not Decoy (another Shape), not Oval (split across lines).
    ]);
  });

  it('lists the direct subclasses of a class', async () => {
    expect(await rows('App\\Model\\Polygon', 'class')).toEqual(['src/Model/Square.php:4 Square']);
    expect(await rows('App\\Model\\Square', 'class')).toEqual(['src/Other/Tiny.php:6 Tiny']);
  });

  it('lists the users of a trait on their declaration line, once per user', async () => {
    expect(await rows('App\\Model\\Loggable', 'trait')).toEqual([
      'src/Model/Polygon.php:4 Polygon',
      'src/Model/Tagged.php:4 Tagged',
      'src/Other/Circle.php:7 Circle',
    ]);
  });

  it('for a type of unknown kind, lists both what extends and what implements it', async () => {
    expect(await rows('Vendor\\Kit\\Widget', 'any')).toEqual(['src/Other/Panel.php:6 Panel', 'src/Other/Sheet.php:4 Sheet']);
  });

  it('finds nothing for a type nobody extends', async () => {
    expect(await rows('App\\Other\\Tiny', 'class')).toEqual([]);
  });
});
