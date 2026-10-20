import { describe, expect, it } from 'vitest';
import { diffStrings, langForPath, parseUnifiedDiff } from './diff';
import type { DiffLine, FileDiff } from '../types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const allLines = (d: FileDiff): DiffLine[] => d.hunks.flatMap((h) => h.lines);

/** Compact rendering of a diff, one line per entry: "+foo" / "-foo" / " foo". */
const render = (d: FileDiff): string[] =>
  allLines(d).map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'meta' ? '!' : ' ') + l.content);

const seg = (l: DiffLine | undefined) => (l?.segments ?? []).map((s) => (s.changed ? `[${s.text}]` : s.text)).join('');

/** Reconstructing the new file from context+add lines must return newText. */
function reconstruct(d: FileDiff, side: 'old' | 'new'): string[] {
  const keep = side === 'old' ? ['context', 'del'] : ['context', 'add'];
  return allLines(d)
    .filter((l) => keep.includes(l.kind))
    .map((l) => l.content);
}

// ---------------------------------------------------------------------------
// diffStrings -- line level
// ---------------------------------------------------------------------------

describe('diffStrings / line level', () => {
  it('returns no hunks for identical input', () => {
    const d = diffStrings('a\nb\nc\n', 'a\nb\nc\n', 'x.ts');
    expect(d.hunks).toEqual([]);
    expect(d.path).toBe('x.ts');
    expect(d.lang).toBe('typescript');
  });

  it('handles an empty old side as all additions', () => {
    const d = diffStrings('', 'one\ntwo\n', 'new.ts');
    expect(render(d)).toEqual(['+one', '+two']);
    expect(allLines(d).map((l) => l.newNumber)).toEqual([1, 2]);
    expect(allLines(d).every((l) => l.oldNumber === null)).toBe(true);
  });

  it('handles an empty new side as all deletions', () => {
    const d = diffStrings('one\ntwo\n', '', 'gone.ts');
    expect(render(d)).toEqual(['-one', '-two']);
  });

  it('detects a single changed line in the middle', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const newText = ['a', 'b', 'C', 'd', 'e'].join('\n');
    const d = diffStrings(oldText, newText, 'f.txt');
    expect(render(d)).toEqual([' a', ' b', '-c', '+C', ' d', ' e']);
  });

  it('finds a minimal edit script rather than replacing the whole body', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const newText = 'a\nb\nc\nX\nd\ne\nf\ng\nh\n';
    const d = diffStrings(oldText, newText, 'f.txt');
    const changed = allLines(d).filter((l) => l.kind !== 'context');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.kind).toBe('add');
    expect(changed[0]?.content).toBe('X');
  });

  it('interleaves deletions and insertions correctly', () => {
    const d = diffStrings('a\nb\nc\n', 'b\nc\nd\n', 'f.txt');
    expect(render(d)).toEqual(['-a', ' b', ' c', '+d']);
  });

  it('numbers old and new lines independently', () => {
    const d = diffStrings('a\nb\nc\n', 'a\nX\nY\nc\n', 'f.txt');
    const lines = allLines(d);
    expect(lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ]);
  });

  it('round-trips: hunk lines rebuild both sides when the file is small', () => {
    const oldText = 'alpha\nbeta\ngamma\ndelta\n';
    const newText = 'alpha\nBETA\ngamma\nepsilon\ndelta\n';
    const d = diffStrings(oldText, newText, 'f.txt');
    expect(reconstruct(d, 'old')).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(reconstruct(d, 'new')).toEqual(['alpha', 'BETA', 'gamma', 'epsilon', 'delta']);
  });

  it('treats a trailing newline as a file terminator, not an empty line', () => {
    const d = diffStrings('a\n', 'a', 'f.txt');
    expect(d.hunks).toEqual([]);
  });

  it('normalises CRLF so line endings alone are not a diff', () => {
    const d = diffStrings('a\r\nb\r\n', 'a\nb\n', 'f.txt');
    expect(d.hunks).toEqual([]);
  });

  it('survives a large, wholly different input without hanging', () => {
    const oldText = Array.from({ length: 4000 }, (_, i) => `old line ${i}`).join('\n');
    const newText = Array.from({ length: 4000 }, (_, i) => `new line ${i} !`).join('\n');
    const started = Date.now();
    const d = diffStrings(oldText, newText, 'big.txt');
    expect(Date.now() - started).toBeLessThan(10_000);
    const lines = allLines(d);
    expect(lines.filter((l) => l.kind === 'del')).toHaveLength(4000);
    expect(lines.filter((l) => l.kind === 'add')).toHaveLength(4000);
  });

  it('diffs a realistic source edit precisely', () => {
    const before = [
      'export function greet(name: string) {',
      '  const greeting = "hello";',
      '  return greeting + name;',
      '}',
    ].join('\n');
    const after = [
      'export function greet(name: string): string {',
      '  const greeting = "hello, ";',
      '  return greeting + name;',
      '}',
    ].join('\n');
    const d = diffStrings(before, after, 'greet.ts');
    expect(render(d)).toEqual([
      '-export function greet(name: string) {',
      '-  const greeting = "hello";',
      '+export function greet(name: string): string {',
      '+  const greeting = "hello, ";',
      '   return greeting + name;',
      ' }',
    ]);
  });
});

