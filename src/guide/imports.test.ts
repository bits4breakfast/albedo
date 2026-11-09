import { describe, expect, it } from 'vitest';
import {
  importGraph,
  languageOf,
  MAX_SCAN_FILES,
  normalizePath,
  phpIndex,
  resolvePhp,
  resolveRust,
  resolveTs,
  scanPhp,
  scanRust,
  scanTs,
} from './imports';

const has = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe('imports (#288): TS/JS', () => {
  it('reads every relative import form, once each, and leaves packages and comments alone', () => {
    const text = [
      "import React from 'react';",
      "import { a, type B } from './a';",
      "import type { C } from '../c/c.js';",
      "import * as d from './d';",
      "import './side.css';",
      "export { e } from './e';",
      "export * from './f';",
      "const g = await import('./g');",
      "const h = require('./h');",
      "// import x from './commented';",
      "/* import y from './blocked'; */",
      'import {',
      '  many,',
      '  lines,',
      "} from './multi';",
      "import { a as again } from './a';",
    ].join('\n');
    expect(scanTs(text).sort()).toEqual(['../c/c.js', './a', './d', './e', './f', './g', './h', './multi', './side.css'].sort());
  });

  it('resolves a specifier the way a bundler would: extension, index, and .js naming .ts', () => {
    const exists = has('src/a.ts', 'src/ui/index.tsx', 'src/c/c.ts', 'src/s.css');
    expect(resolveTs('src/b.ts', './a', exists)).toBe('src/a.ts');
    expect(resolveTs('src/b.ts', './ui', exists)).toBe('src/ui/index.tsx');
    expect(resolveTs('src/x/b.ts', '../c/c.js', exists)).toBe('src/c/c.ts');
    expect(resolveTs('src/b.ts', './s.css', exists)).toBe('src/s.css');
    expect(resolveTs('src/b.ts', './missing', exists)).toBeNull();
    expect(resolveTs('b.ts', '../../out', exists)).toBeNull();
  });

  it('a comment marker inside a string opens no comment (#288 review)', () => {
    const text = [
      "const pages = import.meta.glob('./pages/*.tsx');",
      "import { a } from './a';",
      "const url = 'https://example.com/x';",
      "import { b } from './b';",
      "const s = \"it's // not a comment\"; import { c } from './c';",
    ].join('\n');
    expect(scanTs(text)).toEqual(['./a', './b', './c']);
  });

  it('normalizes paths and refuses to climb out', () => {
    expect(normalizePath('a/b/../c/./d')).toBe('a/c/d');
    expect(normalizePath('../a')).toBeNull();
  });
});

describe('imports (#288): PHP', () => {
  it('reads class uses, grouped ones and aliases, not functions, constants or closures', () => {
    const text = [
      '<?php',
      'namespace App\\Retry;',
      'use App\\Clock\\Clock;',
      'use App\\Queue\\{DeadLetter, Job as QueueJob};',
      'use function App\\helpers\\f;',
      'use const App\\X;',
      '// use App\\Commented;',
      '$fn = function () use ($x) { return $x; };',
      'class Retry { use Backoff; }',
    ].join('\n');
    expect(scanPhp(text)).toEqual(['App\\Clock\\Clock', 'App\\Queue\\DeadLetter', 'App\\Queue\\Job', 'Backoff']);
  });

  it('resolves by the namespace’s tail, never by a bare name that two files share', () => {
    const index = phpIndex(['app/Clock/Clock.php', 'app/Queue/Job.php', 'tests/Queue/Job.php', 'app/Models/User.php', 'lib/User.php']);
    expect(resolvePhp('App\\Clock\\Clock', index)).toBe('app/Clock/Clock.php');
    // The longer match wins: app/Queue/Job.php over tests/Queue/Job.php.
    expect(resolvePhp('App\\Queue\\Job', index)).toBe('app/Queue/Job.php');
    // Two files match as well as each other: no arrow, not a guess.
    expect(resolvePhp('Other\\Queue\\Job', index)).toBeNull();
    // A namespace whose folder is not in the path: too weak.
    expect(resolvePhp('Vendor\\Thing\\User', index)).toBeNull();
    expect(resolvePhp('App\\Models\\User', index)).toBe('app/Models/User.php');
  });
});

