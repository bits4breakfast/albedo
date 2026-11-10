import { describe, expect, it } from 'vitest';
import {
  activityOf,
  activityWords,
  isStarted,
  REVIEW_GROUP_TITLE,
  reviewGroups,
  startWords,
  waitingCount,
  type ReviewStart,
  type SeenMark,
} from './reviewActivity';
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
    yourReview: null,
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

describe('Review Started and Approved (#315)', () => {
  const start = (over: Partial<ReviewStart> = {}): ReviewStart => ({ at: 6 * H, groups: null, drafts: 0, comments: 0, ...over });
  const keys = (groups: ReturnType<typeof reviewGroups>) => groups.map((g) => [g.key, g.rows.map((r) => r.pr.number)]);

  it('a Reviewed tick or a comment, with no review of yours yet, starts a requested PR', () => {
    const ticked = pr({ url: 'u/t', number: 1 });
    const commented = pr({ url: 'u/c', number: 2 });
    const quiet = pr({ url: 'u/q', number: 3 });
    const starts = new Map([
      ['u/t', start({ at: 7 * H, groups: { reviewed: 2, total: 4 } })],
      ['u/c', start({ at: 6 * H, drafts: 3 })],
    ]);
    const groups = reviewGroups([ticked, commented, quiet], new Map(), 'me', starts);
    // Most recently worked on first, and its age is that work.
    expect(keys(groups)).toEqual([
      ['started', [1, 2]],
      ['requested', [3]],
    ]);
    expect(groups[0]!.rows[0]!.at).toBe(7 * H);
    expect(groups[0]!.rows[0]!.start?.groups).toEqual({ reviewed: 2, total: 4 });
  });

  it('a PR with no review task has no start, so it is never Started', () => {
    expect(keys(reviewGroups([pr({ url: 'u/a' })], new Map(), 'me', new Map([['u/other', start()]])))).toEqual([
      ['requested', [1]],
    ]);
  });

  it('a review submitted after the last tick or comment ends it; work after the review starts it again', () => {
    const reviewed = { at: 8 * H, state: 'COMMENTED' };
    const p = pr({ url: 'u/a', section: 'reviewed', updatedAt: 8 * H, yourReview: reviewed, talk: [{ author: 'me', at: 8 * H }] });
    expect(keys(reviewGroups([p], new Map(), 'me', new Map([['u/a', start({ at: 7 * H })]])))).toEqual([['reviewed', [1]]]);
    expect(keys(reviewGroups([p], new Map(), 'me', new Map([['u/a', start({ at: 9 * H })]])))).toEqual([['started', [1]]]);
    // A tick whose time was never kept (before #315) cannot be newer than a review.
    expect(isStarted(p, start({ at: null }))).toBe(false);
    expect(isStarted({ ...p, yourReview: null }, start({ at: null }))).toBe(true);
  });

  it('your latest review approving the PR puts it in Approved, after Waiting on Author', () => {
    const approved = pr({
      url: 'u/a', number: 20, section: 'reviewed', updatedAt: 5 * H,
      yourReview: { at: 5 * H, state: 'APPROVED' }, talk: [{ author: 'me', at: 5 * H }],
    });
    const changes = pr({
      url: 'u/b', number: 21, section: 'reviewed', updatedAt: 4 * H,
      yourReview: { at: 4 * H, state: 'CHANGES_REQUESTED' }, talk: [{ author: 'me', at: 4 * H }],
    });
    const groups = reviewGroups([approved, changes], new Map(), 'me');
    expect(keys(groups)).toEqual([
      ['reviewed', [21]],
      ['approved', [20]],
    ]);
    expect(REVIEW_GROUP_TITLE.approved).toBe('Approved');
  });

  it('New Activity wins over Started and Approved', () => {
    const news: ReviewPr['talk'] = [{ author: 'me', at: 5 * H }, { author: 'alice', at: 9 * H }];
    const started = pr({ url: 'u/s', number: 1, talk: news });
    const approved = pr({ url: 'u/a', number: 2, section: 'reviewed', yourReview: { at: 5 * H, state: 'APPROVED' }, talk: news });
    const groups = reviewGroups([started, approved], new Map(), 'me', new Map([['u/s', start({ at: 6 * H })]]));
    expect(keys(groups)).toEqual([['activity', [2, 1]]]);
  });

  it('groups in the owner order, and the count is New Activity, Review Started and Requested', () => {
    const mine = (at: number, state: string) => ({ yourReview: { at, state }, talk: [{ author: 'me', at }] });
    const prs = [
      pr({ url: 'u/approved', number: 5, section: 'reviewed', ...mine(3 * H, 'APPROVED') }),
      pr({ url: 'u/waiting', number: 4, section: 'reviewed', ...mine(3 * H, 'COMMENTED') }),
      pr({ url: 'u/requested', number: 3 }),
      pr({ url: 'u/started', number: 2 }),
      pr({ url: 'u/news', number: 1, section: 'reviewed', talk: [{ author: 'me', at: 3 * H }, { author: 'bob', at: 4 * H }] }),
    ];
    const groups = reviewGroups(prs, new Map(), 'me', new Map([['u/started', start()]]));
    expect(groups.map((g) => REVIEW_GROUP_TITLE[g.key])).toEqual([
      'New Activity',
      'Review Started',
      'Requested',
      'Reviewed · Waiting on Author',
      'Approved',
    ]);
    expect(waitingCount(groups)).toBe(3);
  });

  it('says how far along: groups when there is a guide, drafts when there are some, else the comments', () => {
    expect(startWords(start({ groups: { reviewed: 2, total: 4 }, drafts: 3, comments: 1 }))).toEqual(['2/4 groups', '3 drafts']);
    expect(startWords(start({ groups: { reviewed: 0, total: 1 }, drafts: 1 }))).toEqual(['0/1 group', '1 draft']);
    expect(startWords(start({ comments: 2 }))).toEqual(['2 comments']);
  });
});
