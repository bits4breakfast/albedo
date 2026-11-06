import { describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex, hunkSignature } from './blocks';
import { statReason } from './budget';
import { changed, edited, lines, text } from './fixtures';

describe('buildBranchDiff', () => {
  it('cuts each file into one block per hunk, with ids and Albedo’s own counts', () => {
    const diff = buildBranchDiff([edited('src/a.ts', [3, 30]), changed('src/new.ts', null, text(lines(4)))], statReason);
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/new.ts']);
    const a = diff.files[0]!;
    expect(a.blocks).toHaveLength(2);
    expect(a.added).toBe(2);
    expect(a.removed).toBe(2);
    for (const id of diff.order) expect(id).toMatch(/^[a-z0-9]{4,}$/);
    expect(new Set(diff.order).size).toBe(diff.order.length);
    const b = diff.blocks.get(diff.files[1]!.blocks[0]!)!;
    expect(b).toMatchObject({ path: 'src/new.ts', hunk: 0, added: 4, removed: 0, stat: null });
  });

  it('gives a block the same id when only another part of the file changed', () => {
    const one = buildBranchDiff([edited('src/a.ts', [3, 30])], statReason);
    const two = buildBranchDiff([edited('src/a.ts', [3, 31])], statReason);
    expect(two.files[0]!.blocks[0]).toBe(one.files[0]!.blocks[0]);
    expect(two.files[0]!.blocks[1]).not.toBe(one.files[0]!.blocks[1]);
    expect(two.hash).not.toBe(one.hash);
  });

  it('is deterministic: the same change, in any order, has the same ids and hash', () => {
    const files = [edited('b.ts', [5]), edited('a.ts', [5])];
    const x = buildBranchDiff(files, statReason);
    const y = buildBranchDiff([...files].reverse(), statReason);
    expect(y.order).toEqual(x.order);
    expect(y.hash).toBe(x.hash);
  });

  it('keeps ids unique when two blocks have the same content', () => {
    // Same path, same added line, twice: the signature collides.
    const before = lines(40);
    const after = [...before];
    after.splice(2, 0, 'dup');
    after.splice(35, 0, 'dup');
    const diff = buildBranchDiff([changed('x.ts', text(before), text(after))], statReason);
    const [first, second] = diff.files[0]!.blocks;
    expect(first).toMatch(/^[a-z0-9]{4}$/);
    expect(second).toBe(`${first}0`);
  });

  it('makes a stat-only file one block, so it still lands in exactly one group', () => {
    const lock = changed('package-lock.json', text(lines(40)), text(lines(40).map((l, i) => (i % 10 === 0 ? `${l}!` : l))));
    const diff = buildBranchDiff([lock], statReason);
    expect(diff.files[0]!.blocks).toHaveLength(1);
    expect(diff.blocks.get(diff.order[0]!)).toMatchObject({ hunk: null, stat: 'lockfile', added: 4, removed: 4 });
  });

  it('makes a binary file one block, and skips a file with no net change', () => {
    const diff = buildBranchDiff(
      [changed('img.png', 'a\0b', 'a\0c'), changed('same.ts', 'x\n', 'x\n')],
      statReason,
    );
    expect(diff.files.map((f) => f.path)).toEqual(['img.png']);
    expect(diff.blocks.get(diff.order[0]!)).toMatchObject({ stat: 'binary', hunk: null });
  });

  it('records each file’s block ids for "changed since"', () => {
    const diff = buildBranchDiff([edited('a.ts', [3])], statReason);
    expect(fileBlockIndex(diff)).toEqual({ 'a.ts': diff.order });
  });

  it('signs a hunk by its changed lines only', () => {
    const h = { header: '@@', lines: [
      { kind: 'context' as const, oldNumber: 1, newNumber: 1, content: 'ctx' },
      { kind: 'del' as const, oldNumber: 2, newNumber: null, content: 'old' },
      { kind: 'add' as const, oldNumber: null, newNumber: 2, content: 'new' },
    ] };
    expect(hunkSignature('p', h)).toBe('p\n-old\n+new');
  });
});
