/**
 * All Guide Files (#413): every match in the guide's files, each listed once,
 * under the group whose diff shows it, in the guide's order.
 */
import { describe, expect, it } from 'vitest';
import { buildBranchDiff } from './blocks';
import { statReason } from './budget';
import { changed, edited, text } from './fixtures';
import { searchGuide } from './search';
import { viewGuide, type Guide } from './validate';

function setup() {
  // a.ts changes at 3 and 30 (two blocks, two groups); b.ts at 5.
  const diff = buildBranchDiff(
    [
      edited('src/a.ts', [3, 30], 'alpha'),
      edited('src/b.ts', [5], 'beta'),
      changed('src/gone.ts', text(['keep', 'old alpha line', 'keep']), text(['keep', 'keep'])),
    ],
    statReason,
  );
  const [a1, a2, b1, g1] = diff.order as [string, string, string, string];
  const guide: Guide = {
    diffHash: diff.hash,
    writtenAt: 1,
    base: 'base1',
    groups: [
      { title: 'Foundations', summary: '', blocks: [a2, b1] },
      { title: 'Wiring', summary: '', blocks: [a1, g1] },
    ],
    files: Object.fromEntries(diff.files.map((f) => [f.path, f.blocks])),
    fallback: null,
  } as unknown as Guide;
  return { diff, groups: viewGuide(guide, diff).groups };
}

describe('searchGuide', () => {
  it('lists each match once, under the group that shows its hunk, in the guide’s order', () => {
    const { diff, groups } = setup();
    const r = searchGuide(groups, diff, 'alpha');
    expect(r.groups.map((g) => [g.number, g.title, g.files.map((f) => [f.path, f.lines.map((l) => `${l.side}:${l.line}`)])])).toEqual([
      ['01', 'Foundations', [['src/a.ts', ['new:30']]]],
      [
        '02',
        'Wiring',
        [
          ['src/a.ts', ['new:3']],
          ['src/gone.ts', ['old:2']],
        ],
      ],
    ]);
    expect(r.total).toBe(3);
    expect(r.files).toBe(2);
  });

  it('puts an unchanged line outside every hunk under the first group the file is in', () => {
    const { diff, groups } = setup();
    // "line 15" is folded in a.ts; Foundations is a.ts's first group.
    const r = searchGuide(groups, diff, 'line 15');
    expect(r.groups.map((g) => g.title)).toEqual(['Foundations']);
    expect(r.groups[0]!.files.map((f) => [f.path, f.lines.map((l) => l.line)])).toEqual([
      ['src/a.ts', [15]],
      ['src/b.ts', [15]],
    ]);
  });

  it('keeps every match on a line together, and stops at the cap', () => {
    const { diff, groups } = setup();
    const one = searchGuide(groups, diff, 'a').groups[0]!.files[0]!.lines.find((l) => l.line === 30)!;
    expect(one.text).toBe('line 30 alpha');
    expect(one.hits.map((h) => h.start)).toEqual([8, 12]);
    const capped = searchGuide(groups, diff, 'line', 5);
    expect(capped.total).toBe(5);
    expect(capped.capped).toBe(true);
    expect(searchGuide(groups, diff, '').groups).toEqual([]);
  });

  it('is smart-case', () => {
    const { diff, groups } = setup();
    expect(searchGuide(groups, diff, 'ALPHA').total).toBe(0);
    expect(searchGuide(groups, diff, 'alpha').total).toBe(3);
  });

  it('leaves out a stat-only file (a lockfile), which This File still searches when open', () => {
    const diff = buildBranchDiff([edited('src/a.ts', [3], 'alpha'), edited('package-lock.json', [3], 'alpha')], statReason);
    const guide = {
      diffHash: diff.hash,
      writtenAt: 1,
      base: 'b',
      groups: [{ title: 'All', summary: '', blocks: [...diff.order] }],
      files: Object.fromEntries(diff.files.map((f) => [f.path, f.blocks])),
      fallback: null,
    } as unknown as Guide;
    const groups = viewGuide(guide, diff).groups;
    const r = searchGuide(groups, diff, 'alpha');
    expect(r.groups.flatMap((g) => g.files.map((f) => f.path))).toEqual(['src/a.ts']);
  });
});