// ---------------------------------------------------------------------------
// diffStrings -- word level
// ---------------------------------------------------------------------------

describe('diffStrings / word-level segments', () => {
  it('marks only the words that changed', () => {
    const d = diffStrings('const a = 1;\n', 'const a = 2;\n', 'f.ts');
    const lines = allLines(d);
    const del = lines.find((l) => l.kind === 'del');
    const add = lines.find((l) => l.kind === 'add');
    expect(seg(del)).toBe('const a = [1];');
    expect(seg(add)).toBe('const a = [2];');
  });

  it('segments concatenate back to the full line content', () => {
    const d = diffStrings('foo(bar, baz)\n', 'foo(qux, baz, extra)\n', 'f.ts');
    for (const l of allLines(d)) {
      if (!l.segments) continue;
      expect(l.segments.map((s) => s.text).join('')).toBe(l.content);
    }
  });

  it('marks an inserted word without touching the rest of the line', () => {
    const d = diffStrings('return greeting + name;\n', 'return greeting + " " + name;\n', 'f.ts');
    const add = allLines(d).find((l) => l.kind === 'add');
    expect(seg(add)).toBe('return greeting + [" " + ]name;');
  });

  it('collapses a wholesale rewrite into one changed segment', () => {
    const d = diffStrings('alpha beta gamma\n', 'zebra!!!\n', 'f.txt');
    const del = allLines(d).find((l) => l.kind === 'del');
    const add = allLines(d).find((l) => l.kind === 'add');
    expect(del?.segments).toEqual([{ text: 'alpha beta gamma', changed: true }]);
    expect(add?.segments).toEqual([{ text: 'zebra!!!', changed: true }]);
  });

  it('leaves context lines unsegmented', () => {
    const d = diffStrings('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
    for (const l of allLines(d)) {
      if (l.kind === 'context') expect(l.segments).toBeUndefined();
    }
  });

  it('pairs deletions with insertions positionally inside a change block', () => {
    const d = diffStrings('one 1\ntwo 2\n', 'one 9\ntwo 8\n', 'f.txt');
    const dels = allLines(d).filter((l) => l.kind === 'del');
    const adds = allLines(d).filter((l) => l.kind === 'add');
    expect(seg(dels[0])).toBe('one [1]');
    expect(seg(adds[0])).toBe('one [9]');
    expect(seg(dels[1])).toBe('two [2]');
    expect(seg(adds[1])).toBe('two [8]');
  });

  it('does not segment an unpaired extra insertion', () => {
    const d = diffStrings('one\n', 'one!\ntwo\n', 'f.txt');
    const adds = allLines(d).filter((l) => l.kind === 'add');
    expect(adds).toHaveLength(2);
    expect(adds[1]?.segments).toBeUndefined();
  });

  it('highlights indentation-only changes', () => {
    const d = diffStrings('  x = 1\n', '    x = 1\n', 'f.py');
    const add = allLines(d).find((l) => l.kind === 'add');
    expect(add?.segments?.some((s) => s.changed)).toBe(true);
    expect(add?.segments?.map((s) => s.text).join('')).toBe('    x = 1');
  });
});

// ---------------------------------------------------------------------------
// hunk grouping
// ---------------------------------------------------------------------------

describe('diffStrings / hunks', () => {
  const numbered = (n: number, marker?: { at: number; text: string }) =>
    Array.from({ length: n }, (_, i) => (marker && marker.at === i ? marker.text : `line ${i}`)).join('\n');

  it('keeps three lines of context around a change', () => {
    const oldText = numbered(40);
    const newText = numbered(40, { at: 20, text: 'CHANGED' });
    const d = diffStrings(oldText, newText, 'f.txt');
    expect(d.hunks).toHaveLength(1);
    const lines = d.hunks[0]?.lines ?? [];
    expect(lines.filter((l) => l.kind === 'context')).toHaveLength(6);
    expect(lines[0]?.content).toBe('line 17');
    expect(lines[lines.length - 1]?.content).toBe('line 23');
  });

  it('emits a git-style hunk header', () => {
    const oldText = numbered(40);
    const newText = numbered(40, { at: 20, text: 'CHANGED' });
    const d = diffStrings(oldText, newText, 'f.txt');
    expect(d.hunks[0]?.header).toBe('@@ -18,7 +18,7 @@');
  });

  it('splits distant changes into separate hunks', () => {
    const arr = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const next = [...arr];
    next[5] = 'FIVE';
    next[50] = 'FIFTY';
    const d = diffStrings(arr.join('\n'), next.join('\n'), 'f.txt');
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]?.lines.some((l) => l.content === 'FIVE')).toBe(true);
    expect(d.hunks[1]?.lines.some((l) => l.content === 'FIFTY')).toBe(true);
  });

  it('merges changes whose context regions touch', () => {
    const arr = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const next = [...arr];
    next[10] = 'TEN';
    next[14] = 'FOURTEEN';
    const d = diffStrings(arr.join('\n'), next.join('\n'), 'f.txt');
    expect(d.hunks).toHaveLength(1);
  });

  it('uses a single-number range when a side contributes one line', () => {
    const d = diffStrings('a\nb\nc\n', 'a\nb\nc\nd\n', 'f.txt');
    expect(d.hunks[0]?.header).toBe('@@ -1,3 +1,4 @@');
  });

  it('omits unchanged regions entirely so the pane can collapse them', () => {
    const arr = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const next = [...arr];
    next[100] = 'HUNDRED';
    const d = diffStrings(arr.join('\n'), next.join('\n'), 'f.txt');
    expect(allLines(d)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// parseUnifiedDiff
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff', () => {
  it('returns [] for empty and whitespace input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n\n  \n')).toEqual([]);
  });

  it('returns [] for arbitrary garbage', () => {
    expect(parseUnifiedDiff('this is not a diff at all\njust some words')).toEqual([]);
    expect(parseUnifiedDiff('{"json": true}')).toEqual([]);
    expect(parseUnifiedDiff('@@ broken @@\n+++ nope')).toEqual([]);
  });

  it('never throws on hostile input', () => {
    const hostile = [
      'diff --git',
      'diff --git a/x',
      'diff --git a/x b/x\n@@',
      'diff --git a/x b/x\n@@ -1,2 +1,2 @@\n+only one line',
      '--- \n+++ \n@@ -0,0 +0,0 @@',
      '@@ -1,1 +1,1 @@\n-a\n+b',
      'diff --git a/x b/x\nindex 111..222\n',
      '\\ No newline at end of file',
    ];
    for (const h of hostile) {
      expect(() => parseUnifiedDiff(h)).not.toThrow();
      expect(Array.isArray(parseUnifiedDiff(h))).toBe(true);
    }
  });

  it('parses a single-file git diff', () => {
    const text = [
      'diff --git a/src/lib/diff.ts b/src/lib/diff.ts',
      'index 83db48f..bf269f4 100644',
      '--- a/src/lib/diff.ts',
      '+++ b/src/lib/diff.ts',
      '@@ -10,5 +10,5 @@ export function langForPath(path: string) {',
      '   const ext = path.split(".").pop();',
      '   if (!ext) return "text";',
      '-  return MAP[ext] || "text";',
      '+  return MAP[ext] ?? "text";',
      '   // end',
      ' }',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('src/lib/diff.ts');
    expect(f.lang).toBe('typescript');
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]?.header).toBe('@@ -10,5 +10,5 @@ export function langForPath(path: string) {');
    expect(render(f)).toEqual([
      '   const ext = path.split(".").pop();',
      '   if (!ext) return "text";',
      '-  return MAP[ext] || "text";',
      '+  return MAP[ext] ?? "text";',
      '   // end',
      ' }',
    ]);
  });

  it('assigns line numbers from the hunk header', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -10,3 +20,4 @@',
      ' keep',
      '-drop',
      '+take',
      '+extra',
      ' tail',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.hunks[0]?.lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 10, 20],
      ['del', 11, null],
      ['add', null, 21],
      ['add', null, 22],
      ['context', 12, 23],
    ]);
  });

  it('refines words inside parsed hunks too', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-const timeout = 1000;',
      '+const timeout = 5000;',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    const del = f.hunks[0]?.lines[0];
    const add = f.hunks[0]?.lines[1];
    expect(seg(del)).toBe('const timeout = [1000];');
    expect(seg(add)).toBe('const timeout = [5000];');
  });

  it('parses multiple files and multiple hunks per file', () => {
    const text = [
      'diff --git a/one.ts b/one.ts',
      'index 1111111..2222222 100644',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -20,3 +20,3 @@ section heading here',
      ' x',
      '-y',
      '+Y',
      ' z',
      'diff --git a/two.py b/two.py',
      'index 3333333..4444444 100644',
      '--- a/two.py',
      '+++ b/two.py',
      '@@ -5,2 +5,3 @@',
      ' def f():',
      '+    pass',
      ' # done',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['one.ts', 'two.py']);
    expect(files[0]?.hunks).toHaveLength(2);
    expect(files[0]?.hunks[1]?.header).toContain('section heading here');
    expect(files[1]?.lang).toBe('python');
    expect(files[1]?.hunks[0]?.lines.filter((l) => l.kind === 'add')).toHaveLength(1);
  });

  it('parses a new file (--- /dev/null)', () => {
    const text = [
      'diff --git a/fresh.rs b/fresh.rs',
      'new file mode 100644',
      'index 0000000..abcdef1',
      '--- /dev/null',
      '+++ b/fresh.rs',
      '@@ -0,0 +1,2 @@',
      '+fn main() {}',
      '+// hi',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.path).toBe('fresh.rs');
    expect(f.lang).toBe('rust');
    expect(f.hunks[0]?.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(f.hunks[0]?.lines.map((l) => l.newNumber)).toEqual([1, 2]);
  });

  it('parses a deleted file (+++ /dev/null)', () => {
    const text = [
      'diff --git a/old.go b/old.go',
      'deleted file mode 100644',
      'index abcdef1..0000000',
      '--- a/old.go',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-package main',
      '-// bye',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.path).toBe('old.go');
    expect(f.lang).toBe('go');
    expect(f.hunks[0]?.lines.every((l) => l.kind === 'del')).toBe(true);
  });

  it('handles "\\ No newline at end of file"', () => {
    const text = [
      'diff --git a/n.txt b/n.txt',
      '--- a/n.txt',
      '+++ b/n.txt',
      '@@ -1,2 +1,2 @@',
      ' first',
      '-second',
      '\\ No newline at end of file',
      '+second!',
      '\\ No newline at end of file',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(render(f)).toEqual([' first', '-second', '+second!']);
  });

  it('handles a pure rename with no content change', () => {
    const text = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 100%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/old-name.ts → src/new-name.ts');
    expect(files[0]?.lang).toBe('typescript');
    expect(files[0]?.hunks).toEqual([]);
  });

  it('handles a rename with edits', () => {
    const text = [
      'diff --git a/a.js b/b.js',
      'similarity index 88%',
      'rename from a.js',
      'rename to b.js',
      'index 1111111..2222222 100644',
      '--- a/a.js',
      '+++ b/b.js',
      '@@ -1,2 +1,2 @@',
      '-var x = 1;',
      '+let x = 1;',
      ' export default x;',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.path).toBe('a.js → b.js');
    expect(f.lang).toBe('javascript');
    expect(f.hunks[0]?.lines).toHaveLength(3);
  });

  it('handles a binary file stanza without hunks', () => {
    const text = [
      'diff --git a/img/logo.png b/img/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/img/logo.png and b/img/logo.png differ',
      'diff --git a/after.ts b/after.ts',
      '--- a/after.ts',
      '+++ b/after.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['img/logo.png', 'after.ts']);
    expect(files[0]?.hunks[0]?.lines[0]?.kind).toBe('meta');
    expect(files[1]?.hunks[0]?.lines).toHaveLength(2);
  });

  it('handles a GIT binary patch payload', () => {
    const text = [
      'diff --git a/blob.bin b/blob.bin',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 12',
      'zcmZQzU|?1i',
      '',
      'literal 0',
      'HcmV?d00001',
      '',
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['blob.bin', 'x.txt']);
    expect(files[0]?.hunks[0]?.lines[0]?.kind).toBe('meta');
  });

  it('handles a mode-only change with no hunks', () => {
    const text = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/z.txt b/z.txt',
      '--- a/z.txt',
      '+++ b/z.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['run.sh', 'z.txt']);
    expect(files[0]?.hunks).toEqual([]);
  });

  it('ignores shell noise around the diff', () => {
    const text = [
      '$ git diff',
      'warning: LF will be replaced by CRLF',
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
      'Done. 1 file changed, 1 insertion(+), 1 deletion(-)',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(render(files[0]!)).toEqual(['-a', '+b']);
  });

  it('parses a plain (non-git) unified diff with timestamps', () => {
    const text = [
      '--- old/config.yml\t2024-01-01 10:00:00.000000000 +0000',
      '+++ new/config.yml\t2024-01-02 11:00:00.000000000 +0000',
      '@@ -1,3 +1,3 @@',
      ' key: value',
      '-port: 8080',
      '+port: 9090',
      ' other: 1',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('new/config.yml');
    expect(files[0]?.lang).toBe('yaml');
  });

  it('handles quoted paths containing spaces', () => {
    const text = [
      'diff --git "a/my dir/file name.ts" "b/my dir/file name.ts"',
      '--- "a/my dir/file name.ts"',
      '+++ "b/my dir/file name.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.path).toBe('my dir/file name.ts');
  });

  it('accepts CRLF-terminated diff text', () => {
    const text = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+b'].join('\r\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(render(f)).toEqual(['-a', '+b']);
  });

  it('treats a bare empty line inside a hunk as empty context', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' first',
      '',
      '-third',
      '+THIRD',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.hunks[0]?.lines.map((l) => l.kind)).toEqual(['context', 'context', 'del', 'add']);
  });

  it('stops a hunk at its declared length and does not swallow trailing output', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '-this line is outside the hunk',
    ].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.hunks[0]?.lines).toHaveLength(2);
  });

  it('handles a hunk header with implicit single-line counts', () => {
    const text = ['--- a/a.txt', '+++ b/a.txt', '@@ -7 +7 @@', '-a', '+b'].join('\n');
    const f = parseUnifiedDiff(text)[0]!;
    expect(f.hunks[0]?.lines.map((l) => [l.oldNumber, l.newNumber])).toEqual([
      [7, null],
      [null, 7],
    ]);
  });
});

