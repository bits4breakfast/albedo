// @vitest-environment jsdom
/**
 * What the guide reads a branch against (#237): the branch the header shows
 * it merging into, and when git cannot find that branch, the reason -- never
 * an empty guide or an intro offering to write one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import { buildBranchDiff } from './blocks';
import { statReason } from './budget';
import { edited } from './fixtures';
import type { LoadedBranchDiff } from './branchDiff';

const reads = vi.hoisted(() => ({ bases: [] as string[], fromMergeBase: true }));
vi.mock('./branchDiff', () => ({
  loadBranchDiff: async (_w: string, base: string): Promise<LoadedBranchDiff> => {
    reads.bases.push(base);
    return {
      diff: buildBranchDiff([edited('src/a.ts', [3], 'alpha')], statReason),
      base: reads.fromMergeBase ? 'abc1234' : 'HEAD',
      fromMergeBase: reads.fromMergeBase,
      uncommitted: new Set(),
    };
  },
}));
const prs = vi.hoisted(() => ({ answer: undefined as PrStatus | null | undefined }));
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => prs.answer,
  usePrStatus: () => prs.answer ?? null,
}));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => null }));
vi.mock('../ui/editor/diffComments', () => ({
  useDiffComments: () => ({ annotations: null, notice: null, clearNotice: () => {}, bar: null }),
}));

const { default: GuidePane } = await import('./GuidePane');
const { resetGuideStoreForTests } = await import('./store');

const task = {
  id: 9, title: 't', projectId: 1, repoPath: '/r', baseBranch: 'feature-a', branch: 'feature-b', worktreePath: '/wt',
  sessionId: null, ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle', createdAt: 0,
  lastActivityAt: null, seenAt: null,
} as unknown as Task;

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetGuideStoreForTests();
  reads.bases = [];
  reads.fromMergeBase = true;
  prs.answer = { number: 12, baseRefName: 'main', state: 'open' } as PrStatus;
});
afterEach(cleanup);

describe('the guide’s base (#237)', () => {
  it('reads the branch against the PR’s base, not the branch it was cut from', async () => {
    render(<GuidePane task={task} active />);
    await waitFor(() => expect(reads.bases).toContain('main'));
    expect(reads.bases).not.toContain('feature-a');
  });

  it('says it cannot find the base, instead of offering a guide of nothing', async () => {
    reads.fromMergeBase = false;
    render(<GuidePane task={task} active />);
    expect(await screen.findByText(/Can’t find the base branch/)).toBeTruthy();
    expect(document.body.textContent).toContain('the task was cut from feature-a');
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Write/ })).toBeNull();
  });
});
