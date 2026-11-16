// @vitest-environment jsdom
/**
 * The base a comment on removed lines is read against outside a diff (#402,
 * review of #417): read again when the measured base moves (the PR's base
 * arriving after the stored one), carrying whether that base was final, and
 * never asked for by a file without such a comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Task } from '../../types';

const measured = vi.hoisted(() => ({ base: 'main', settled: false, asked: [] as Array<unknown> }));
vi.mock('../useMeasuredBase', () => ({
  useMeasuredBase: (task: unknown) => {
    measured.asked.push(task);
    return { base: measured.base, target: null, settled: measured.settled };
  },
}));
const reads = vi.hoisted(() => [] as string[]);
vi.mock('../../git/fileDiff', () => ({
  readTaskBaseText: vi.fn(async (_wt: string, base: string, path: string) => {
    reads.push(`${base}:${path}`);
    return `text at ${base}`;
  }),
}));

const { useBaseText } = await import('./removedBase');

const task = { id: 4, worktreePath: '/wt', baseBranch: 'main' } as Task;

afterEach(() => {
  reads.length = 0;
  measured.asked.length = 0;
  measured.base = 'main';
  measured.settled = false;
});

describe('useBaseText', () => {
  it('reads again when the measured base moves, and says when it is final', async () => {
    const { result, rerender } = renderHook(() => useBaseText(task, 'src/a.ts', true));
    await waitFor(() => expect(result.current).toEqual({ text: 'text at main', settled: false }));
    measured.base = 'release';
    measured.settled = true;
    rerender();
    await waitFor(() => expect(result.current).toEqual({ text: 'text at release', settled: true }));
    expect(reads).toEqual(['main:src/a.ts', 'release:src/a.ts']);
  });

  it('a file without such a comment asks nothing about its base', async () => {
    const { result } = renderHook(() => useBaseText(task, 'src/a.ts', false));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBeUndefined();
    expect(reads).toEqual([]);
    expect(measured.asked.every((t) => t === null)).toBe(true);
  });
});
