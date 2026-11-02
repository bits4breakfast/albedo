import { describe, expect, it } from 'vitest';
import { buildBranchDiff } from './blocks';
import {
  BLOCK_HEAD_LINES,
  BLOCK_MAX_LINES,
  BLOCK_TAIL_LINES,
  estimateTokens,
  groupByFolder,
  headTail,
  planInput,
  renderBlock,
  statReason,
  trimContext,
} from './budget';
import { changed, edited, lines, text } from './fixtures';

describe('statReason', () => {
  const small = changed('src/a.ts', 'a\n', 'b\n').result;
  it.each([
    ['package-lock.json', 'lockfile'],
    ['sub/dir/Cargo.lock', 'lockfile'],
    ['composer.lock', 'lockfile'],
    ['dist/app.js', 'generated'],
    ['src-tauri/gen/schemas/x.json', 'generated'],
    ['api/types.generated.ts', 'generated'],
    ['vendor/lib.min.js', 'generated'],
    ['public/app.min.js', 'minified'],
    ['public/app.js.map', 'minified'],
    ['src/a.ts', null],
  ])('%s -> %s', (path, want) => {
    expect(statReason(path, small)).toBe(want);
  });

  it('reads binary, too large, minified lines and a huge change from the diff', () => {
    expect(statReason('x.bin', changed('x.bin', 'a\0', 'b\0').result)).toBe('binary');
    expect(statReason('big.txt', { kind: 'too-large', change: 'modified', bytes: 9e6 })).toBe('too-large');
    expect(statReason('one.js', changed('one.js', 'a\n', `${'x'.repeat(1200)}\n`).result)).toBe('minified');
    expect(statReason('huge.ts', changed('huge.ts', null, text(lines(1600))).result)).toBe('huge');
  });
});

describe('what the model reads of a block', () => {
  it('keeps one line of context around the changes', () => {
    const diff = buildBranchDiff([edited('a.ts', [10])], statReason);
    const hunk = diff.files[0]!.result.kind === 'diff' ? diff.files[0]!.result.diff.hunks[0]! : null;
    const kept = trimContext(hunk!);
    expect(kept.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'context']);
  });

  it('cuts a long block to head and tail and says how much is missing', () => {
    const ls = lines(BLOCK_MAX_LINES + 30);
    const out = headTail(ls);
    expect(out).toHaveLength(BLOCK_HEAD_LINES + 1 + BLOCK_TAIL_LINES);
    expect(out[BLOCK_HEAD_LINES]).toBe(`… +${ls.length - BLOCK_HEAD_LINES - BLOCK_TAIL_LINES} lines …`);
    expect(out.at(-1)).toBe(ls.at(-1));
    expect(headTail(lines(5))).toEqual(lines(5));
  });

  it('renders a block with its id, path and lines, and a stat file as one line', () => {
    const diff = buildBranchDiff([edited('src/a.ts', [10]), changed('yarn.lock', 'a\n', 'b\n')], statReason);
    const [aId, lockId] = diff.order;
    const a = renderBlock(diff.blocks.get(aId!)!, diff);
    expect(a.split('\n')[0]).toMatch(new RegExp(`^\\[${aId}\\] src/a\\.ts @@`));
    expect(a).toContain('-line 10');
    expect(a).toContain('+line 10 edited');
    expect(renderBlock(diff.blocks.get(lockId!)!, diff)).toBe(`[${lockId}] yarn.lock (lockfile, stat only) +1 -1`);
  });
});

describe('planInput', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const texts = new Map(ids.map((id) => [id, 'x'.repeat(300)] as const)); // 100 tokens each

  it('sends everything at once when it fits', () => {
    expect(planInput(ids, texts, 1_000, 100)).toEqual({ kind: 'single', ids });
  });

  it('splits into batches within the budget when it does not', () => {
    const plan = planInput(ids, texts, 400, 100);
    expect(plan.kind).toBe('two-pass');
    if (plan.kind !== 'two-pass') return;
    expect(plan.batches.flat()).toEqual(ids);
    for (const b of plan.batches) expect(b.reduce((n, id) => n + estimateTokens(texts.get(id)!) + 1, 0)).toBeLessThanOrEqual(300);
  });

  it('falls back to folders, with a reason, when even one line per block is too much', () => {
    const many = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const plan = planInput(many, new Map(many.map((id) => [id, 'x'.repeat(300)] as const)), 1_000, 100);
    expect(plan).toMatchObject({ kind: 'folders' });
    if (plan.kind === 'folders') expect(plan.reason).toMatch(/50 changed blocks/);
  });

  it('groups by folder in path order', () => {
    const diff = buildBranchDiff([edited('src/a.ts', [1]), edited('README.md', [1]), edited('src/b.ts', [1])], statReason);
    expect(groupByFolder(diff).map((g) => [g.title, g.blocks.length])).toEqual([
      ['(root)', 1],
      ['src', 2],
    ]);
  });
});
