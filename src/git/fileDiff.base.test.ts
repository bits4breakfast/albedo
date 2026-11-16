/**
 * The base text a comment on removed lines is read against (#402, review of
 * #417): the merge base, or nothing -- never HEAD standing in for a base
 * that cannot be found.
 */
import { describe, expect, it, vi } from 'vitest';

const git = vi.hoisted(() => ({ merge: null as string | null, calls: [] as string[][] }));
vi.mock('./worktree', () => ({
  DIFF_NO_REFRESH: [],
  taskBase: vi.fn(async () => git.merge),
  gitOk: vi.fn(async (args: string[]) => {
    git.calls.push(args);
    return `100644 blob abc123 5\tsrc/a.ts\0`;
  }),
  git: vi.fn(async (args: string[]) => {
    git.calls.push(args);
    return { code: 0, stdout: 'base\n', stderr: '' };
  }),
}));

const { readTaskBaseText } = await import('./fileDiff');

describe('readTaskBaseText', () => {
  it('without a merge base: null, and git is not asked for HEAD', async () => {
    git.merge = null;
    git.calls.length = 0;
    expect(await readTaskBaseText('/wt', 'main', 'src/a.ts')).toBeNull();
    expect(git.calls).toEqual([]);
  });

  it('with one: the file at the merge base', async () => {
    git.merge = 'mergebase1';
    git.calls.length = 0;
    expect(await readTaskBaseText('/wt', 'main', 'src/a.ts')).toBe('base\n');
    expect(git.calls[0]).toEqual(['ls-tree', '-l', '-z', 'mergebase1', '--', 'src/a.ts']);
  });
});
