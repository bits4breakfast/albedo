// @vitest-environment jsdom
/**
 * No Suggest Change on removed lines (#402 with #411): the box for a removed
 * comment, alone or with added lines, offers none; the box on the file now
 * still does. And a draft on GitHub's left side never carries a suggestion
 * block, even one stored in its body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { planReview, type GithubDraft } from '../../gh/reviewSubmit';
import { joinSuggestion } from '../../lib/suggestion';

vi.mock('../../db/comments', async () => {
  const actual = await vi.importActual<typeof import('../../db/comments')>('../../db/comments');
  return { ...actual, listComments: vi.fn(async () => []), onCommentsChanged: vi.fn(() => () => {}) };
});

const { useDiffComments } = await import('./diffComments');

afterEach(cleanup);

const BASE = 'start\nif (!ready) return;\nrun(1);\nend\n';
const NOW = 'start\nrun(2);\nend\n';

describe('Suggest Change in a diff', () => {
  it('on the file now: offered', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    act(() => result.current.annotations!.pick(2, 2, true));
    render(<>{result.current.annotations!.after(2)}</>);
    expect(screen.getByRole('button', { name: /Suggest Change/ })).toBeTruthy();
  });

  it('on removed lines: not offered', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    act(() => result.current.annotations!.removed!.pick(2, 2, true));
    render(<>{result.current.annotations!.removed!.after(2)}</>);
    expect(screen.getByPlaceholderText(/Leave a comment/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Suggest Change/ })).toBeNull();
  });

  it('on removed and added lines together: not offered (one text goes to both sides)', () => {
    const { result } = renderHook(() => useDiffComments(1, 'src/a.ts', NOW, false, true, null, BASE));
    act(() => result.current.annotations!.pickBoth!({ from: 2, to: 2 }, { from: 2, to: 2 }));
    render(<>{result.current.annotations!.after(2)}</>);
    expect(screen.getByPlaceholderText(/Leave a comment/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Suggest Change/ })).toBeNull();
  });
});

describe('a draft on the left side', () => {
  it('never carries a suggestion block; one on the right still does', () => {
    const body = joinSuggestion(['run(3);'], 'Why?');
    const left: GithubDraft = { id: 1, path: 'src/a.ts', lineStart: 2, lineEnd: 2, body, replyTo: null, side: 'old' };
    const right: GithubDraft = { ...left, id: 2, side: undefined };
    const plan = planReview({ drafts: [left, right], ranges: null, summary: '', verdict: 'COMMENT', commitId: 'abc' });
    const [l, r] = plan.review!.comments;
    expect(l!.side).toBe('LEFT');
    expect(l!.body).not.toMatch(/```suggestion/);
    expect(l!.body).toMatch(/Why\?/);
    expect(r!.side).toBe('RIGHT');
    expect(r!.body).toMatch(/```suggestion/);
  });
});
