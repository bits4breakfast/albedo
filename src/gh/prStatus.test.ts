import { describe, expect, it } from 'vitest';
import {
  checkLines,
  parsePrView,
  prLabel,
  prTooltip,
  reviewChip,
  reviewTooltip,
  summarizeChecks,
  type PrStatus,
} from './prStatus';

/** `gh pr view --json ...` as gh prints it, with overrides. */
function view(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headRefName: 'session/hooks-capture-models',
    isDraft: false,
    mergedAt: null,
    number: 6,
    reviewDecision: '',
    state: 'OPEN',
    statusCheckRollup: [],
    title: 'Hook-based "waiting on you"',
    url: 'https://github.com/bits4breakfast/albedo/pull/6',
    ...over,
  });
}

const run = (name: string, status: string, conclusion: string, startedAt = '2026-10-16T21:00:00Z') => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  startedAt,
  completedAt: status === 'COMPLETED' ? startedAt : '0001-01-01T00:00:00Z',
  detailsUrl: `https://github.com/o/r/actions/runs/1/job/${name}`,
});

const ctx = (context: string, state: string) => ({
  __typename: 'StatusContext',
  context,
  state,
  startedAt: '2026-10-16T21:00:00Z',
  targetUrl: 'https://ci.example.com/build/1',
});

describe('parsePrView', () => {
  it('parses the real PR #6 shape (open, no checks, empty review decision)', () => {
    // Verbatim from `gh pr view 6 -R bits4breakfast/albedo --json ...`.
    const pr = parsePrView(
      '{"headRefName":"session/hooks-capture-models","isDraft":false,"mergedAt":null,"number":6,"reviewDecision":"","state":"OPEN","statusCheckRollup":[],"title":"Hook-based \\"waiting on you\\"","url":"https://github.com/bits4breakfast/albedo/pull/6"}',
    );
    expect(pr).toMatchObject({
      number: 6,
      state: 'open',
      review: null,
      checks: { kind: 'none' },
      url: 'https://github.com/bits4breakfast/albedo/pull/6',
    });
    expect(prLabel(pr!)).toEqual({ glyph: '', text: 'Open', tone: 'quiet' });
  });

  it('keeps the base the PR merges into, and reads a missing one as empty', () => {
    expect(parsePrView(view({ baseRefName: 'add-export' }))?.baseRefName).toBe('add-export');
    expect(parsePrView(view())?.baseRefName).toBe('');
  });

  it('maps the four states, draft and merged included', () => {
    expect(parsePrView(view({ isDraft: true }))?.state).toBe('draft');
    expect(parsePrView(view({ state: 'CLOSED' }))?.state).toBe('closed');
    expect(parsePrView(view({ state: 'MERGED', mergedAt: '2026-10-16T21:43:26Z' }))?.state).toBe('merged');
    // mergedAt alone is enough: GitHub never un-merges.
    expect(parsePrView(view({ mergedAt: '2026-10-16T21:43:26Z' }))?.state).toBe('merged');
  });

  it('maps review decisions', () => {
    expect(parsePrView(view({ reviewDecision: 'APPROVED' }))?.review).toBe('approved');
    expect(parsePrView(view({ reviewDecision: 'CHANGES_REQUESTED' }))?.review).toBe('changes-requested');
    expect(parsePrView(view({ reviewDecision: 'REVIEW_REQUIRED' }))?.review).toBe('review-required');
  });

  it('returns null for anything that is not a PR', () => {
    expect(parsePrView('')).toBeNull();
    expect(parsePrView('no pull requests found for branch "x"')).toBeNull();
    expect(parsePrView('[]')).toBeNull();
    expect(parsePrView('{"title":"x"}')).toBeNull();
  });
});