// ---------------------------------------------------------------------------
// langForPath
// ---------------------------------------------------------------------------

describe('langForPath', () => {
  it('maps common extensions', () => {
    expect(langForPath('src/a.ts')).toBe('typescript');
    expect(langForPath('src/a.tsx')).toBe('tsx');
    expect(langForPath('a.js')).toBe('javascript');
    expect(langForPath('a.py')).toBe('python');
    expect(langForPath('a.rs')).toBe('rust');
    expect(langForPath('a.go')).toBe('go');
    expect(langForPath('a.json')).toBe('json');
    expect(langForPath('a.css')).toBe('css');
    expect(langForPath('a.md')).toBe('markdown');
    expect(langForPath('deploy.sh')).toBe('shellscript');
    expect(langForPath('a.yml')).toBe('yaml');
  });

  it('is case-insensitive', () => {
    expect(langForPath('/abs/path/README.MD')).toBe('markdown');
    expect(langForPath('A.TS')).toBe('typescript');
  });

  it('recognises extensionless well-known names', () => {
    expect(langForPath('Dockerfile')).toBe('docker');
    expect(langForPath('deploy/Makefile')).toBe('makefile');
  });

  it('falls back to text for unknown or missing extensions', () => {
    expect(langForPath('a.wat')).toBe('text');
    expect(langForPath('noextension')).toBe('text');
    expect(langForPath('')).toBe('text');
    expect(langForPath('weird.name.with.dots.zzz')).toBe('text');
  });

  it('uses the destination side of a rename header', () => {
    expect(langForPath('old.txt → new.py')).toBe('python');
  });

  it('handles windows separators', () => {
    expect(langForPath('C:\\src\\app.tsx')).toBe('tsx');
  });
});
