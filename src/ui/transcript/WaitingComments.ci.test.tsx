/**
 * @vitest-environment jsdom
 *
 * The queued CI failure above the message box, with details (#280, step 2):
 * per check the failing step, and its log tail folded under it -- the first
 * check's open, the rest closed and openable; "Fetching details…" while they
 * come; why when they could not; unchanged on name and link only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { WaitingComments } from './WaitingComments';
import { __resetQueuedCi, detailsKey, observeCiQueue, queuedCiOf, setQueuedCiDetails } from './ciFailure';
import { parsePrView, type PrStatus } from '../../gh/prStatus';
import type { CiDetailsState } from '../../gh/ciDetails';

const SHA = 'abc1234def5678900000000000000000000000aa';
const pr = parsePrView(
  JSON.stringify({
    number: 14,
    state: 'OPEN',
    headRefName: 'fix-fractions',
    headRefOid: SHA,
    statusCheckRollup: ['build', 'lint'].map((name) => ({
      __typename: 'CheckRun',
      name,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://ci.example/job/${name}`,
    })),
  }),
) as PrStatus;

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  __resetQueuedCi();
  observeCiQueue(7, pr);
});
afterEach(cleanup);

function show(details?: CiDetailsState) {
  if (details) act(() => setQueuedCiDetails(7, detailsKey(queuedCiOf(7)!), details));
  render(<WaitingComments taskId={7} frozen={false} />);
  fireEvent.click(screen.getByRole('button', { name: /CI failed/ }));
  return screen.getByRole('group', { name: 'Waiting to be sent' });
}

const READY: CiDetailsState = {
  state: 'ready',
  checks: [
    { name: 'build', step: 'Run tests', log: ['FAIL src/recipes/fractions.test.ts', '  Expected: "⅓ cup"'], more: 38 },
    { name: 'lint', step: 'eslint', log: ['a.ts:1 no-unused-vars'], more: 0 },
  ],
};

describe('the queued CI failure, with details', () => {
  it('names each check’s failing step', () => {
    const g = show(READY);
    expect(g.textContent).toContain('build step “Run tests” · failed');
    expect(g.textContent).toContain('lint step “eslint” · failed');
  });

  it('opens the first check’s log tail, with what was cut said first; the others closed', () => {
    const g = show(READY);
    const tails = g.querySelectorAll('pre.tx-waiting-ci-log');
    expect(tails).toHaveLength(1);
    expect(tails[0]!.textContent).toBe('… 38 more lines\nFAIL src/recipes/fractions.test.ts\n  Expected: "⅓ cup"');
    expect(within(g).getByRole('button', { name: 'Hide the log of build' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(g).getByRole('button', { name: 'Show the log of lint' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens and closes a log on click', () => {
    const g = show(READY);
    fireEvent.click(within(g).getByRole('button', { name: 'Show the log of lint' }));
    expect(g.querySelectorAll('pre.tx-waiting-ci-log')).toHaveLength(2);
    fireEvent.click(within(g).getByRole('button', { name: 'Hide the log of build' }));
    const tails = g.querySelectorAll('pre.tx-waiting-ci-log');
    expect(tails).toHaveLength(1);
    expect(tails[0]!.textContent).toBe('a.ts:1 no-unused-vars');
  });

  it('says it is fetching while the details come', () => {
    const g = show({ state: 'fetching' });
    expect(within(g).getByRole('status').textContent).toBe('Fetching details…');
    expect(g.textContent).toContain('build — failed');
  });

  it('says why when they could not be fetched, and keeps names and links', () => {
    const g = show({ state: 'failed', reason: 'the command took longer than 30 s' });
    expect(g.textContent).toContain('Details could not be fetched: the command took longer than 30 s.');
    expect(within(g).getAllByRole('button', { name: /Open the details of/ })).toHaveLength(2);
  });

  it('is unchanged on name and link only', () => {
    const g = show({ state: 'none' });
    expect(g.textContent).toContain('build — failed');
    expect(g.textContent).toContain('lint — failed');
    expect(g.textContent).not.toMatch(/Fetching|could not be fetched|step/);
    expect(within(g).queryByRole('button', { name: /log of/ })).toBeNull();
  });
});
