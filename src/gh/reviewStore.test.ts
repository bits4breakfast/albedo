/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { markSeen, refreshReviews, reviewListState, seenMarks, setReviewFetcherForTests, MAX_MARKS } from './reviewStore';
import type { ReviewPr, ReviewRequests } from './reviewRequests';
import { KEYS } from '../ui/persisted';

let data: Map<string, string>;
let t = 0;
beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  t = 1_000_000;
});

const list: ReviewRequests = { viewer: 'me', prs: [] };

describe('the review list store', () => {
  it('a first failure is unavailable; a later failure keeps the last list', async () => {
    let next: ReviewRequests | null = null;
    setReviewFetcherForTests(async () => next, () => t);
    expect(reviewListState('/r').kind).toBe('loading');
    await refreshReviews('/r');
    expect(reviewListState('/r').kind).toBe('unavailable');
    next = list;
    await refreshReviews('/r', { force: true });
    expect(reviewListState('/r')).toEqual({ kind: 'ready', list });
    next = null;
    await refreshReviews('/r', { force: true });
    expect(reviewListState('/r')).toEqual({ kind: 'ready', list });
  });

  it('a burst of refreshes is one fetch', async () => {
    let n = 0;
    setReviewFetcherForTests(async () => (n++, list), () => t);
    await Promise.all([refreshReviews('/r'), refreshReviews('/r')]);
    await refreshReviews('/r');
    expect(n).toBe(1);
    t += 60_000;
    await refreshReviews('/r');
    expect(n).toBe(2);
  });

  it('a forced refresh while a fetch is in flight fetches once more after it, and its answer stands (#315)', async () => {
    const answers: ((v: ReviewRequests) => void)[] = [];
    setReviewFetcherForTests(() => new Promise<ReviewRequests>((r) => answers.push(r)), () => t);
    const first = refreshReviews('/r');
    // Submit Review lands while the minute's fetch is still out: two forced calls, one more fetch.
    const forced = Promise.all([refreshReviews('/r', { force: true }), refreshReviews('/r', { force: true })]);
    expect(answers).toHaveLength(1);
    const before: ReviewRequests = { viewer: 'me', prs: [] };
    const after: ReviewRequests = { viewer: 'me', prs: [{ url: 'u/1' } as ReviewPr] };
    answers[0]!(before);
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(answers).toHaveLength(2);
    answers[1]!(after);
    await forced;
    expect(reviewListState('/r')).toEqual({ kind: 'ready', list: after });
    expect(answers).toHaveLength(2);
  });

  it('seen marks persist, newest kept', () => {
    setReviewFetcherForTests(async () => list, () => t);
    const pr = (i: number) => ({ url: `u/${i}`, headOid: `h${i}`, commitCount: i }) as ReviewPr;
    for (let i = 0; i < MAX_MARKS + 5; i++) {
      t += 1;
      markSeen(pr(i));
    }
    const stored = JSON.parse(data.get(KEYS.reviewSeen)!) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(MAX_MARKS);
    expect(stored['u/0']).toBeUndefined();
    expect(seenMarks().get(`u/${MAX_MARKS + 4}`)).toEqual({ at: t, head: `h${MAX_MARKS + 4}`, commits: MAX_MARKS + 4 });
  });
});
