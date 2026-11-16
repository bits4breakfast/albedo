import { describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import { carefulWhy, changedSince, cleanFlags, cleanNotes, MAX_FLAGS, NOTE_LINE_MAX_CHARS, NOTE_MAX_CHARS, normalizeId, validateProposal, viewGuide, type Guide } from './validate';

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

  it('after the diff moved on: says which files changed, drops gone blocks, keeps a changed hunk in its file\'s group (#248)', () => {
    const before = at([3, 30]);
    const guide = guideFor(before, [{ title: 'All', summary: '', blocks: [...before.order] }]);
    const after = at([3, 31]);
    const view = viewGuide(guide, after);
    expect(view.stale).toBe(true);
    expect(view.changedFiles).toEqual(['src/a.ts']);
    expect(changedSince(guide, after)).toEqual(['src/a.ts']);
    const [kept, fresh] = after.files[0]!.blocks;
    // Where the old hunk was, so the file reads as one; no Unsorted at all.
    expect(view.groups.map((g) => g.title)).toEqual(['All']);
    expect(view.groups[0]!.blocks).toEqual([kept, fresh, after.files[1]!.blocks[0]]);
    expect(view.groups[0]!.files.map((f) => [f.path, f.blocks])).toEqual([
      ['src/a.ts', [kept, fresh]],
      ['src/b.ts', after.files[1]!.blocks],
    ]);
  });

  it('a file whose every hunk changed stays in its group, with the new ones (#248)', () => {
    // The bug: the old block went, the new one went to Unsorted, and the group
    // -- left with only its unchanged, ticked files -- read Reviewed.
    const before = at([3]);
    const [a1, b1] = before.order;
    const guide = guideFor(before, [
      { title: 'A', summary: '', blocks: [a1!] },
      { title: 'B', summary: '', blocks: [b1!] },
    ]);
    const after = at([20]);
    const view = viewGuide(guide, after);
    expect(view.groups.map((g) => g.title)).toEqual(['A', 'B']);
    expect(view.groups[0]!.files.map((f) => [f.path, f.blocks])).toEqual([['src/a.ts', after.files[0]!.blocks]]);
    // A new content id, so its Reviewed key is new: unreviewed.
    expect(after.files[0]!.blocks).not.toEqual([a1]);
  });

  it('a file split across groups: an edited hunk stays in its own group, an added one joins its nearest neighbour\'s', () => {
    const before = at([3, 15, 35]);
    const [a1, a2, a3, b1] = before.order;
    const guide = guideFor(before, [
      { title: 'Top', summary: '', blocks: [a1!, b1!] },
      { title: 'Rest', summary: '', blocks: [a2!, a3!] },
    ]);
    // The first hunk edited (3 -> 4), one added after the second (25).
    const after = at([4, 15, 25, 35]);
    const [n1, k2, n3, k3] = after.files[0]!.blocks;
    expect([k2, k3]).toEqual([a2, a3]);
    expect(n1).not.toBe(a1);
    const view = viewGuide(guide, after);
    const top = view.groups.find((g) => g.title === 'Top')!;
    const rest = view.groups.find((g) => g.title === 'Rest')!;
    expect(top.files.map((f) => [f.path, f.blocks])).toEqual([
      ['src/a.ts', [n1]],
      ['src/b.ts', [b1]],
    ]);
    expect(rest.files.map((f) => [f.path, f.blocks])).toEqual([['src/a.ts', [k2, n3, k3]]]);
    expect(view.groups.some((g) => g.unsorted)).toBe(false);
  });

  it('Unsorted keeps a file new to the branch, and a block the guide saw and placed nowhere', () => {
    const before = at([3, 30]);
    const [a1, a2, b1] = before.order;
    const guide = guideFor(before, [{ title: 'One', summary: '', blocks: [a1!, b1!] }]);
    const after = buildBranchDiff([edited('src/a.ts', [3, 30]), edited('src/b.ts', [5]), edited('src/c.ts', [1])], statReason);
    const view = viewGuide(guide, after);
    const c1 = after.files.find((f) => f.path === 'src/c.ts')!.blocks[0];
    expect(view.groups.map((g) => g.title)).toEqual(['One', 'Unsorted']);
    expect(view.groups[1]!.blocks).toEqual([a2, c1]);
  });

  it('hides a group whose files are no longer in the change', () => {
    const before = at([3]);
    const guide = guideFor(before, [
      { title: 'Gone', summary: '', blocks: [before.order[0]!] },
      { title: 'B', summary: '', blocks: [before.order[1]!] },
    ]);
    const after = buildBranchDiff([edited('src/b.ts', [5])], statReason);
    expect(viewGuide(guide, after).groups.map((g) => g.title)).toEqual(['B']);
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

  const textsOf = (g: Guide) => viewGuide(g, diff).groups.map((x) => x.files.map((f) => [f.path, f.line, f.note]));

  it('a guide from before #264 (notes only) still shows its notes, with no short lines', () => {
    const stored = JSON.parse(JSON.stringify(guide([{ title: 'T', summary: '', blocks: [a, c], notes: { 'src/a.ts': 'Why a.' } }]))) as Guide;
    expect(textsOf(stored)).toEqual([
      [
        ['src/a.ts', null, 'Why a.'],
        ['src/c.ts', null, null],
      ],
      [['src/b.ts', null, null]],
    ]);
  });

  it('a new guide carries both the short line and the note through viewGuide (#264)', () => {
    const g = guide([
      { title: 'T', summary: '', blocks: [a, b, c], notes: { 'src/a.ts': 'Why a.' }, lines: { 'src/a.ts': 'Holds a', 'src/b.ts': 'too small', 'src/c.ts': 'Line only' } },
    ]);
    expect(textsOf(g)).toEqual([
      [
        ['src/a.ts', 'Holds a', 'Why a.'],
        // +1 -1: the rule allows it neither.
        ['src/b.ts', null, null],
        ['src/c.ts', 'Line only', null],
      ],
    ]);
    const odd = { title: 'T', summary: '', blocks: [a, c], lines: { 'src/a.ts': 7, 'src/c.ts': '' } } as unknown as Guide['groups'][number];
    expect(textsOf(guide([odd]))[0]).toEqual([
      ['src/a.ts', null, null],
      ['src/c.ts', null, null],
    ]);
  });
});

describe('cleanNotes', () => {
  it('cuts at the cap given, on one line, for allowed paths only', () => {
    const allowed = new Set(['a', 'b']);
    expect(cleanNotes([{ path: 'a', note: 'x'.repeat(NOTE_LINE_MAX_CHARS + 1) }, { path: 'b', note: ' one\n line ' }, { path: 'z', note: 'no' }], allowed, NOTE_LINE_MAX_CHARS)).toEqual({
      a: `${'x'.repeat(NOTE_LINE_MAX_CHARS - 1)}…`,
      b: 'one line',
    });
    expect(cleanNotes([{ path: 'a', note: 'x'.repeat(NOTE_LINE_MAX_CHARS) }], allowed, NOTE_LINE_MAX_CHARS).a).toHaveLength(NOTE_LINE_MAX_CHARS);
    // The default cap is still the note's.
    expect(cleanNotes([{ path: 'a', note: 'x'.repeat(NOTE_MAX_CHARS + 1) }], allowed).a).toHaveLength(NOTE_MAX_CHARS);
  });
});

describe('Set Aside and careful marks (#295)', () => {
  const focus = { setAside: ['**/*.test.*', '*.css'], careful: ['**/migrations/**'] };
  const diff = buildBranchDiff(
    [edited('src/a.ts', [3]), edited('src/a.test.ts', [3]), edited('src/db/migrations/1.sql', [3]), edited('src/x.css', [3])],
    statReason,
  );
  const id = (p: string) => diff.order.find((x) => diff.blocks.get(x)!.path === p)!;
  const base = (over: Partial<Guide> = {}): Guide => ({
    diffHash: diff.hash,
    writtenAt: 1,
    base: 'main',
    groups: [{ title: 'Code', summary: '', blocks: [id('src/a.ts')] }],
    files: fileBlockIndex(diff),
    fallback: null,
    focus,
    ...over,
  });

  it('puts set-aside files in their own group, after Unsorted, and never in Unsorted', () => {
    const view = viewGuide(base(), diff);
    expect(view.groups.map((g) => [g.title, g.unsorted, g.setAside])).toEqual([
      ['Code', false, false],
      ['Unsorted', true, false],
      ['Set Aside', false, true],
    ]);
    expect(view.groups[1]!.files.map((f) => f.path)).toEqual(['src/db/migrations/1.sql']);
    expect(view.groups[2]!.files.map((f) => f.path)).toEqual(['src/a.test.ts', 'src/x.css']);
    expect(view.groups[2]).toMatchObject({ key: 'set-aside', index: null });
  });

  it('a set-aside block a group somehow names is still set aside', () => {
    const view = viewGuide(base({ groups: [{ title: 'Code', summary: '', blocks: [id('src/a.ts'), id('src/x.css')] }] }), diff);
    expect(view.groups[0]!.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(view.groups.at(-1)!.files.map((f) => f.path)).toEqual(['src/a.test.ts', 'src/x.css']);
  });

  it('marks careful files by pattern and by the writer, with the reason in words', () => {
    const view = viewGuide(base({ flags: { 'src/a.ts': 'changes the session id written on restart' } }), diff);
    const all = view.groups.flatMap((g) => g.files);
    const of = (p: string) => all.find((f) => f.path === p)!.careful;
    expect(of('src/a.ts')).toEqual({ reason: 'changes the session id written on restart', pattern: null });
    expect(of('src/db/migrations/1.sql')).toEqual({ reason: null, pattern: '**/migrations/**' });
    expect(of('src/x.css')).toBeNull();
    expect(carefulWhy(of('src/a.ts')!)).toBe('changes the session id written on restart');
    expect(carefulWhy(of('src/db/migrations/1.sql')!)).toBe('Matches **/migrations/**');
  });

  it('a guide from before #295 sets nothing aside and marks nothing; a malformed focus or flags count as none', () => {
    const { focus: _f, ...old } = base();
    const view = viewGuide(old, diff);
    expect(view.groups.some((g) => g.setAside)).toBe(false);
    expect(view.groups.flatMap((g) => g.files).every((f) => f.careful === null)).toBe(true);
    const bad = viewGuide({ ...base(), focus: { setAside: 'x' } as unknown as Guide['focus'], flags: 'y' as unknown as Guide['flags'] }, diff);
    expect(bad.groups.some((g) => g.setAside)).toBe(false);
  });

  it('cleanFlags keeps allowed paths only, the first each, cut and capped', () => {
    const allowed = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
    const got = cleanFlags(
      [
        { path: 'zz', reason: 'unknown' },
        { path: 'a', reason: 'one' },
        { path: 'a', reason: 'again' },
        ...['b', 'c', 'd', 'e', 'f'].map((p) => ({ path: p, reason: p })),
      ],
      allowed,
    );
    expect(Object.keys(got)).toHaveLength(MAX_FLAGS);
    expect(got).toMatchObject({ a: 'one', b: 'b' });
    expect(got.f).toBeUndefined();
  });
});
