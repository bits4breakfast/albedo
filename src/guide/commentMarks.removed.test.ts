import { describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex } from './blocks';
import { statReason } from './budget';
import { changed, lines, text } from './fixtures';
import { commentMarks } from './commentMarks';
import { viewGuide, type Guide } from './validate';

// src/a.ts loses lines 3-12 and line 30: two hunks, whose old-side numbers
// run well past their new-side ones.
const before = lines(40);
const after = before.filter((_, i) => !(i + 1 >= 3 && i + 1 <= 12) && i + 1 !== 30);
const diff = buildBranchDiff([changed('src/a.ts', text(before), text(after))], statReason);
const [a1, a2] = diff.order as [string, string];
const guide = (groups: Guide['groups']): Guide => ({ diffHash: diff.hash, writtenAt: 1, base: 'main', groups, files: fileBlockIndex(diff), fallback: null });

describe('commentMarks, comments on removed lines (#402)', () => {
  it('a file split across groups: measured on the old side, by the base line', () => {
    const { groups } = viewGuide(
      guide([
        { title: 'Top', summary: '', blocks: [a1] },
        { title: 'Bottom', summary: '', blocks: [a2] },
      ]),
      diff,
    );
    const [top, bottom] = groups.map((g) => g.key) as [string, string];
    // Base line 12 is in the first hunk; on the new side's numbers it would be nearer the second.
    const marks = commentMarks(groups, diff, [
      { path: 'src/a.ts', lineStart: 12, anchorText: 'line 12', resolvedAt: null, side: 'old' },
      { path: 'src/a.ts', lineStart: 30, anchorText: 'line 30', resolvedAt: null, side: 'old' },
    ]);
    expect(marks.get(top)?.get('src/a.ts')).toEqual({ toSend: 1, drafts: 0 });
    expect(marks.get(bottom)?.get('src/a.ts')).toEqual({ toSend: 1, drafts: 0 });
  });
});
