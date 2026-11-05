/**
 * ⌘B (and ⌘-click) with one answer opens it straight away (#260), whichever
 * path found it; ⌥F7 always lists. PHPantom, the code index and git grep are
 * stand-ins whose answers each test sets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FindResult } from '../../git/findInFiles';
import type { CodeSymbol } from '../../git/codeIndex';
import type { Location } from '../../lsp/phpantom';

const files: Record<string, string> = {
  'src/Alpha.php': '<?php\nnamespace App;\n\nclass Alpha\n{\n    public function run() {}\n}\n',
  'src/Beta.php': '<?php\nnamespace App;\n\nclass Beta\n{\n    public function go(Alpha $a) { $a->run(); }\n}\n',
  'src/util.ts': 'export function helper() {}\n',
};

/** null: PHPantom is not installed. */
const stub = vi.hoisted(() => ({
  definition: null as Location[] | null,
  references: [] as Location[],
  symbols: [] as CodeSymbol[],
  usages: null as FindResult | null,
  words: null as FindResult | null,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async (absolute: string) => files[absolute.replace(/^\/root\//, '')] ?? ''),
}));
vi.mock('../../lsp/phpantom', async (actual) => ({
  ...(await actual<typeof import('../../lsp/phpantom')>()),
  phpantomFor: vi.fn(async () =>
    stub.definition === null
      ? null
      : {
          whenReady: async () => true,
          definition: async () => stub.definition,
          references: async () => stub.references,
        },
  ),
}));
vi.mock('../../git/codeIndex', async (actual) => ({
  ...(await actual<typeof import('../../git/codeIndex')>()),
  loadCodeIndex: vi.fn(async () => ({ symbols: stub.symbols, files: [] })),
}));
vi.mock('../../git/phpRefs', async (actual) => ({
  ...(await actual<typeof import('../../git/phpRefs')>()),
  findPhpUsages: vi.fn(async () => stub.usages),
  findWord: vi.fn(async () => stub.words),
  namespacesOf: vi.fn(async (_root: string, paths: string[]) => new Map(paths.map((p) => [p, 'App']))),
}));

const { navigate } = await import('./symbolNav');

afterEach(() => {
  stub.definition = null;
  stub.references = [];
  stub.symbols = [];
  stub.usages = null;
  stub.words = null;
});

/** The cursor inside the last `name` in `path`. */
function at(path: string, name: string) {
  const text = files[path]!;
  return { root: '/root', path, text, offset: text.lastIndexOf(name) + 1 };
}

function rows(...at: Array<[string, number]>): FindResult {
  const groups = at.map(([path, line]) => ({ path, matches: [{ path, line, text: 'x', ranges: [] as Array<[number, number]> }] }));
  return { groups, count: at.length, capped: false };
}

describe('⌘B with one answer opens it (#260)', () => {
  it('on a declaration with one usage (PHPantom): goes to that usage', async () => {
    // PHPantom answers a declaration with itself; the usages are the answer.
    stub.definition = [{ path: 'src/Alpha.php', line: 6 }];
    stub.references = [{ path: 'src/Beta.php', line: 6 }];
    expect(await navigate(at('src/Alpha.php', 'run'), 'declaration')).toEqual({ kind: 'open', path: 'src/Beta.php', line: 6 });
  });

  it('two PHPantom declarations on one line are one row: opens it', async () => {
    stub.definition = [
      { path: 'src/Alpha.php', line: 6 },
      { path: 'src/Alpha.php', line: 6 },
    ];
    expect(await navigate(at('src/Beta.php', 'run'), 'declaration')).toEqual({ kind: 'open', path: 'src/Alpha.php', line: 6 });
  });

  it('two declarations elsewhere still list', async () => {
    stub.definition = [
      { path: 'src/Alpha.php', line: 6 },
      { path: 'src/util.ts', line: 1 },
    ];
    const out = await navigate(at('src/Beta.php', 'run'), 'declaration');
    expect(out.kind).toBe('list');
  });

  it('on a class declaration with one usage, by git grep: goes to that usage', async () => {
    stub.usages = rows(['src/Beta.php', 6]);
    expect(await navigate(at('src/Alpha.php', 'Alpha'), 'declaration')).toEqual({ kind: 'open', path: 'src/Beta.php', line: 6 });
  });

  it('the one row is where the cursor is: the list stays, so the click still answers', async () => {
    stub.symbols = [{ name: 'helper', kind: 'function', path: 'src/util.ts', line: 1 }];
    stub.words = rows(['src/util.ts', 1]);
    const out = await navigate(at('src/util.ts', 'helper'), 'declaration');
    expect(out.kind).toBe('list');
  });

  it('a method called once, by text search: its declaration row is not a choice, so the call opens', async () => {
    // PHPantom not installed (or not ready): the by-name path lists text
    // matches, the declaration under the cursor among them.
    stub.symbols = [{ name: 'run', kind: 'method', path: 'src/Alpha.php', line: 6 }];
    stub.words = rows(['src/Alpha.php', 6], ['src/Beta.php', 6]);
    expect(await navigate(at('src/Alpha.php', 'run'), 'declaration')).toEqual({ kind: 'open', path: 'src/Beta.php', line: 6 });
  });

  it('two places besides the cursor still list', async () => {
    stub.symbols = [{ name: 'run', kind: 'method', path: 'src/Alpha.php', line: 6 }];
    stub.words = rows(['src/Alpha.php', 6], ['src/Beta.php', 6], ['src/util.ts', 1]);
    expect((await navigate(at('src/Alpha.php', 'run'), 'declaration')).kind).toBe('list');
  });

  it('⌥F7 asked for a list: one usage is still listed', async () => {
    stub.definition = [{ path: 'src/Alpha.php', line: 6 }];
    stub.references = [{ path: 'src/Beta.php', line: 6 }];
    const out = await navigate(at('src/Alpha.php', 'run'), 'usages');
    expect(out.kind).toBe('list');
    if (out.kind === 'list') expect(out.result.count).toBe(1);
  });
});
