/**
 * The run model's inference (#443): the fraction of a slot's gap a job waits,
 * read from its first run alone. The runs themselves are tested through the
 * fold, with run lines (background.test.ts). Local times: any zone.
 */
import { describe, expect, it } from 'vitest';

import { timerFinalRun, timerRunAfter, TIMER_MAX_MS, waitFractionOf } from './timerRuns';

const local = (mo: number, d: number, h: number, mi: number, sec = 0, ms = 0) => new Date(2026, mo - 1, d, h, mi, sec, ms).getTime();
const MIN = 60_000;

describe('waitFractionOf', () => {
  it('reads the measured jobs: the wait after the slot over its gap', () => {
    expect(waitFractionOf('13,43 * * * *', local(11, 18, 11, 17, 35, 389))).toBeCloseTo((4 * MIN + 35_389) / (30 * MIN), 9);
    expect(waitFractionOf('3-59/10 * * * *', local(11, 16, 17, 57, 16, 596))).toBeCloseTo((4 * MIN + 16_596) / (10 * MIN), 9);
    expect(waitFractionOf('8 18 17 11 *', local(11, 17, 18, 8))).toBe(0);
  });

  it('is null (capped) for a first run 30 minutes after its slot', () => {
    expect(waitFractionOf('0 9,13,17 * * 1-5', local(11, 19, 9, 30))).toBeNull();
    expect(waitFractionOf('0 9,13,17 * * 1-5', local(11, 19, 9, 30, 0, 400))).toBeNull();
  });

  it('is 0 for a first run the model cannot explain, or a cron it cannot read', () => {
    // Over half the gap after its slot.
    expect(waitFractionOf('0 * * * *', local(11, 18, 13, 40))).toBe(0);
    // Hours past any slot.
    expect(waitFractionOf('0 9 * * *', local(11, 18, 13, 0))).toBe(0);
    expect(waitFractionOf('not a cron', local(11, 18, 13, 0))).toBe(0);
  });
});

describe('timerRunAfter and timerFinalRun', () => {
  const created = local(11, 18, 10, 50, 55);
  const first = local(11, 18, 11, 17, 35, 389);
  const facts = { cron: '13,43 * * * *', createdAt: created, firstRunAt: first, firedAt: [] };

  it('is the reported first run while it is ahead, then counted from the last run', () => {
    expect(timerRunAfter(facts, created)).toBe(first);
    expect(timerRunAfter({ ...facts, firedAt: [local(11, 18, 12, 50)] }, local(11, 18, 12, 51))).toBeCloseTo(local(11, 18, 13, 17, 35, 389), 0);
  });

  it('counts from creation with no first run reported, waiting nothing after the slot', () => {
    expect(timerRunAfter({ ...facts, firstRunAt: null }, created)).toBe(local(11, 18, 11, 13));
  });

  it('is null past the first run for a cron it cannot read', () => {
    expect(timerRunAfter({ ...facts, cron: '@hourly' }, first)).toBeNull();
    expect(timerFinalRun({ ...facts, cron: '@hourly' })).toBeNull();
  });

  it('the last run is the first at or past 7 days', () => {
    const final = timerFinalRun(facts)!;
    expect(final).toBeGreaterThanOrEqual(created + TIMER_MAX_MS);
    expect(final - (created + TIMER_MAX_MS)).toBeLessThan(30 * MIN);
    expect(new Date(final).getMinutes() % 30).toBe(17);
  });
});
