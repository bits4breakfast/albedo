import { describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import { changedSince, normalizeId, validateProposal, viewGuide, type Guide } from './validate';

describe('validateProposal', () => {
  const known = ['aaaa', 'bbbb', 'cccc', 'dddd'];

  it('drops unknown ids, keeps a duplicate in its first group, and sends the rest to Unsorted', () => {
    const v = validateProposal(
      {
        groups: [
          { title: 'One', summary: 's1', blocks: ['aaaa', 'zzzz', 'bbbb'] },
          { title: 'Two', summary: 's2', blocks: ['bbbb', 'cccc'] },
          { title: 'Empty', summary: 'only unknowns', blocks: ['yyyy'] },
        ],
      },
      known,
    );
    expect(v.groups).toEqual([
      { title: 'One', summary: 's1', blocks: ['aaaa', 'bbbb'] },
      { title: 'Two', summary: 's2', blocks: ['cccc'] },
    ]);
    expect(v.unknown).toEqual(['zzzz', 'yyyy']);
    expect(v.duplicates).toEqual(['bbbb']);
    expect(v.missing).toEqual(['dddd']);
  });

  it('reads an id the model decorated', () => {
    expect(normalizeId('[a1b2] src/x.ts')).toBe('a1b2');
    expect(normalizeId('A1B2 (src/x.ts): adds')).toBe('a1b2');
    expect(normalizeId('  "c3d4"')).toBe('c3d4');
    expect(normalizeId('')).toBe('');
  });
});

describe('viewGuide', () => {
  const at = (edits: number[]) => buildBranchDiff([edited('src/a.ts', edits), edited('src/b.ts', [5])], statReason);

  function guideFor(diff: ReturnType<typeof at>, groups: Guide['groups']): Guide {
    return { diffHash: diff.hash, writtenAt: 1, base: 'main', groups, files: fileBlockIndex(diff), fallback: null };
  }

  it('shows each group with its files and counts, and Unsorted last for what no group named', () => {
    const diff = at([3, 30]);
    const [a1, a2, b1] = diff.order;
    const view = viewGuide(guideFor(diff, [{ title: 'First', summary: 'S', blocks: [b1!, a2!] }]), diff);
    expect(view.stale).toBe(false);
    expect(view.groups.map((g) => g.title)).toEqual(['First', 'Unsorted']);
    const first = view.groups[0]!;
    // Files in the order the group names them; a file's blocks in file order.
    expect(first.files.map((f) => [f.path, f.blocks, f.totalBlocks, f.added, f.removed])).toEqual([
      ['src/b.ts', [b1], 1, 1, 1],
      ['src/a.ts', [a2], 2, 1, 1],
    ]);
    expect(view.groups[1]).toMatchObject({ unsorted: true, blocks: [a1] });
  });

  it('after the diff moved on: says which files changed, drops gone blocks, puts new ones in Unsorted', () => {
    const before = at([3, 30]);
    const guide = guideFor(before, [{ title: 'All', summary: '', blocks: [...before.order] }]);
    const after = at([3, 31]);
    const view = viewGuide(guide, after);
    expect(view.stale).toBe(true);
    expect(view.changedFiles).toEqual(['src/a.ts']);
    expect(changedSince(guide, after)).toEqual(['src/a.ts']);
    const [kept, fresh] = after.files[0]!.blocks;
    expect(view.groups[0]!.blocks).toEqual([kept, after.files[1]!.blocks[0]]);
    expect(view.groups[1]).toMatchObject({ title: 'Unsorted', blocks: [fresh] });
  });

  it('hides a group none of whose blocks exist any more', () => {
    const before = at([3]);
    const guide = guideFor(before, [{ title: 'Gone', summary: '', blocks: [before.order[0]!] }]);
    const after = at([20]);
    expect(viewGuide(guide, after).groups.map((g) => g.title)).toEqual(['Unsorted']);
  });
});