describe('imports (#288): Rust', () => {
  it('reads mod declarations and crate-relative uses, not inline modules or external crates', () => {
    const text = [
      'mod retry;',
      'pub mod clock;',
      'mod tests { }',
      'use crate::queue::DeadLetter;',
      'use super::util::{a, b::C};',
      'use self::retry::Backoff as B;',
      'use serde::Deserialize;',
      'use std::{fs, io};',
    ].join('\n');
    expect(scanRust(text)).toEqual([
      { kind: 'mod', path: 'retry' },
      { kind: 'mod', path: 'clock' },
      { kind: 'use', path: 'crate::queue::DeadLetter' },
      { kind: 'use', path: 'super::util::a' },
      { kind: 'use', path: 'super::util::b::C' },
      { kind: 'use', path: 'self::retry::Backoff' },
    ]);
  });

  it('resolves through the module tree: x.rs or x/mod.rs, the longest module prefix', () => {
    const exists = has('src/lib.rs', 'src/retry.rs', 'src/queue/mod.rs', 'src/net/http.rs', 'src/net/mod.rs');
    expect(resolveRust('src/lib.rs', { kind: 'mod', path: 'retry' }, exists)).toBe('src/retry.rs');
    expect(resolveRust('src/lib.rs', { kind: 'mod', path: 'queue' }, exists)).toBe('src/queue/mod.rs');
    expect(resolveRust('src/net/mod.rs', { kind: 'mod', path: 'http' }, exists)).toBe('src/net/http.rs');
    expect(resolveRust('src/retry.rs', { kind: 'use', path: 'crate::queue::DeadLetter' }, exists)).toBe('src/queue/mod.rs');
    expect(resolveRust('src/net/http.rs', { kind: 'use', path: 'super::super::retry::Backoff' }, exists)).toBe('src/retry.rs');
    expect(resolveRust('src/retry.rs', { kind: 'use', path: 'crate::nothing::Here' }, exists)).toBeNull();
  });

  it('treats a binary in src/bin and build.rs as crate roots (#288 review)', () => {
    const exists = has('src/bin/tool.rs', 'src/bin/util.rs', 'src/util.rs', 'build.rs', 'gen.rs', 'src/lib.rs');
    expect(resolveRust('src/bin/tool.rs', { kind: 'mod', path: 'util' }, exists)).toBe('src/bin/util.rs');
    expect(resolveRust('src/bin/tool.rs', { kind: 'use', path: 'crate::util::f' }, exists)).toBe('src/bin/util.rs');
    expect(resolveRust('build.rs', { kind: 'mod', path: 'gen' }, exists)).toBe('gen.rs');
  });

  it('finds the crate root of a nested crate', () => {
    const exists = has('src-tauri/mcp/src/main.rs', 'src-tauri/mcp/src/tools.rs');
    expect(resolveRust('src-tauri/mcp/src/main.rs', { kind: 'use', path: 'crate::tools::run' }, exists)).toBe(
      'src-tauri/mcp/src/tools.rs',
    );
  });
});

describe('importGraph (#288)', () => {
  it('links changed files to each other and to tracked files, once per pair', () => {
    const g = importGraph(
      [
        { path: 'src/retry.ts', text: "import { b } from './backoff';\nimport { c } from './clock';\nimport { b2 } from './backoff';" },
        { path: 'src/backoff.ts', text: "import { c } from './clock';" },
        { path: 'README.md', text: '# hi' },
        { path: 'src/gone.ts', text: null },
      ],
      new Set(['src/clock.ts', 'src/other.ts']),
    );
    expect(g.edges).toEqual([
      ['src/retry.ts', 'src/backoff.ts'],
      ['src/retry.ts', 'src/clock.ts'],
      ['src/backoff.ts', 'src/clock.ts'],
    ]);
    expect([...g.scanned]).toEqual(['src/retry.ts', 'src/backoff.ts']);
    expect([...g.unsupported]).toEqual(['README.md']);
    expect([...g.unread]).toEqual(['src/gone.ts']);
    expect(g.skipped).toBeNull();
  });

  it('without the tracked files, finds imports between changed files only', () => {
    const g = importGraph(
      [
        { path: 'a.ts', text: "import './b';\nimport './c';" },
        { path: 'b.ts', text: '' },
      ],
      null,
    );
    expect(g.edges).toEqual([['a.ts', 'b.ts']]);
  });

  it('never points an import at a deleted file (#288 review)', () => {
    // foo.js deleted, foo.ts added: `./foo.js` is foo.ts.
    const ts = importGraph(
      [
        { path: 'src/foo.js', text: null, deleted: true },
        { path: 'src/foo.ts', text: '' },
        { path: 'src/main.ts', text: "import { f } from './foo.js';" },
      ],
      new Set(['src/foo.js', 'src/main.ts']),
    );
    expect(ts.edges).toEqual([['src/main.ts', 'src/foo.ts']]);
    // x.rs deleted, x/mod.rs added.
    const rs = importGraph(
      [
        { path: 'src/x.rs', text: null, deleted: true },
        { path: 'src/x/mod.rs', text: '' },
        { path: 'src/lib.rs', text: 'mod x;' },
      ],
      new Set(['src/x.rs', 'src/lib.rs']),
    );
    expect(rs.edges).toEqual([['src/lib.rs', 'src/x/mod.rs']]);
    // A PHP class moved: the deleted copy is no candidate, so no tie.
    const php = importGraph(
      [
        { path: 'old/Queue/Job.php', text: null, deleted: true },
        { path: 'app/Queue/Job.php', text: '<?php' },
        { path: 'app/Run.php', text: '<?php\nuse Queue\\Job;' },
      ],
      new Set(['old/Queue/Job.php', 'app/Run.php']),
    );
    expect(php.edges).toEqual([['app/Run.php', 'app/Queue/Job.php']]);
  });

  it('reads nothing for a change too large, and says so', () => {
    const files = Array.from({ length: MAX_SCAN_FILES + 1 }, (_, i) => ({ path: `f${i}.ts`, text: '' }));
    expect(importGraph(files, null)).toMatchObject({ edges: [], skipped: 'too-many' });
  });

  it('knows which languages it reads', () => {
    expect(['a.ts', 'a.tsx', 'a.mjs', 'a.vue', 'a.php', 'a.rs', 'a.d.ts', 'a.py', 'a.css'].map(languageOf)).toEqual([
      'ts',
      'ts',
      'ts',
      'ts',
      'php',
      'rust',
      null,
      null,
      null,
    ]);
  });
});
