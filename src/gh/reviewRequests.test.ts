import { afterEach, describe, expect, it } from 'vitest';
import { setGhRunner, type GhRunner } from './gh';
import {
  fetchReviewRequests,
  parseReviewRequests,
  REQUESTED_SEARCH,
  REVIEWED_SEARCH,
  REVIEWS_QUERY,
} from './reviewRequests';

/** A search node as REVIEWS_QUERY's fragment returns it. */
function node(over: Record<string, unknown> = {}) {
  return {
    number: 412,
    title: 'Retry webhook delivery',
    url: 'https://github.com/acme/relay/pull/412',
    isDraft: false,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-08T10:00:00Z',
    additions: 84,
    deletions: 12,
    headRefOid: 'abc123',
    author: { login: 'alice' },
    commits: { totalCount: 3, nodes: [{ commit: { committedDate: '2026-11-07T09:00:00Z' } }] },
    comments: { nodes: [{ author: { login: 'bob' }, createdAt: '2026-11-06T09:00:00Z' }] },
    reviews: {
      nodes: [
        { author: { login: 'carol' }, submittedAt: '2026-11-05T09:00:00Z' },
        // A pending review has no submittedAt: not activity.
        { author: { login: 'me' }, submittedAt: null },
      ],
    },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] },
    timelineItems: {
      nodes: [
        { __typename: 'ReviewRequestedEvent', createdAt: '2026-11-02T10:00:00Z', requestedReviewer: { __typename: 'User', login: 'me' } },
        { __typename: 'ReviewRequestedEvent', createdAt: '2026-11-03T10:00:00Z', requestedReviewer: { __typename: 'User', login: 'zed' } },
        { __typename: 'HeadRefForcePushedEvent', createdAt: '2026-11-04T10:00:00Z' },
      ],
    },
    ...over,
  };
}

const answer = (requested: unknown[], reviewed: unknown[] = []) =>
  JSON.stringify({ data: { viewer: { login: 'me' }, requested: { nodes: requested }, reviewed: { nodes: reviewed } } });

describe('parseReviewRequests', () => {
  it('reads a requested PR: size, head, commits, talk, the request of you and the force-push', () => {
    const r = parseReviewRequests(answer([node()]));
    expect(r?.viewer).toBe('me');
    const pr = r!.prs[0]!;
    expect(pr).toMatchObject({
      number: 412,
      author: 'alice',
      additions: 84,
      deletions: 12,
      headOid: 'abc123',
      commitCount: 3,
      lastCommitAt: Date.parse('2026-11-07T09:00:00Z'),
      // Yours, not zed's later one.
      requestedAt: Date.parse('2026-11-02T10:00:00Z'),
      forcePushedAt: Date.parse('2026-11-04T10:00:00Z'),
      teams: [],
      section: 'requested',
    });
    // Oldest first; the pending review is not in it.
    expect(pr.talk).toEqual([
      { author: 'carol', at: Date.parse('2026-11-05T09:00:00Z') },
      { author: 'bob', at: Date.parse('2026-11-06T09:00:00Z') },
    ]);
  });

  it('keeps your latest submitted review and its state, never a pending one or someone else\'s (#315)', () => {
    const reviews = (nodes: unknown[]) => parseReviewRequests(answer([node({ reviews: { nodes } })]))!.prs[0]!.yourReview;
    expect(REVIEWS_QUERY).toContain('reviews(last: 10) { nodes { author { login } submittedAt state } }');
    expect(
      reviews([
        { author: { login: 'me' }, submittedAt: '2026-11-04T09:00:00Z', state: 'CHANGES_REQUESTED' },
        { author: { login: 'me' }, submittedAt: '2026-11-06T09:00:00Z', state: 'APPROVED' },
        { author: { login: 'carol' }, submittedAt: '2026-11-07T09:00:00Z', state: 'COMMENTED' },
        { author: { login: 'me' }, submittedAt: null, state: 'PENDING' },
      ]),
    ).toEqual({ at: Date.parse('2026-11-06T09:00:00Z'), state: 'APPROVED' });
    expect(reviews([{ author: { login: 'carol' }, submittedAt: '2026-11-07T09:00:00Z', state: 'APPROVED' }])).toBeNull();
  });

  it('a request through a team names the team and takes that team request time', () => {
    const r = parseReviewRequests(
      answer([
        node({
          reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'platform' } }] },
          timelineItems: {
            nodes: [
              { __typename: 'ReviewRequestedEvent', createdAt: '2026-11-02T10:00:00Z', requestedReviewer: { __typename: 'Team', slug: 'platform' } },
              { __typename: 'ReviewRequestedEvent', createdAt: '2026-11-03T10:00:00Z', requestedReviewer: { __typename: 'Team', slug: 'other' } },
            ],
          },
        }),
      ]),
    );
    expect(r!.prs[0]).toMatchObject({ teams: ['platform'], requestedAt: Date.parse('2026-11-02T10:00:00Z') });
  });

  it('keeps the reviewed section apart, drops non-PR nodes and duplicates', () => {
    const r = parseReviewRequests(
      answer([node(), {}], [node(), node({ number: 9, url: 'https://github.com/acme/relay/pull/9' })]),
    );
    expect(r!.prs.map((p) => [p.number, p.section])).toEqual([
      [412, 'requested'],
      [9, 'reviewed'],
    ]);
  });

  it('an error answer is null, not an empty list', () => {
    expect(parseReviewRequests('not json')).toBeNull();
    expect(parseReviewRequests(JSON.stringify({ errors: [{ message: 'x' }] }))).toBeNull();
    expect(parseReviewRequests(answer([]))).toEqual({ viewer: 'me', prs: [] });
  });
});

describe('fetchReviewRequests', () => {
  let prev: GhRunner | null = null;
  afterEach(() => {
    if (prev) setGhRunner(prev);
    prev = null;
  });

  it('asks once, in the project folder, with both searches scoped by gh placeholders', async () => {
    const calls: { args: string[]; cwd?: string }[] = [];
    prev = setGhRunner(async (_p, args, cwd) => {
      calls.push({ args, cwd });
      return { code: 0, stdout: answer([node()]), stderr: '' };
    });
    const r = await fetchReviewRequests('/r/relay');
    expect(r?.prs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/r/relay');
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '-F',
      `requested=${REQUESTED_SEARCH}`,
      '-F',
      `reviewed=${REVIEWED_SEARCH}`,
      '-f',
      `query=${REVIEWS_QUERY}`,
    ]);
    expect(REQUESTED_SEARCH).toContain('repo:{owner}/{repo}');
    expect(REVIEWED_SEARCH).toContain('-review-requested:@me');
  });

  it('gh failing is null', async () => {
    prev = setGhRunner(async () => ({ code: 1, stdout: '', stderr: 'not logged in' }));
    expect(await fetchReviewRequests('/r/relay')).toBeNull();
  });
});
