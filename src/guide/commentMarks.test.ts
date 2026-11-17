import { describe, expect, it } from 'vitest';
import { buildBranchDiff, fileBlockIndex } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import { commentMarks, groupComments } from './commentMarks';
import { viewGuide, type Guide } from './validate';

// src/a.ts edited at lines 3 and 30 (two hunks), src/b.ts at 5.
const diff = buildBranchDiff([edited('src/a.ts', [3, 30]), edited('src/b.ts', [5])], statReason);
const [a1, a2, b1] = diff.order as [string, string, string];
const guide = (groups: Guide['groups']): Guide => ({ diffHash: diff.hash, writtenAt: 1, base: 'main', groups, files: fileBlockIndex(diff), fallback: null });
const at = (path: string, line: number, extra: { resolvedAt?: number | null; anchorText?: string } = {}) => ({
  path,
  lineStart: line,
  anchorText: extra.anchorText ?? `line ${line}${path === 'src/a.ts' && (line === 3 || line === 30) ? ' edited' : ''}`,
  resolvedAt: extra.resolvedAt ?? null,
});

describe('commentMarks (#252)', () => {
  it('counts each open comment once, on its file in the group showing it', () => {
    const { groups } = viewGuide(guide([{ title: 'All', summary: '', blocks: [a1, a2, b1] }]), diff);
    const marks = commentMarks(groups, diff, [at('src/a.ts', 3), at('src/a.ts', 30), at('src/b.ts', 1)]);
    const key = groups[0]!.key;
    expect(marks.get(key)?.get('src/a.ts')).toEqual({ toSend: 2, drafts: 0 });
    expect(marks.get(key)?.get('src/b.ts')).toEqual({ toSend: 1, drafts: 0 });
    expect(groupComments(marks, key)).toEqual({ toSend: 3, drafts: 0 });
  });

  it('a resolved comment, or one on a file no group shows, counts nowhere', () => {
    const { groups } = viewGuide(guide([{ title: 'B', summary: '', blocks: [b1] }, { title: 'A', summary: '', blocks: [a1, a2] }]), diff);
    const marks = commentMarks(groups, diff, [at('src/b.ts', 5, { resolvedAt: 9 }), at('src/zz.ts', 1)]);
    expect([...marks.keys()]).toEqual([]);
  });

  it('a file split across groups: the group whose hunks are nearest the comment', () => {
    const { groups } = viewGuide(
      guide([
        { title: 'Top', summary: '', blocks: [a1, b1] },
        { title: 'Bottom', summary: '', blocks: [a2] },
      ]),
      diff,
    );
    const [top, bottom] = groups.map((g) => g.key) as [string, string];
    // On the second hunk's line; then a context line nearer the first; then nearer the second.
    const marks = commentMarks(groups, diff, [at('src/a.ts', 30), at('src/a.ts', 9), at('src/a.ts', 24)]);
    expect(marks.get(top)?.get('src/a.ts')).toEqual({ toSend: 1, drafts: 0 });
    expect(marks.get(bottom)?.get('src/a.ts')).toEqual({ toSend: 2, drafts: 0 });
    expect(groupComments(marks, top)).toEqual({ toSend: 1, drafts: 0 });
  });

  it('GitHub Drafts count beside To Send, apart, placed the same way (#440)', () => {
    const { groups } = viewGuide(
      guide([
        { title: 'Top', summary: '', blocks: [a1, b1] },
        { title: 'Bottom', summary: '', blocks: [a2] },
      ]),
      diff,
    );
    const [top, bottom] = groups.map((g) => g.key) as [string, string];
    const marks = commentMarks(
      groups,
      diff,
      [at('src/b.ts', 5)],
      // One beside it, one on the split file's second hunk, one resolved (never counted).
      [at('src/b.ts', 5), at('src/a.ts', 30), at('src/a.ts', 3, { resolvedAt: 9 })],
    );
    expect(marks.get(top)?.get('src/b.ts')).toEqual({ toSend: 1, drafts: 1 });
    expect(marks.get(top)?.get('src/a.ts')).toBeUndefined();
    expect(marks.get(bottom)?.get('src/a.ts')).toEqual({ toSend: 0, drafts: 1 });
    expect(groupComments(marks, top)).toEqual({ toSend: 1, drafts: 1 });
    expect(groupComments(marks, 'nowhere')).toEqual({ toSend: 0, drafts: 0 });
  });
});
