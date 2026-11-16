/**
 * placeRemoved (#402, review of #417) diffs a file's base against it once
 * for all its comments: the same two texts are not diffed again.
 */
import { expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../lib/diff', async () => {
  const actual = await vi.importActual<typeof import('../lib/diff')>('../lib/diff');
  return {
    ...actual,
    diffSequences: (a: readonly string[], b: readonly string[]) => {
      calls.n += 1;
      return actual.diffSequences(a, b);
    },
  };
});

const { placeRemoved } = await import('./comments');

it('diffs one base and file once, however many comments ask', () => {
  const base = 'a\nX\nb\nY\nc\n';
  const now = 'a\nb\nc\n';
  expect(placeRemoved({ anchorText: 'X', lineStart: 2 }, base, now).state).toBe('removed');
  expect(placeRemoved({ anchorText: 'Y', lineStart: 4 }, base, now).state).toBe('removed');
  expect(calls.n).toBe(1);
  // Another file now: diffed again.
  expect(placeRemoved({ anchorText: 'X', lineStart: 2 }, base, 'a\nX\nb\nc\n').state).toBe('back');
  expect(calls.n).toBe(2);
});
