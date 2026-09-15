/**
 * src/capture/usage.ts
 *
 * Token consumption over the rolling subscription window, read back out of the
 * `usage` records Claude Code writes into each assistant line.
 *
 * Presentation ("3h12m of headroom left") belongs to the header; this module
 * returns raw totals only.
 */

import { extractUsage, SEQ_STRIDE } from './adapter';
import { getAssistantRowsSince } from '../db';

/** Claude subscription usage is metered over a rolling 5-hour window. */
export const USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;

export interface UsageBreakdown {
  /** Fresh, uncached prompt tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Assistant turns counted. Useful for sanity-checking the window. */
  lineCount: number;
  sinceTs: number;
}

export interface UsageSummary {
  /**
   * TOTAL input-side tokens: `input_tokens + cache_creation_input_tokens +
   * cache_read_input_tokens`.
   *
   * ASSUMPTION (unverifiable from the transcript alone): Anthropic does not
   * publish how the 5h subscription window is metered, so which of the three
   * input counters it charges is a guess. The total is the conservative
   * choice for a "headroom" gauge. `usageBreakdown()` returns the components
   * separately for a header that wants to present them differently.
   */
  inputTokens: number;
  outputTokens: number;
  /** Start of the window, epoch ms. */
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
  const sinceTs = now - USAGE_WINDOW_MS;
  const rows = await getAssistantRowsSince(sinceTs);
  return sumUsage(rows, sinceTs);
}

/**
 * Pure core, exported for testing.
 *
 * `message.usage` belongs to the JSONL LINE, but one assistant line expands
 * into several rows (a thinking block, a text block, two tool calls...), each
 * carrying the same verbatim raw_json. Summing per row would multiply the
 * bill. Rows are therefore collapsed by (sessionId, line index), which is
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
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    lineCount,
    sinceTs,
  };
}
