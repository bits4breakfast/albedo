/**
 * All Guide Files (#413) splits each file's texts into lines once per read
 * of the branch, not once per search: typing a query searches every file
 * again, and splitting a large file each time is most of that work.
 */
import { describe, expect, it, vi } from 'vitest';

const split = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../ui/transcript/codeTokens', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ui/transcript/codeTokens')>();
  return {
    ...real,
    sourceLines: (text: string) => {
      split.calls++;
      return real.sourceLines(text);
    },
  };
});

const { buildBranchDiff } = await import('./blocks');
const { statReason } = await import('./budget');
const { edited } = await import('./fixtures');
const { searchGuide } = await import('./search');
const { viewGuide } = await import('./validate');
type Guide = import('./validate').Guide;

describe('searchGuide', () => {
  it('splits each file into lines once, however many searches follow', () => {
    const diff = buildBranchDiff([edited('src/a.ts', [3], 'alpha'), edited('src/b.ts', [5], 'beta')], statReason);
    const guide = {
      diffHash: diff.hash,
      writtenAt: 1,
      base: 'b',
      groups: [{ title: 'All', summary: '', blocks: [...diff.order] }],
      files: Object.fromEntries(diff.files.map((f) => [f.path, f.blocks])),
      fallback: null,
    } as unknown as Guide;
    const groups = viewGuide(guide, diff).groups;
    split.calls = 0;
    searchGuide(groups, diff, 'a');
    const once = split.calls;
    expect(once).toBe(4); // two files, two sides
    searchGuide(groups, diff, 'al');
    searchGuide(groups, diff, 'alp');
    expect(split.calls).toBe(once);
  });
});
