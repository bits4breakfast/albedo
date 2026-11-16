/**
 * Submit Review's read of the drafts (#402): a draft on removed lines is
 * found again by its text in the file at the PR's merge base and goes on
 * GitHub's left side there; one whose text the base no longer has, or whose
 * lines are back at HEAD, goes in the summary. A draft on the file now is
 * found at HEAD, as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewComment } from '../db/comments';

const state = vi.hoisted(() => ({
  drafts: [] as ReviewComment[],
  head: new Map<string, string>(),
  base: new Map<string, string>(),
  moved: [] as Array<[number, number, number]>,
}));

vi.mock('../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../db/comments')>('../db/comments');
  return {
    ...actual,
    listGithubDrafts: vi.fn(async () => state.drafts),
    moveComment: vi.fn(async (_t: number, id: number, a: number, b: number) => void state.moved.push([id, a, b])),
  };
});
vi.mock('../git/worktree', () => ({
  taskBase: vi.fn(async () => 'mergebase1'),
  gitOk: vi.fn(async () => 'headsha1\n'),
  git: vi.fn(async (args: string[]) => {
    if (args[0] === 'show') {
      const text = state.head.get(String(args[1]).replace(/^HEAD:/, ''));
      return text === undefined ? { code: 128, stdout: '', stderr: 'no' } : { code: 0, stdout: text, stderr: '' };
    }
    if (args[0] === 'rev-list') return { code: 0, stdout: '1\n', stderr: '' };
    // The PR's diff: src/a.ts's first hunk, old side 1-6.
    return {
      code: 0,
      stdout: ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,6 +1,4 @@', ' start', '-guard', '-more', ' run', ''].join('\n'),
      stderr: '',
    };
  }),
}));
vi.mock('../git/fileDiff', () => ({
  readTextAtRev: vi.fn(async (_wt: string, rev: string, path: string) => (rev === 'mergebase1' ? (state.base.get(path) ?? null) : null)),
}));
vi.mock('../gh/prStore', () => ({ getPrStatus: () => null }));
vi.mock('../git/stackBase', () => ({ detectStackBase: vi.fn(async () => null) }));

const { prepareSubmit } = await import('./reviewDrafts');
const { planReview } = await import('../gh/reviewSubmit');

const task = { id: 3, reviewUrl: 'https://github.com/example/relay/pull/34', worktreePath: '/wt', baseBranch: 'main', kind: 'review' as const, branch: 'pr-34' };

function draft(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: 1, taskId: 3, path: 'src/a.ts', lineStart: 2, lineEnd: 2, anchorText: 'guard', body: 'Why drop the guard?',
    createdAt: 0, updatedAt: 0, sentAt: null, resolvedAt: null, github: 'draft', replyTo: null, side: 'old', ...over,
  };
}

beforeEach(() => {
  state.drafts = [];
  state.moved = [];
  state.base = new Map([['src/a.ts', 'start\nguard\nmore\nrun\nend\nlast\n']]);
  state.head = new Map([['src/a.ts', 'start\nrun\nend\nlast\n']]);
});

describe('prepareSubmit, drafts on removed lines', () => {
  it('finds one at the merge base, and the review posts it on the left side there', async () => {
    // Stored at an older base line; the merge base has it at 2.
    state.drafts = [draft({ lineStart: 5, lineEnd: 5 }), draft({ id: 2, side: 'new', anchorText: 'run', lineStart: 2, lineEnd: 2, body: 'Here.' })];
    const input = await prepareSubmit(task);
    expect(input.drafts.map((d) => [d.id, d.side, d.lineStart, d.lineEnd, d.lost ?? false])).toEqual([
      [1, 'old', 2, 2, false],
      [2, undefined, 2, 2, false],
    ]);
    expect(state.moved).toEqual([[1, 2, 2]]);
    const plan = planReview({ drafts: input.drafts, ranges: input.ranges, summary: '', verdict: 'COMMENT', commitId: input.commitId });
    expect(plan.review?.comments).toEqual([
      { path: 'src/a.ts', line: 2, side: 'LEFT', body: 'Why drop the guard?' },
      { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Here.' },
    ]);
  });

  it('one whose text the base no longer has, or whose lines are back at HEAD, goes in the summary', async () => {
    state.drafts = [draft({ anchorText: 'never there' })];
    expect((await prepareSubmit(task)).drafts[0]).toMatchObject({ lost: true, side: 'old' });
    state.drafts = [draft({})];
    state.head = new Map([['src/a.ts', 'start\nguard\nmore\nrun\nend\nlast\n']]);
    const input = await prepareSubmit(task);
    expect(input.lost).toBe(1);
    expect(input.drafts[0]).toMatchObject({ lost: true, side: 'old' });
  });
});
