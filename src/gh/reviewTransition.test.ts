import { describe, expect, it } from 'vitest';
import { parsePrView, type PrStatus } from './prStatus';
import { reviewBanner, reviewStep, type ReviewWatch } from './reviewTransition';

const rev = (login: string, state: string, submittedAt: string) => ({ author: { login }, state, submittedAt, id: '' });

function pr(reviews: ReturnType<typeof rev>[], over: Record<string, unknown> = {}): PrStatus {
  return parsePrView(
    JSON.stringify({ number: 12, state: 'OPEN', headRefName: 'b', reviewDecision: '', latestReviews: reviews, ...over }),
  )!;
}

/** Feed answers in order; collect the events. */
function run(answers: (PrStatus | null)[], viewer: string | null | (string | null)[] = 'me') {
  let watch: ReviewWatch | undefined;
  const events = [];
  for (const [i, a] of answers.entries()) {
    const step = reviewStep(watch, a, Array.isArray(viewer) ? (viewer[i] ?? null) : viewer);
    watch = step.watch;
    if (step.event) events.push(step.event);
  }
  return events;
}

describe('reviewStep', () => {
  it('the reviews a PR already has when first seen are history', () => {
    expect(run([pr([rev('alice', 'APPROVED', 't1')]), pr([rev('alice', 'APPROVED', 't1')])])).toEqual([]);
  });

  it('a new approval is one event, however many polls see it', () => {
    const before = pr([]);
    const after = pr([rev('alice', 'APPROVED', 't1')]);
    expect(run([before, after, after, after])).toEqual([{ outcome: 'approved', prNumber: 12, reviewers: ['alice'] }]);
  });

  it('a re-approval after a push is a new review', () => {
    const a1 = pr([rev('alice', 'APPROVED', 't1')]);
    const a2 = pr([rev('alice', 'APPROVED', 't2')]);
    expect(run([pr([]), a1, a2]).length).toBe(2);
  });

  it('changes requested outranks an approval landing in the same answer, and names its reviewers', () => {
    const after = pr([
      rev('alice', 'APPROVED', 't1'),
      rev('carol', 'CHANGES_REQUESTED', 't1'),
      rev('dan', 'CHANGES_REQUESTED', 't1'),
    ]);
    expect(run([pr([]), after])).toEqual([
      { outcome: 'changes-requested', prNumber: 12, reviewers: ['carol', 'dan'] },
    ]);
  });

  it('comments and dismissals are not reviews that land', () => {
    expect(run([pr([]), pr([rev('bot', 'COMMENTED', 't1'), rev('erin', 'DISMISSED', 't1')])])).toEqual([]);
  });

  it('a gh that drops out keeps what was seen: nothing fires twice, nothing is lost', () => {
    const after = pr([rev('alice', 'APPROVED', 't1')]);
    expect(run([pr([]), null, after, null, after]).length).toBe(1);
  });

  it('a draft remembers its review and does not announce it when marked ready', () => {
    const draft = pr([rev('alice', 'APPROVED', 't1')], { isDraft: true });
    const ready = pr([rev('alice', 'APPROVED', 't1')]);
    expect(run([pr([], { isDraft: true }), draft, ready])).toEqual([]);
  });

  it('merged or closed meanwhile: nothing', () => {
    expect(run([pr([]), pr([rev('alice', 'APPROVED', 't1')], { state: 'MERGED' })])).toEqual([]);
  });

  it('another PR on the branch starts over', () => {
    expect(run([pr([]), pr([rev('alice', 'APPROVED', 't1')], { number: 13 })])).toEqual([]);
  });

  it("the signed-in user's own review is not news to them", () => {
    expect(run([pr([]), pr([rev('Octo', 'APPROVED', 't1')])], 'octo')).toEqual([]);
  });

  it('while the signed-in user is unknown, a new review waits, then is judged once they are known', () => {
    const own = [pr([]), pr([rev('Octo', 'APPROVED', 't1')]), pr([rev('Octo', 'APPROVED', 't1')])];
    expect(run(own, ['octo', null, 'octo'])).toEqual([]);
    const theirs = [pr([]), pr([rev('alice', 'APPROVED', 't1')]), pr([rev('alice', 'APPROVED', 't1')])];
    expect(run(theirs, ['octo', null, 'octo']).map((e) => e.reviewers)).toEqual([['alice']]);
  });
});

describe('reviewBanner', () => {
  it('names the task, the PR and who', () => {
    expect(reviewBanner({ outcome: 'approved', prNumber: 12, reviewers: ['alice'] }, 'Fix login', 7)).toEqual({
      title: 'Fix login',
      body: 'PR #12 approved by alice',
    });
    expect(
      reviewBanner({ outcome: 'changes-requested', prNumber: 12, reviewers: ['carol', 'dan'] }, ' ', 7),
    ).toEqual({ title: 'Task 7', body: 'PR #12: changes requested by carol and dan' });
  });
});
