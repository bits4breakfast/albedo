import { describe, expect, it } from 'vitest';
import { activityOf, activityWords, reviewGroups, waitingCount, type SeenMark } from './reviewActivity';
import type { ReviewPr } from './reviewRequests';

const H = 3_600_000;

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
  return {
    url: 'https://github.com/acme/relay/pull/1',
    number: 1,
    title: 'One',
    isDraft: false,
    author: 'alice',
    additions: 1,
    deletions: 1,
    headOid: 'h1',
    baseBranch: 'main',
    commitCount: 2,
    lastCommitAt: 1 * H,
    createdAt: 1 * H,
    updatedAt: 1 * H,
    requestedAt: 2 * H,
    teams: [],
    talk: [],
    forcePushedAt: null,
    section: 'requested',
    ...over,
  };
}

const seen = (at: number, head = 'h1', commits = 2): SeenMark => ({ at, head, commits });

describe('activityOf', () => {
  it('a PR never looked at has nothing new, however busy it is', () => {
    const a = activityOf(pr({ talk: [{ author: 'bob', at: 5 * H }], lastCommitAt: 6 * H }), undefined, 'me');
    expect(a.unseen).toBe(false);
  });

  it('counts commits since the head you saw, and comments by others since you looked', () => {
    const p = pr({
      headOid: 'h2',
      commitCount: 4,
      lastCommitAt: 7 * H,
      talk: [
        { author: 'bob', at: 2 * H },
        { author: 'bob', at: 6 * H },
        { author: 'me', at: 8 * H },
        { author: 'carol', at: 9 * H },
      ],
    });
    // Your own comment at 8h moves "since" to 8h: only carol's is news.
    const a = activityOf(p, seen(5 * H), 'me');
    expect(a).toMatchObject({ unseen: true, newCommits: 2, newComments: 1, reRequested: false });
    expect(a.at).toBe(9 * H);
    expect(activityWords(a)).toEqual(['2 new commits', '1 new comment']);
  });

  it('a force-push that leaves fewer commits says force-pushed, not a negative count', () => {
    const a = activityOf(pr({ headOid: 'h9', commitCount: 1, forcePushedAt: 6 * H, lastCommitAt: 6 * H }), seen(5 * H), 'me');
    expect(activityWords(a)).toEqual(['force-pushed']);
  });

  it('being asked again after you looked is news', () => {
    const a = activityOf(pr({ requestedAt: 6 * H }), seen(5 * H), 'me');
    expect(activityWords(a)).toEqual(['re-requested']);
  });

  it('your review on GitHub counts as looking, without a mark from Albedo', () => {
    const p = pr({ section: 'reviewed', talk: [{ author: 'me', at: 4 * H }], lastCommitAt: 6 * H });
    expect(activityWords(activityOf(p, undefined, 'me'))).toEqual(['new commits']);
    expect(activityOf({ ...p, lastCommitAt: 3 * H }, undefined, 'me').unseen).toBe(false);
  });
});

describe('reviewGroups', () => {
  it('new activity first (newest first), then requested by request time, then reviewed by update', () => {
    const prs = [
      pr({ url: 'u/a', number: 10, requestedAt: 1 * H }),
      pr({ url: 'u/b', number: 11, requestedAt: 3 * H }),
      pr({ url: 'u/c', number: 12, talk: [{ author: 'bob', at: 9 * H }] }),
      pr({ url: 'u/d', number: 13, talk: [{ author: 'bob', at: 8 * H }] }),
      pr({ url: 'u/e', number: 14, section: 'reviewed', updatedAt: 4 * H, talk: [{ author: 'me', at: 4 * H }], lastCommitAt: 1 * H }),
    ];
    const marks = new Map([
      ['u/c', seen(5 * H)],
      ['u/d', seen(5 * H)],
    ]);
    const groups = reviewGroups(prs, marks, 'me');
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.pr.number)])).toEqual([
      ['activity', [12, 13]],
      ['requested', [11, 10]],
      ['reviewed', [14]],
    ]);
    // Everything requested, plus nothing from the quiet reviewed one.
    expect(waitingCount(groups)).toBe(4);
  });

  it('a reviewed PR with news is counted and moves up', () => {
    const p = pr({ section: 'reviewed', talk: [{ author: 'me', at: 4 * H }, { author: 'alice', at: 5 * H }] });
    const groups = reviewGroups([p], new Map(), 'me');
    expect(groups[0]!.key).toBe('activity');
    expect(waitingCount(groups)).toBe(1);
  });
});
