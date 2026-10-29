/**
 * The parsers are pure and tested on fixture strings: no git, no worktree.
 * `loadCodeIndex` is exercised through the injectable git runner.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  extractSymbol,
  grepArgs,
  invalidateCodeIndex,
  LANGUAGES,
  languageOf,
  filesNamed,
  loadCodeIndex,
  parseGrepOutput,
  parseLsFilesZ,
  peekCodeIndex,
  symbolsFromHits,
} from './codeIndex';
import { setGitRunner, type GitRunner } from './worktree';

const x = (path: string, text: string) => extractSymbol(path, text);

describe('parseLsFilesZ', () => {
  it('splits on NUL, drops empties, dedupes in order', () => {
    // --cached and --others overlap for nothing in practice, but a file that is
    // both staged-deleted and present comes out twice.
    expect(parseLsFilesZ('a.php\0b/c.ts\0a.php\0')).toEqual(['a.php', 'b/c.ts']);
    expect(parseLsFilesZ('')).toEqual([]);
  });

  it('keeps spaces, colons and newlines in names', () => {
    expect(parseLsFilesZ('my file.ts\0a:1:b.php\0')).toEqual(['my file.ts', 'a:1:b.php']);
  });
});

describe('parseGrepOutput', () => {
  it('reads the -z form', () => {
    const out = 'src/A.php\x008\x00class A extends B\nsrc/B.php\x0012\x00    public function run()\n';
    expect(parseGrepOutput(out)).toEqual([
      { path: 'src/A.php', line: 8, text: 'class A extends B' },
      { path: 'src/B.php', line: 12, text: '    public function run()' },
    ]);
  });

  it('keeps colons in the text of the -z form', () => {
    expect(parseGrepOutput('a.ts\x003\x00type A = { b: 1 }\n')[0]!.text).toBe('type A = { b: 1 }');
  });

  it('reads the colon form', () => {
    expect(parseGrepOutput('src/A.php:8:class A\n')).toEqual([{ path: 'src/A.php', line: 8, text: 'class A' }]);
  });

  it('keeps colons in the text of the colon form', () => {
    expect(parseGrepOutput('a.ts:3:const x: Foo = 1\n')[0]).toEqual({ path: 'a.ts', line: 3, text: 'const x: Foo = 1' });
  });

  it('uses the file list to place a path that itself contains :digits:', () => {
    const known = new Set(['odd:12:name.php']);
    expect(parseGrepOutput('odd:12:name.php:4:class X\n', known)[0]).toEqual({
      path: 'odd:12:name.php',
      line: 4,
      text: 'class X',
    });
    // Without the list the first split wins -- wrong here, but never a throw.
    expect(parseGrepOutput('odd:12:name.php:4:class X\n')[0]!.path).toBe('odd');
  });

  it('falls back to the first split when no candidate is a known file', () => {
    expect(parseGrepOutput('a.php:4:x:5:y\n', new Set(['other.php']))[0]).toEqual({ path: 'a.php', line: 4, text: 'x:5:y' });
  });

  it('skips records that fit neither shape', () => {
    expect(parseGrepOutput('garbage\nBinary file x matches\nok.php:1:class Ok\n')).toEqual([
      { path: 'ok.php', line: 1, text: 'class Ok' },
    ]);
    expect(parseGrepOutput('a\x00notanumber\x00text\n')).toEqual([]);
    expect(parseGrepOutput('a\x000\x00text\n')).toEqual([]);
  });
});

describe('PHP', () => {
  it('classes, interfaces, traits, enums, with modifiers', () => {
    expect(x('a.php', 'class Customer implements JsonSerializable')).toEqual({ kind: 'class', name: 'Customer' });
    expect(x('a.php', 'final class Foo')).toEqual({ kind: 'class', name: 'Foo' });
    expect(x('a.php', 'abstract class Base')).toEqual({ kind: 'class', name: 'Base' });
    expect(x('a.php', 'final readonly class Money')).toEqual({ kind: 'class', name: 'Money' });
    expect(x('a.php', 'interface Repository')).toEqual({ kind: 'interface', name: 'Repository' });
    expect(x('a.php', 'trait LogsThings')).toEqual({ kind: 'trait', name: 'LogsThings' });
    expect(x('a.php', 'enum Suit: string')).toEqual({ kind: 'enum', name: 'Suit' });
  });

  it('methods with any modifiers, and by-reference returns', () => {
    expect(x('a.php', '    public function run(): void')).toEqual({ kind: 'method', name: 'run' });
    expect(x('a.php', '    public static function create(')).toEqual({ kind: 'method', name: 'create' });
    expect(x('a.php', '    abstract protected function handle();')).toEqual({ kind: 'method', name: 'handle' });
    expect(x('a.php', '    final public function &items()')).toEqual({ kind: 'method', name: 'items' });
    expect(x('a.php', '    private function __construct(')).toEqual({ kind: 'method', name: '__construct' });
    expect(x('a.php', '    function legacy()')).toEqual({ kind: 'method', name: 'legacy' });
  });

  it('top-level functions', () => {
    expect(x('a.php', 'function helper($a)')).toEqual({ kind: 'function', name: 'helper' });
    expect(x('a.php', 'function & ref_helper()')).toEqual({ kind: 'function', name: 'ref_helper' });
  });

  it('rejects closures, anonymous classes and comments', () => {
    expect(x('a.php', '    $f = function ($x) {')).toBeNull();
    expect(x('a.php', '    return new class extends Base {')).toBeNull();
    expect(x('a.php', ' * class Foo is described here')).toBeNull();
    expect(x('a.php', '    $x = $y->class;')).toBeNull();
  });
});

describe('JS / TS', () => {
  it('classes', () => {
    expect(x('a.ts', 'export default class App extends Component {')).toEqual({ kind: 'class', name: 'App' });
    expect(x('a.ts', 'export abstract class Base {')).toEqual({ kind: 'class', name: 'Base' });
    expect(x('a.js', 'class Cache {')).toEqual({ kind: 'class', name: 'Cache' });
  });

  it('functions, including async, generators and default exports', () => {
    expect(x('a.ts', 'export function parse(s: string) {')).toEqual({ kind: 'function', name: 'parse' });
    expect(x('a.ts', 'export default function App() {')).toEqual({ kind: 'function', name: 'App' });
    expect(x('a.ts', 'export async function load() {')).toEqual({ kind: 'function', name: 'load' });
    expect(x('a.js', 'function* walk(tree) {')).toEqual({ kind: 'function', name: 'walk' });
    expect(x('a.ts', '  function inner() {')).toEqual({ kind: 'function', name: 'inner' });
  });

  it('arrow-function bindings', () => {
    expect(x('a.jsx', 'const Button = ({ label }) => (')).toEqual({ kind: 'function', name: 'Button' });
    expect(x('a.jsx', 'export const Modal = ({')).toEqual({ kind: 'function', name: 'Modal' });
    expect(x('a.ts', 'export const f = async (a: number) => a')).toEqual({ kind: 'function', name: 'f' });
    expect(x('a.ts', 'const g = x => x * 2;')).toEqual({ kind: 'function', name: 'g' });
    expect(x('a.ts', 'const h: Handler = (e) => {}')).toEqual({ kind: 'function', name: 'h' });
    expect(x('a.ts', 'let k = function () {}')).toEqual({ kind: 'function', name: 'k' });
  });

  it('module-scope and exported constants', () => {
    expect(x('a.ts', 'const MAX = 10;')).toEqual({ kind: 'const', name: 'MAX' });
    expect(x('a.ts', 'export const SHORTCUTS: readonly X[] = [')).toEqual({ kind: 'const', name: 'SHORTCUTS' });
    expect(x('a.ts', '  export const nested = 1;')).toEqual({ kind: 'const', name: 'nested' });
  });

  it('rejects locals, destructuring and module-scope let', () => {
    expect(x('a.ts', '  const onClick = () => {')).toBeNull();
    expect(x('a.ts', '  const total = 1;')).toBeNull();
    expect(x('a.ts', 'const { a, b } = obj;')).toBeNull();
    expect(x('a.ts', 'let counter = 0;')).toBeNull();
    expect(x('a.ts', 'const same = a === b;')).toEqual({ kind: 'const', name: 'same' });
  });

  it('TS interfaces, types and enums', () => {
    expect(x('a.ts', 'export interface Task {')).toEqual({ kind: 'interface', name: 'Task' });
    expect(x('a.ts', 'interface Props extends Base {')).toEqual({ kind: 'interface', name: 'Props' });
    expect(x('a.ts', "export type Combo = 'mod+n' | 'mod+/';")).toEqual({ kind: 'type', name: 'Combo' });
    expect(x('a.ts', 'type Pair<A, B> = [A, B];')).toEqual({ kind: 'type', name: 'Pair' });
    expect(x('a.ts', 'export const enum Dir {')).toEqual({ kind: 'enum', name: 'Dir' });
    expect(x('a.ts', 'enum Color {')).toEqual({ kind: 'enum', name: 'Color' });
    expect(x('a.ts', 'declare type Ambient = string;')).toEqual({ kind: 'type', name: 'Ambient' });
  });

  it('class methods', () => {
    expect(x('a.ts', '  render() {')).toEqual({ kind: 'method', name: 'render' });
    expect(x('a.ts', '  async load(id: number): Promise<void> {')).toEqual({ kind: 'method', name: 'load' });
    expect(x('a.ts', '  private static parse<T>(raw: string): T {')).toEqual({ kind: 'method', name: 'parse' });
    expect(x('a.ts', '  get size() {')).toEqual({ kind: 'method', name: 'size' });
    expect(x('a.js', '  *[Symbol.iterator]() {')).toBeNull();
    expect(x('a.js', '  #secret() {')).toEqual({ kind: 'method', name: '#secret' });
    expect(x('a.ts', '  constructor(private readonly x: number) {')).toEqual({ kind: 'method', name: 'constructor' });
  });

  it('rejects control flow and calls that look like methods', () => {
    for (const line of [
      '  if (x) {',
      '  for (const a of b) {',
      '  while (true) {',
      '  switch (kind) {',
      '  } catch (e) {',
      '  catch (e) {',
      '  return (x) {',
      "  describe('x', () => {",
      "  it('works', async () => {",
      '  useEffect(() => {',
      '    async (path: string): Promise<string | null> => {',
    ]) {
      expect(x('a.ts', line), line).toBeNull();
    }
  });

  it('covers every JS-family extension', () => {
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) {
      expect(x(`a.${ext}`, 'class A {')).toEqual({ kind: 'class', name: 'A' });
    }
  });
});

describe('Python', () => {
  it('classes, functions and methods', () => {
    expect(x('a.py', 'class Parser(Base):')).toEqual({ kind: 'class', name: 'Parser' });
    expect(x('a.py', 'def main():')).toEqual({ kind: 'function', name: 'main' });
    expect(x('a.py', 'async def fetch(url):')).toEqual({ kind: 'function', name: 'fetch' });
    expect(x('a.py', '    def __init__(self):')).toEqual({ kind: 'method', name: '__init__' });
    expect(x('a.py', '    async def run(self):')).toEqual({ kind: 'method', name: 'run' });
    expect(x('a.py', '# def commented():')).toBeNull();
  });
});

describe('Go', () => {
  it('functions, methods and types', () => {
    expect(x('a.go', 'func main() {')).toEqual({ kind: 'function', name: 'main' });
    expect(x('a.go', 'func (r *Repo) Find(id int) (*Row, error) {')).toEqual({ kind: 'method', name: 'Find' });
    expect(x('a.go', 'func (Repo) Name() string {')).toEqual({ kind: 'method', name: 'Name' });
    expect(x('a.go', 'type Repo struct {')).toEqual({ kind: 'class', name: 'Repo' });
    expect(x('a.go', 'type Reader interface {')).toEqual({ kind: 'interface', name: 'Reader' });
    expect(x('a.go', 'type ID int64')).toEqual({ kind: 'type', name: 'ID' });
    expect(x('a.go', 'type List[T any] struct {')).toEqual({ kind: 'class', name: 'List' });
    expect(x('a.go', 'func(x int) {}')).toBeNull();
  });
});

describe('Rust', () => {
  it('functions, methods and type declarations', () => {
    expect(x('a.rs', 'fn main() {')).toEqual({ kind: 'function', name: 'main' });
    expect(x('a.rs', 'pub fn run() -> Result<()> {')).toEqual({ kind: 'function', name: 'run' });
    expect(x('a.rs', 'pub(crate) async fn spawn(')).toEqual({ kind: 'function', name: 'spawn' });
    expect(x('a.rs', '    pub fn new() -> Self {')).toEqual({ kind: 'method', name: 'new' });
    expect(x('a.rs', '    pub const unsafe fn raw(')).toEqual({ kind: 'method', name: 'raw' });
    expect(x('a.rs', 'extern "C" fn callback() {')).toEqual({ kind: 'function', name: 'callback' });
    expect(x('a.rs', 'pub struct PtyRegistry {')).toEqual({ kind: 'class', name: 'PtyRegistry' });
    expect(x('a.rs', 'enum State {')).toEqual({ kind: 'enum', name: 'State' });
    expect(x('a.rs', 'pub trait Runner {')).toEqual({ kind: 'trait', name: 'Runner' });
    expect(x('a.rs', 'type Shared = Arc<Mutex<()>>;')).toEqual({ kind: 'type', name: 'Shared' });
    expect(x('a.rs', 'impl Runner for X {')).toBeNull();
  });
});

describe('languageOf', () => {
  it('dispatches on the extension, case-insensitively', () => {
    expect(languageOf('a/B.PHP')?.name).toBe('php');
    expect(languageOf('x.tsx')?.name).toBe('js');
    expect(languageOf('Makefile')).toBeNull();
    expect(languageOf('dir.php/README')).toBeNull();
    expect(languageOf('trailing.')).toBeNull();
    expect(x('template.tpl', 'class Foo')).toBeNull();
  });
});

describe('grepArgs', () => {
  it('pins the shape git is called with', () => {
    const php = LANGUAGES.find((l) => l.name === 'php')!;
    const args = grepArgs(php, '-E');
    expect(args.slice(0, 7)).toEqual(['grep', '-n', '-z', '-I', '-E', '--no-color', '--untracked']);
    expect(args.slice(args.indexOf('--'))).toEqual(['--', '*.php']);
    expect(args.filter((a) => a === '-e')).toHaveLength(php.grep.length);
  });

  it('has a prefilter per language that accepts what the precise pass accepts', () => {
    // The ERE and the JS regex are two halves of one decision. A line the JS
    // regex would accept but git never returns is a silent false negative.
    const samples: Record<string, string[]> = {
      php: ['final readonly class Money', '    public static function &create('],
      js: ['export const Modal = ({', '  private static parse<T>(raw: string): T {', 'export type A = 1;'],
      python: ['    async def run(self):'],
      go: ['func (r *Repo) Find() {'],
      rust: ['    pub(crate) const fn raw('],
    };
    for (const lang of LANGUAGES) {
      for (const line of samples[lang.name] ?? []) {
        const ere = lang.grep.map((p) => new RegExp(p.replace(/\[\[:space:\]\]/g, '\\s')));
        expect(ere.some((r) => r.test(line)), `${lang.name}: ${line}`).toBe(true);
        expect(lang.extract(line), `${lang.name}: ${line}`).not.toBeNull();
      }
    }
  });
});

describe('symbolsFromHits', () => {
  it('drops hits the precise pass rejects', () => {
    const hits = parseGrepOutput('a.ts\x001\x00  if (x) {\na.ts\x002\x00export class A {\n');
    expect(symbolsFromHits(hits)).toEqual([{ name: 'A', kind: 'class', path: 'a.ts', line: 2 }]);
  });
});

describe('loadCodeIndex', () => {
  let restore: GitRunner | null = null;
  afterEach(() => {
    if (restore) setGitRunner(restore);
    restore = null;
    invalidateCodeIndex();
  });

  function fake(calls: string[][]): GitRunner {
    return async (args) => {
      calls.push(args);
      if (args[0] === 'ls-files') return { code: 0, stdout: 'src/A.php\0src/b.ts\0', stderr: '' };
      if (args.includes('*.php')) return { code: 0, stdout: 'src/A.php\x003\x00final class A\n', stderr: '' };
      if (args.includes('*.ts')) return { code: 0, stdout: 'src/b.ts\x001\x00export function b() {\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
  }

  it('builds files and symbols, and shares one build between callers', async () => {
    const calls: string[][] = [];
    restore = setGitRunner(fake(calls));
    const [a, b] = await Promise.all([loadCodeIndex('/w'), loadCodeIndex('/w')]);
    expect(a).toBe(b);
    expect(a.files).toEqual(['src/A.php', 'src/b.ts']);
    expect(a.symbols).toEqual([
      { name: 'A', kind: 'class', path: 'src/A.php', line: 3 },
      { name: 'b', kind: 'function', path: 'src/b.ts', line: 1 },
    ]);
    expect(calls).toHaveLength(1 + LANGUAGES.length);
    expect(peekCodeIndex('/w')).toBe(a);
  });

  it('serves from cache inside the TTL and rebuilds after invalidate', async () => {
    const calls: string[][] = [];
    restore = setGitRunner(fake(calls));
    const first = await loadCodeIndex('/w');
    await loadCodeIndex('/w');
    expect(calls).toHaveLength(1 + LANGUAGES.length);
    invalidateCodeIndex('/w');
    // The stale index stays peekable while the rebuild runs.
    expect(peekCodeIndex('/w')).toBe(first);
    const second = await loadCodeIndex('/w');
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2 * (1 + LANGUAGES.length));
  });

  it('falls back to ERE when this git has no PCRE', async () => {
    const calls: string[][] = [];
    const inner = fake(calls);
    restore = setGitRunner(async (args, cwd) => {
      if (args.includes('-P')) {
        calls.push(args);
        return { code: 128, stdout: '', stderr: 'fatal: cannot use Perl-compatible regexes' };
      }
      return inner(args, cwd);
    });
    const index = await loadCodeIndex('/w');
    expect(index.symbols.map((s) => s.name)).toEqual(['A', 'b']);
  });

  it('a failed ls-files rejects and is not cached', async () => {
    let fail = true;
    const calls: string[][] = [];
    const ok = fake(calls);
    restore = setGitRunner(async (args, cwd) =>
      fail && args[0] === 'ls-files' ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : ok(args, cwd),
    );
    await expect(loadCodeIndex('/nope')).rejects.toThrow('not a git repository');
    // Let the rejection handler clear the entry.
    await Promise.resolve();
    fail = false;
    await expect(loadCodeIndex('/nope')).resolves.toMatchObject({ files: ['src/A.php', 'src/b.ts'] });
  });
});

describe('filesNamed', () => {
  let restore: GitRunner | null = null;
  afterEach(() => {
    if (restore) setGitRunner(restore);
    restore = null;
    invalidateCodeIndex();
  });

  const files = (list: string[]): GitRunner => async (args) =>
    args[0] === 'ls-files' ? { code: 0, stdout: list.map((f) => `${f}\0`).join(''), stderr: '' } : { code: 1, stdout: '', stderr: '' };

  it('finds a file by its name, at any depth or at the root, and not by a longer name', async () => {
    restore = setGitRunner(files(['src/Message/Factory.php', 'Factory.php', 'src/OtherFactory.php']));
    expect(await filesNamed('/w', 'Factory.php')).toEqual(['src/Message/Factory.php', 'Factory.php']);
    expect(await filesNamed('/w', 'Missing.php')).toEqual([]);
  });
});

