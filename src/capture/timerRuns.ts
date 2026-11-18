/**
 * When a CronCreate job runs next (#443). Pure.
 *
 * The model is Claude Code's, measured on 2.1.327 (adapter.ts has the
 * measurements; Claude Code may change it). Each run is computed from `from`
 * -- the job's creation for the first run, the actual time of the run before
 * for every later one:
 *
 *  - `a` is the cron's next slot after `from`; `r` the gap from `a` to the
 *    slot after it.
 *  - A `*\/N * * * *` cron whose `r` is 5 minutes (what `/loop 5m` creates)
 *    runs at `from + r - 15 s`: off the slot grid, drifting by 15 s a run.
 *  - Any other runs at `a + min(k * r, 30 min)`, `k` a fraction fixed per job.
 *
 * So the wait after a slot is the same on every run only when the slots are
 * evenly spaced; after the last slot of an uneven day (`0 9,13,17 * * 1-5`:
 * 17:00, then 09:00 next morning) it is longer, up to 30 minutes.
 *
 * Nothing here reads the job id or Claude Code's settings. `k` is inferred
 * from the first run the result reports (its wait after its slot, over that
 * slot's gap; up to just under the gap, so a different multiplier than
 * today's 0.5 still reads). A first run 30 minutes after its slot hit the
 * cap, which only says `k` is at least 30 minutes over that gap: until a
 * run under the cap shows `k`, each slot is given the earliest it can run,
 * that least `k` times its gap. A first run the model cannot explain gives
 * no `k` either, and the next run sets it.
 *
 * Each run is counted from the LAST run the transcript shows
 * (`scheduled_task_fire`), not from the first, so a run
 * that came late -- the session was busy, the Mac asleep -- moves the ones
 * after it as it moves Claude Code's, and the `/loop 5m` drift never
 * accumulates. A run due with no line for it yet counts as having come on
 * time.
 */

import { cronNext, cronPrev, parseCron, type Cron } from '../lib/cron';

/** The longest wait after a slot. */
const WAIT_CAP_MS = 30 * 60_000;
/** A first run within this of the cap is taken as capped: `nextFireAt` is fractional. */
const CAP_SLACK_MS = 1_000;
/** `/loop 5m`'s rule: a `*\/N * * * *` cron whose gap is 5 minutes. */
const LOOP_CRON = /^\*\/\d+ \* \* \* \*$/;
const LOOP_GAP_MS = 5 * 60_000;
const LOOP_LEAD_MS = 15_000;
/** A recurring job ages out this long after it was created (its tool description). */
export const TIMER_MAX_MS = 7 * 24 * 60 * 60_000;

export interface TimerRunFacts {
  /** The cron expression, as the call gave it. */
  cron: string;
  /** When the job was created: its result's row. */
  createdAt: number;
  /** Its first run, as its result says (`nextFireAt`); null when it does not. */
  firstRunAt: number | null;
  /**
   * When its runs came, by the transcript's lines for them, oldest first: the
   * last few (`backgroundRowsSince` fetches up to TIMER_RUNS_KEPT); empty
   * before any.
   */
  firedAt: readonly number[];
}

/** How many of a job's latest run lines are read: enough to find one under the cap after a capped streak. */
export const TIMER_RUNS_KEPT = 8;

/**
 * How long the job waits after a slot, as far as its runs show: a fraction
 * `k` of the slot's gap, known; or, while no run has shown it, only a least
 * value -- a run 30 minutes after its slot hit the cap, which says `k` is at
 * least 30 minutes over that gap and nothing more.
 */
type Wait = { known: true; k: number } | { known: false; atLeast: number };

interface Model {
  cron: Cron;
  loop: boolean;
  wait: Wait;
}

function gapAt(c: Cron, slot: number): number | null {
  const next = cronNext(c, slot);
  return next === null ? null : next - slot;
}

/**
 * What one run says about the wait: its time after its slot, over that
 * slot's gap. Capped (30 minutes): `k` is at least that. Past the cap, or not
 * before the next slot, it is not this model's run (a late one): nothing.
 */
function waitShownBy(c: Cron, runAt: number): Wait {
  const slot = cronPrev(c, runAt);
  const gap = slot === null ? null : gapAt(c, slot);
  if (slot === null || gap === null || gap <= 0) return { known: false, atLeast: 0 };
  const wait = runAt - slot;
  if (wait >= WAIT_CAP_MS - CAP_SLACK_MS && wait <= WAIT_CAP_MS + CAP_SLACK_MS) return { known: false, atLeast: WAIT_CAP_MS / gap };
  if (wait > WAIT_CAP_MS || wait >= gap - CAP_SLACK_MS) return { known: false, atLeast: 0 };
  return { known: true, k: wait / gap };
}

