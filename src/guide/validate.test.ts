import { describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import { changedSince, NOTE_MAX_CHARS, normalizeId, validateProposal, viewGuide, type Guide } from './validate';

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

describe('file notes (#202)', () => {
  const pathOf = new Map([
    ['aaaa', 'src/a.ts'],
    ['bbbb', 'src/b.ts'],
    ['cccc', 'src/c.ts'],
  ]);

  it('keeps a group’s notes only for its own files, the first per file, on one line and cut when long', () => {
    const v = validateProposal(
      {
        groups: [
          {
            title: 'One',
            summary: '',
            blocks: ['aaaa', 'bbbb'],
            notes: [
              { path: 'src/a.ts', note: '  reads the\n  page size ' },
              { path: 'src/a.ts', note: 'a second note' },
              { path: 'src/c.ts', note: 'not in this group' },
              { path: 'src/b.ts', note: 'x'.repeat(NOTE_MAX_CHARS + 20) },
              { path: 'src/zz.ts', note: 'no such file' },
            ],
          },
          { title: 'Two', summary: '', blocks: ['cccc'], notes: [{ path: 'src/c.ts', note: '   ' }] },
        ],
      },
      [...pathOf.keys()],
      pathOf,
    );
    expect(v.groups[0]!.notes).toEqual({ 'src/a.ts': 'reads the page size', 'src/b.ts': `${'x'.repeat(NOTE_MAX_CHARS - 1)}…` });
    // No note left: no notes field, so older guides and newer ones look alike.
    expect(v.groups[1]).toEqual({ title: 'Two', summary: '', blocks: ['cccc'] });
  });

  it('keeps none without the blocks’ paths', () => {
    const v = validateProposal({ groups: [{ title: 'T', summary: '', blocks: ['aaaa'], notes: [{ path: 'src/a.ts', note: 'n' }] }] }, ['aaaa']);
    expect(v.groups[0]).toEqual({ title: 'T', summary: '', blocks: ['aaaa'] });
  });

  // a.ts: 3 adjacent edited lines, one block of +3 -3. b.ts: +1 -1. c.ts: +3 -3.
  const diff = buildBranchDiff(
    [edited('src/a.ts', [3, 4, 5]), edited('src/b.ts', [5]), edited('src/c.ts', [10, 11, 12])],
    statReason,
  );
  const [a, b, c] = diff.order as [string, string, string];
  const guide = (groups: Guide['groups']): Guide => ({ diffHash: diff.hash, writtenAt: 1, base: 'main', groups, files: fileBlockIndex(diff), fallback: null });
  const notesOf = (g: Guide) => viewGuide(g, diff).groups.map((x) => x.files.map((f) => [f.path, f.note]));

  it('shows a note for a file with at least 5 changed lines in a group of several files', () => {
    const notes = { 'src/a.ts': 'the value object', 'src/b.ts': 'registers it', 'src/c.ts': 'alone' };
    expect(notesOf(guide([{ title: 'Two files', summary: '', blocks: [a, b], notes }, { title: 'One file', summary: '', blocks: [c], notes }]))).toEqual([
      // b.ts is +1 -1: its diff says it faster.
      [['src/a.ts', 'the value object'], ['src/b.ts', null]],
      // A one-file group's summary already says it.
      [['src/c.ts', null]],
    ]);
  });

  it('a guide from before notes, or a malformed one, shows none', () => {
    // b.ts, named by no group, is Unsorted: never a note there.
    const unsorted = [['src/b.ts', null]];
    expect(notesOf(guide([{ title: 'T', summary: '', blocks: [a, c] }]))).toEqual([[['src/a.ts', null], ['src/c.ts', null]], unsorted]);
    const odd = { title: 'T', summary: '', blocks: [a, c], notes: { 'src/a.ts': 7, 'src/c.ts': '' } } as unknown as Guide['groups'][number];
    expect(notesOf(guide([odd]))).toEqual([[['src/a.ts', null], ['src/c.ts', null]], unsorted]);
  });
});