describe('checks', () => {
  it('mixes CheckRun and StatusContext shapes', () => {
    const lines = checkLines([
      run('build', 'COMPLETED', 'SUCCESS'),
      run('lint', 'COMPLETED', 'FAILURE'),
      run('e2e', 'IN_PROGRESS', ''),
      ctx('ci/jenkins', 'ERROR'),
      ctx('deploy/preview', 'PENDING'),
      ctx('coverage', 'SUCCESS'),
    ]);
    expect(lines.map((l) => [l.name, l.bucket])).toEqual([
      ['CI / lint', 'fail'],
      ['ci/jenkins', 'fail'],
      ['CI / e2e', 'pending'],
      ['deploy/preview', 'pending'],
      ['CI / build', 'pass'],
      ['coverage', 'pass'],
    ]);
    expect(summarizeChecks(lines)).toEqual({ kind: 'failing', failing: 2, total: 6 });
    expect(lines.find((l) => l.name === 'coverage')?.url).toBe('https://ci.example.com/build/1');
  });

  it('collapses reruns: the latest run of a job wins', () => {
    const lines = checkLines([
      run('test', 'COMPLETED', 'FAILURE', '2026-10-16T21:00:00Z'),
      run('test', 'COMPLETED', 'SUCCESS', '2026-10-16T21:10:00Z'),
      // Out of order in the array, older by time: must not resurrect the red.
      run('build', 'COMPLETED', 'SUCCESS', '2026-10-16T21:10:00Z'),
      run('build', 'COMPLETED', 'FAILURE', '2026-10-16T20:00:00Z'),
    ]);
    expect(summarizeChecks(lines)).toEqual({ kind: 'passing', total: 2 });
  });

  it('failing outranks pending, pending outranks passing', () => {
    expect(summarizeChecks(checkLines([run('a', 'QUEUED', ''), run('b', 'COMPLETED', 'TIMED_OUT')]))).toEqual({
      kind: 'failing',
      failing: 1,
      total: 2,
    });
    expect(summarizeChecks(checkLines([run('a', 'QUEUED', ''), run('b', 'COMPLETED', 'SUCCESS')]))).toEqual({
      kind: 'pending',
      pending: 1,
      total: 2,
    });
  });

  it('skipped and neutral are not counted; all-skipped is "none"', () => {
    const lines = checkLines([run('a', 'COMPLETED', 'SKIPPED'), run('b', 'COMPLETED', 'NEUTRAL')]);
    expect(lines.every((l) => l.bucket === 'skipped')).toBe(true);
    expect(summarizeChecks(lines)).toEqual({ kind: 'none' });
  });

  it('treats an unknown completed conclusion as failing, not passing', () => {
    expect(checkLines([run('a', 'COMPLETED', 'SOMETHING_NEW')])[0]?.bucket).toBe('fail');
  });

  it('handles entries without __typename by shape', () => {
    const lines = checkLines([
      { context: 'legacy', state: 'FAILURE' },
      { name: 'job', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(lines.map((l) => l.bucket)).toEqual(['fail', 'pass']);
  });

  it('ignores junk in the rollup', () => {
    expect(checkLines(null)).toEqual([]);
    expect(checkLines([null, 3, 'x'])).toEqual([]);
  });
});

describe('labels', () => {
  const parsed = (over: Record<string, unknown>) => parsePrView(view(over))!;

  it('says the badge words the task asks for', () => {
    expect(prLabel(parsed({ statusCheckRollup: [run('a', 'COMPLETED', 'SUCCESS')] }))).toEqual({
      glyph: '✓',
      text: 'Checks',
      tone: 'pass',
    });
    expect(
      prLabel(
        parsed({ statusCheckRollup: [run('a', 'COMPLETED', 'FAILURE'), ctx('b', 'FAILURE')] }),
      ),
    ).toEqual({ glyph: '✗', text: '2 Failing', tone: 'fail' });
    expect(prLabel(parsed({ statusCheckRollup: [run('a', 'IN_PROGRESS', '')] })).tone).toBe('pending');
    expect(prLabel(parsed({ state: 'MERGED', statusCheckRollup: [run('a', 'COMPLETED', 'FAILURE')] }))).toEqual({
      glyph: '',
      text: 'Merged',
      tone: 'merged',
    });
    expect(prLabel(parsed({ isDraft: true, statusCheckRollup: [run('a', 'COMPLETED', 'SUCCESS')] })).text).toBe(
      'Draft · Checks',
    );
  });

  it('tooltip carries review, counts and the failing jobs first', () => {
    const tip = prTooltip(
      parsed({
        reviewDecision: 'CHANGES_REQUESTED',
        statusCheckRollup: [run('ok', 'COMPLETED', 'SUCCESS'), run('bad', 'COMPLETED', 'FAILURE')],
      }),
      { clickable: true },
    );
    expect(tip.split('\n')).toEqual([
      '#6 Hook-based "waiting on you"',
      'open · changes requested · 1 of 2 checks failing',
      '✗ CI / bad',
      '✓ CI / ok',
      'Click to open on GitHub',
    ]);
  });
});

/** `latestReviews` entries as gh prints them (id empty, body kept). */
const rev = (login: string, state: string, submittedAt = '2026-10-30T18:23:44Z') => ({
  id: '',
  author: { login },
  authorAssociation: 'MEMBER',
  body: 'a long review body nobody needs here',
  submittedAt,
  includesCreatedEdit: false,
  reactionGroups: [],
  state,
  commit: { oid: '' },
});

describe('parsePrView: reviews (#180)', () => {
  it('keeps approvals and change requests, the requested reviewers and the author', () => {
    const p = parsePrView(
      view({
        reviewDecision: 'APPROVED',
        latestReviews: [rev('copilot-pull-request-reviewer', 'COMMENTED'), rev('alice', 'APPROVED')],
        reviewRequests: [
          { __typename: 'User', login: 'bob' },
          { __typename: 'Team', name: 'acme-core', slug: 'acme-core' },
        ],
        author: { id: 'x', is_bot: false, login: 'octo', name: 'Octo Cat' },
      }),
    )!;
    expect(p.review).toBe('approved');
    expect(p.reviews).toEqual([{ author: 'alice', state: 'approved', submittedAt: '2026-10-30T18:23:44Z' }]);
    expect(p.reviewRequests).toEqual(['bob', 'acme-core']);
    expect(p.author).toBe('octo');
  });

  it('with no decision from GitHub, falls back to the latest reviews: changes outrank approvals', () => {
    const decide = (...reviews: ReturnType<typeof rev>[]) =>
      parsePrView(view({ reviewDecision: '', latestReviews: reviews }))!.review;
    expect(decide(rev('alice', 'APPROVED'), rev('carol', 'CHANGES_REQUESTED'))).toBe('changes-requested');
    expect(decide(rev('alice', 'APPROVED'), rev('bot', 'COMMENTED'))).toBe('approved');
    expect(decide(rev('bot', 'COMMENTED'), rev('erin', 'DISMISSED'))).toBeNull();
    expect(decide()).toBeNull();
  });

  it("GitHub's decision wins over the reviews when it has one", () => {
    const p = parsePrView(view({ reviewDecision: 'REVIEW_REQUIRED', latestReviews: [rev('alice', 'APPROVED')] }))!;
    expect(p.review).toBe('review-required');
  });

  it('tolerates a gh that does not send the fields at all', () => {
    const p = parsePrView(view())!;
    expect(p.reviews).toEqual([]);
    expect(p.reviewRequests).toEqual([]);
    expect(p.author).toBe('');
  });
});

describe('reviewChip (#180)', () => {
  const base = (over: Partial<PrStatus> = {}): PrStatus => ({ ...parsePrView(view())!, author: 'octo', ...over });

  it('maps the three states to a glyph, the words and a tone', () => {
    expect(reviewChip(base({ review: 'approved' }), null)).toMatchObject({ glyph: '✓', text: 'Approved', tone: 'pass' });
    expect(reviewChip(base({ review: 'changes-requested' }), null)).toMatchObject({
      glyph: '✎',
      text: 'Changes Requested',
      tone: 'warn',
    });
    expect(reviewChip(base({ review: 'review-required' }), null)).toMatchObject({
      glyph: '◷',
      text: 'Awaiting Review',
      tone: 'quiet',
    });
  });

  it('shows nothing unless the PR is open', () => {
    for (const state of ['draft', 'merged', 'closed'] as const) {
      expect(reviewChip(base({ state, review: 'approved' }), null)).toBeNull();
    }
  });

  it('no decision and nobody asked is no chip; a reviewer asked is Awaiting Review', () => {
    expect(reviewChip(base(), null)).toBeNull();
    expect(reviewChip(base({ reviewRequests: ['bob'] }), null)?.kind).toBe('awaiting');
  });

  it("hides Awaiting Review on the viewer's own PR with nobody asked, and only then", () => {
    const own = base({ review: 'review-required', author: 'Octo' });
    expect(reviewChip(own, 'octo')).toBeNull();
    // Unknown login: hide nothing.
    expect(reviewChip(own, null)?.kind).toBe('awaiting');
    // Someone else's PR.
    expect(reviewChip(own, 'alice')?.kind).toBe('awaiting');
    // A reviewer was asked: it is a real wait.
    expect(reviewChip({ ...own, reviewRequests: ['bob'] }, 'octo')?.kind).toBe('awaiting');
    // Approved stays, whoever the author is.
    expect(reviewChip({ ...own, review: 'approved' }, 'octo')?.kind).toBe('approved');
  });

  it('the tooltip names who approved, who asked for changes and who is asked', () => {
    const t = reviewTooltip(
      base({
        reviews: [
          { author: 'alice', state: 'approved', submittedAt: '' },
          { author: 'bob', state: 'approved', submittedAt: '' },
          { author: 'carol', state: 'changes-requested', submittedAt: '' },
        ],
        reviewRequests: ['dave', 'erin', 'frank'],
      }),
    );
    expect(t.split('\n')).toEqual([
      'Changes requested by carol',
      'Approved by alice and bob',
      'Review requested from dave, erin and frank',
      'Click to open the reviews on GitHub',
    ]);
  });
});
