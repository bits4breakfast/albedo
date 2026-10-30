import { describe, expect, it } from 'vitest';
import { ciBanner, ciStep, type CiWatch } from './ciTransition';
import { parsePrView, type PrState, type PrStatus } from './prStatus';

type Check = { name: string; status: string; conclusion?: string };

/** A PR as gh would print it: one head commit, these checks. */
function pr(sha: string, checks: Check[], state: PrState = 'open'): PrStatus {
  return parsePrView(
    JSON.stringify({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 't',
      state: state === 'merged' ? 'MERGED' : state === 'closed' ? 'CLOSED' : 'OPEN',
      isDraft: state === 'draft',
      headRefName: 'b',
      headRefOid: sha,
      statusCheckRollup: checks.map((c) => ({ __typename: 'CheckRun', name: c.name, status: c.status, conclusion: c.conclusion ?? '' })),
    }),
  ) as PrStatus;
}

const running: Check[] = [
  { name: 'test', status: 'IN_PROGRESS' },
  { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
];
const passed: Check[] = [
  { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
];
const failed: Check[] = [
  { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
  { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
];

/** Feed answers in order; return each step's event outcome (or null). */
function run(answers: (PrStatus | null)[], start?: CiWatch): (string | null)[] {
  let watch = start;
  return answers.map((a) => {
    const step = ciStep(watch, a);
    watch = step.watch;
    return step.event?.outcome ?? null;
  });
}

describe('ciStep', () => {
  it('pending -> pass fires once', () => {
    expect(run([pr('a', running), pr('a', passed), pr('a', passed)])).toEqual([null, 'pass', null]);
  });

  it('pending -> fail fires once, naming the failing job', () => {
    const first = ciStep(undefined, pr('a', running));
    const step = ciStep(first.watch, pr('a', failed));
    expect(step.event).toMatchObject({ outcome: 'fail', sha: 'a', prNumber: 12, job: 'test', count: 1 });
    expect(ciStep(step.watch, pr('a', failed)).event).toBeNull();
  });

  it('says why a job failed when it was cancelled or timed out', () => {
    const first = ciStep(undefined, pr('a', running));
    const step = ciStep(first.watch, pr('a', [{ name: 'test', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]));
    expect(step.event).toMatchObject({ outcome: 'fail', job: 'test', reason: 'timed out' });
    const cancelled = ciStep(first.watch, pr('a', [{ name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED' }]));
    expect(cancelled.event?.reason).toBe('cancelled');
  });

  it('never fires for a result already final when first seen', () => {
    expect(run([pr('a', passed), pr('a', passed)])).toEqual([null, null]);
    expect(run([pr('a', failed), pr('a', failed)])).toEqual([null, null]);
  });

  it('never fires twice for the same commit and outcome', () => {
    // Fail, rerun (pending again), fail again: one banner.
    expect(run([pr('a', running), pr('a', failed), pr('a', running), pr('a', failed)])).toEqual([null, 'fail', null, null]);
  });

  it('a rerun that goes green on the same commit is a new outcome', () => {
    expect(run([pr('a', running), pr('a', failed), pr('a', running), pr('a', passed)])).toEqual([null, 'fail', null, 'pass']);
  });

  it('a new push starts over', () => {
    expect(run([pr('a', running), pr('a', passed), pr('b', running), pr('b', passed)])).toEqual([null, 'pass', null, 'pass']);
  });

  it('a new push already final when first seen says nothing', () => {
    expect(run([pr('a', running), pr('a', passed), pr('b', failed)])).toEqual([null, 'pass', null]);
  });

  it('says nothing for a PR merged or closed while its checks ran', () => {
    expect(run([pr('a', running), pr('a', passed, 'merged')])).toEqual([null, null]);
    expect(run([pr('a', running), pr('a', failed, 'closed')])).toEqual([null, null]);
    // And a reopen with the same result is not news either.
    expect(run([pr('a', running), pr('a', passed, 'closed'), pr('a', passed)])).toEqual([null, null, null]);
  });

  it('a draft is watched like an open PR', () => {
    expect(run([pr('a', running, 'draft'), pr('a', passed, 'draft')])).toEqual([null, 'pass']);
  });

  it('keeps what it knew through a "no PR" answer (gh dropping out)', () => {
    expect(run([pr('a', running), null, pr('a', passed)])).toEqual([null, null, 'pass']);
  });

  it('only a pending -> final step counts, not "no checks" -> final', () => {
    expect(run([pr('a', []), pr('a', passed)])).toEqual([null, null]);
  });
});

describe('ciBanner', () => {
  it('words a pass and a failure as the issue asks', () => {
    expect(ciBanner({ outcome: 'pass', sha: 'a', prNumber: 12, count: 3 }, 'Fix login', 1)).toEqual({
      title: '✓ Checks passed: Fix login (#12)',
      body: 'All 3 checks passed.',
    });
    expect(
      ciBanner({ outcome: 'fail', sha: 'a', prNumber: 12, count: 2, job: 'CI / test', reason: 'timed out' }, 'Fix login', 1),
    ).toEqual({ title: '✗ Checks failed: Fix login (#12)', body: 'CI / test (timed out) and 1 more' });
  });

  it('falls back to the task id with no title', () => {
    expect(ciBanner({ outcome: 'pass', sha: 'a', prNumber: 3, count: 1 }, '  ', 9).title).toBe('✓ Checks passed: Task 9 (#3)');
  });
});
