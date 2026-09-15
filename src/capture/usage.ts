/**
 * src/capture/usage.ts
 *
 * Token consumption over the rolling subscription windows, read back out of
 * the `usage` records Claude Code writes into each assistant line.
 *
 * Counted across ALL sessions: the quota is account-wide, which is the whole
 * reason a header-level figure exists.
 *
 * DELIBERATELY ABSENT: any percentage-of-plan-limit. Nothing on disk carries
 * the plan's token allowance or its reset time -- ~/.claude/stats-cache.json
 * holds historical totals only, policy-limits.json holds policy restrictions
 * rather than quota, and no cached JSON under ~/.claude carries a
 * rate-limit/reset/utilisation field. Being confidently wrong about "how much
 * have I got left" is worse than not answering, so this module reports real
 * counts and rates and leaves the denominator to a future setting.
 *
 * Presentation belongs to the header; this module returns raw numbers.
 */

import { contextUsedFrom, extractUsage, SEQ_STRIDE } from './adapter';
import { getAssistantRowsSince, getWindowUsageTotals } from '../db';

/** Claude subscription usage is metered over a rolling 5-hour window. */
export const USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;

/** The longer rolling window. */
export const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Floor on the elapsed time used for the burn-rate denominator. Without it,
 * one turn thirty seconds into a window divides by ~0 and reports a rate in
 * the millions of tokens/hour.
 */
export const MIN_BURN_ELAPSED_MS = 60_000;

export const WINDOW_SPANS: Readonly<Record<'5h' | 'week', number>> = {
  '5h': USAGE_WINDOW_MS,
  week: WEEK_WINDOW_MS,
};

// ---------------------------------------------------------------------------
// Shared aggregation
// ---------------------------------------------------------------------------

export interface UsageBreakdown {
  /** Fresh, uncached prompt tokens plus both cache counters. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Assistant turns counted. Useful for sanity-checking the window. */
  lineCount: number;
  sinceTs: number;
  /** ts of the oldest counted turn, or null when nothing is in the window. */
  oldestTs: number | null;
}

/**
 * One query for a window, shared by usageSummary and windowUsage so the two
 * can never drift apart.
 *
 * Primary path aggregates in SQLite. The fallback re-derives in TypeScript
 * from raw rows, for a SQLite build without the JSON1 functions.
 */
async function aggregateWindow(startTs: number, endTs: number): Promise<UsageBreakdown> {
  try {
    const totals = await getWindowUsageTotals(startTs, endTs);
    // Counters come back separately, exactly as sumUsage reports them, so
    // usageBreakdown() means the same thing on both paths.
    return {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreationInputTokens: totals.cacheCreationInputTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      lineCount: totals.lineCount,
      sinceTs: startTs,
      oldestTs: totals.oldestTs,
    };
  } catch (err) {
    console.warn('[usage] SQL aggregate unavailable, falling back', err);
    const rows = await getAssistantRowsSince(startTs, endTs);
    return sumUsage(rows, startTs);
  }
}

// ---------------------------------------------------------------------------
// usageSummary — the header's existing call. Signature unchanged.
// ---------------------------------------------------------------------------

export interface UsageSummary {
  /**
   * TOTAL input-side tokens: `input_tokens + cache_creation_input_tokens +
   * cache_read_input_tokens`.
   *
   * ASSUMPTION (unverifiable from the transcript alone): Anthropic does not
   * publish how the 5h subscription window is metered, so which of the three
   * input counters it charges is a guess. The total is the conservative
   * choice. `usageBreakdown()` returns the components separately.
   */
  inputTokens: number;
  outputTokens: number;
  /** Start of the window, epoch ms: always `now - 5h`. */
  sinceTs: number;
}

export async function usageSummary(now: number = Date.now()): Promise<UsageSummary> {
  const b = await usageBreakdown(now);
  return {
    inputTokens: b.inputTokens + b.cacheCreationInputTokens + b.cacheReadInputTokens,
    outputTokens: b.outputTokens,
    sinceTs: b.sinceTs,
  };
}

export async function usageBreakdown(now: number = Date.now()): Promise<UsageBreakdown> {
  return aggregateWindow(now - USAGE_WINDOW_MS, now);
}