/**
 * `k` from the first run (exported for tests): its wait after its slot over
 * that slot's gap; null when the run hit the cap (only a least value), 0
 * when the model cannot explain it.
 */
export function waitFractionOf(cron: string, firstRunAt: number): number | null {
  const c = parseCron(cron);
  if (c === null) return 0;
  const w = waitShownBy(c, firstRunAt);
  return w.known ? w.k : w.atLeast > 0 ? null : 0;
}

/**
 * The wait, from the first run; while that leaves it unknown, from the runs
 * since, newest first -- one is taken only when this model explains it,
 * under the cap and no shorter than the least value every capped run sets (a
 * run that came late reads longer, never shorter, so that is the one check
 * that holds).
 */
function waitOf(c: Cron, f: TimerRunFacts): Wait {
  if (f.firstRunAt === null) return { known: true, k: 0 };
  const first = waitShownBy(c, f.firstRunAt);
  if (first.known) return first;
  const shown = f.firedAt.map((t) => waitShownBy(c, t));
  let atLeast = first.atLeast;
  for (const w of shown) if (!w.known) atLeast = Math.max(atLeast, w.atLeast);
  for (let i = shown.length - 1; i >= 0; i--) {
    const w = shown[i]!;
    if (w.known && w.k >= atLeast - 1e-9) return w;
  }
  return { known: false, atLeast };
}

function modelOf(f: TimerRunFacts): Model | null {
  const cron = parseCron(f.cron);
  if (cron === null) return null;
  const loop = LOOP_CRON.test(f.cron.trim());
  return { cron, loop, wait: waitOf(cron, f) };
}

/** The wait after a slot: `k` of its gap up to the cap; while `k` is not known, the least it can be. */
function waitAfter(m: Model, slot: number): number {
  const gap = gapAt(m.cron, slot);
  if (gap === null) return 0;
  const k = m.wait.known ? m.wait.k : m.wait.atLeast;
  return Math.min(k * gap, WAIT_CAP_MS);
}

/** The loop rule's period from `from`, or null when the slot rule applies. */
function loopPeriod(m: Model, from: number): number | null {
  if (!m.loop) return null;
  const a = cronNext(m.cron, from);
  const gap = a === null ? null : gapAt(m.cron, a);
  return gap !== null && gap >= LOOP_GAP_MS && gap < LOOP_GAP_MS + LOOP_LEAD_MS ? gap - LOOP_LEAD_MS : null;
}

/**
 * The first run strictly after `t`, for a job that last ran (or was created)
 * at `from` and runs on time from then on. Runs missed between are skipped
 * over, not walked.
 */
function runAfter(m: Model, from: number, t: number): number | null {
  const period = loopPeriod(m, from);
  if (period !== null) {
    const next = from + period;
    return next > t ? next : next + (Math.floor((t - next) / period) + 1) * period;
  }
  const first = cronNext(m.cron, from);
  if (first === null) return null;
  // Each run comes before the slot after its own (the wait is under the
  // gap), so the run after `t` belongs to the last slot at or before `t` or
  // to the one after it.
  const back = cronPrev(m.cron, t);
  let slot: number | null = back !== null && back > first ? back : first;
  for (let i = 0; slot !== null && i < 4; i++) {
    const at = slot + waitAfter(m, slot);
    if (at > t) return at;
    slot = cronNext(m.cron, slot);
  }
  return null;
}

/**
 * The job's first run strictly after `t`: its reported first run while that
 * is ahead and none has come; else counted from its last run (the first, if
 * no line for it has come yet). Null when the cron is not readable and the
 * first run is past.
 */
export function timerRunAfter(f: TimerRunFacts, t: number): number | null {
  const lastFiredAt = f.firedAt.at(-1) ?? null;
  if (lastFiredAt === null && f.firstRunAt !== null && f.firstRunAt > t) return f.firstRunAt;
  const m = modelOf(f);
  if (m === null) return null;
  const from = lastFiredAt ?? f.firstRunAt;
  if (from === null) return runAfter(m, f.createdAt, t);
  return runAfter(m, from, t);
}

/**
 * The job's last run: Claude Code deletes a recurring job that has aged out
 * only after one more run, the first at or past 7 days from its creation.
 * Null when that run is not known (a cron this cannot read).
 */
export function timerFinalRun(f: TimerRunFacts): number | null {
  return timerRunAfter(f, f.createdAt + TIMER_MAX_MS - 1);
}