// ---------------------------------------------------------------------------
// windowUsage — the /usage-style rolling window display
// ---------------------------------------------------------------------------

export interface WindowUsage {
  windowStart: number;
  windowEnd: number;
  inputTokens: number;
  outputTokens: number;
  /** ms until windowEnd. */
  resetsInMs: number;
  /** Tokens per hour over the window so far. */
  burnRate: number;
}

/**
 * Usage over a rolling window, across all sessions.
 *
 * ON THE WINDOW BOUNDS. Anthropic's real quota anchor is not on disk, so this
 * models a TRUE ROLLING window and says so:
 *
 *   windowStart = now - span. The earliest turn still counted. (Matches
 *                 usageSummary().sinceTs, which the header already uses.)
 *   windowEnd   = oldest counted turn + span. The instant that turn ages out
 *                 and headroom starts coming back. With nothing in the window
 *                 there is nothing to wait for, so it is `now`.
 *   resetsInMs  = max(0, windowEnd - now).
 *
 * So `resetsInMs` means "when consumption starts being returned to you", NOT
 * "when a fixed quota bucket resets" -- that anchor is not derivable. The
 * header should label it accordingly.
 */
export async function windowUsage(
  kind: '5h' | 'week',
  now: number = Date.now(),
): Promise<WindowUsage> {
  const span = WINDOW_SPANS[kind];
  const windowStart = now - span;
  const totals = await aggregateWindow(windowStart, now);
  return deriveWindowUsage(totals, span, now);
}

/** Pure core of windowUsage, exported for testing. */
export function deriveWindowUsage(
  totals: Pick<UsageBreakdown, 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens' | 'oldestTs'>,
  span: number,
  now: number,
): WindowUsage {
  const inputTokens =
    totals.inputTokens + totals.cacheCreationInputTokens + totals.cacheReadInputTokens;
  const outputTokens = totals.outputTokens;
  const windowStart = now - span;

  const windowEnd = totals.oldestTs === null ? now : totals.oldestTs + span;
  const resetsInMs = Math.max(0, windowEnd - now);

  // Rate over the stretch activity actually covers, floored so a window that
  // has barely started cannot report an absurd extrapolation.
  const elapsedMs =
    totals.oldestTs === null ? 0 : Math.max(now - totals.oldestTs, MIN_BURN_ELAPSED_MS);
  const burnRate = elapsedMs === 0 ? 0 : (inputTokens + outputTokens) / (elapsedMs / 3_600_000);

  return {
    windowStart,
    windowEnd,
    inputTokens,
    outputTokens,
    resetsInMs,
    burnRate,
  };
}

// ---------------------------------------------------------------------------
// TypeScript fallback aggregation
// ---------------------------------------------------------------------------

/**
 * Pure core of the fallback path, exported for testing.
 *
 * `message.usage` belongs to the JSONL LINE, but one assistant line expands
 * into several rows carrying the same verbatim raw_json. Summing per row would
 * multiply the bill. Rows are collapsed by (sessionId, line index), which is
 * recoverable from seq because seq = lineIndex * SEQ_STRIDE + blockIndex.
 */
export function sumUsage(
  rows: { sessionId: string; seq: number; rawJson: string; ts: number }[],
  sinceTs: number,
): UsageBreakdown {
  const seen = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let lineCount = 0;
  let oldestTs: number | null = null;

  for (const row of rows) {
    if (row.ts < sinceTs) continue;
    const lineKey = `${row.sessionId}:${Math.floor(row.seq / SEQ_STRIDE)}`;
    if (seen.has(lineKey)) continue;
    seen.add(lineKey);

    const usage = extractUsage(row.rawJson);
    if (!usage) continue;

    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheCreationInputTokens += usage.cacheCreationInputTokens;
    cacheReadInputTokens += usage.cacheReadInputTokens;
    lineCount += 1;
    if (oldestTs === null || row.ts < oldestTs) oldestTs = row.ts;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    lineCount,
    sinceTs,
    oldestTs,
  };
}

/** Context occupancy of a single turn. Re-exported for callers of this module. */
export { contextUsedFrom };
