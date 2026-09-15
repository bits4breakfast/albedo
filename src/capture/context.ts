/**
 * src/capture/context.ts
 *
 * Per-session context-window occupancy, for an unobtrusive "how full is this
 * session" indicator.
 *
 * Two things here are easy to get wrong and both are guarded with comments and
 * tests, because either one produces a number that looks plausible and is not:
 *
 *  1. `used` is the SUM of input_tokens + cache_read + cache_creation on ONE
 *     turn -- not `input_tokens` alone, and not a sum across turns.
 *  2. The context window SIZE is not in the transcript at all, so `limit` is
 *     inferred. `limitBasis` tells the caller how much to trust it.
 */

import {
  contextUsedFrom,
  extractUsage,
  modelOf,
  SEQ_STRIDE,
} from './adapter';
import { getSessionBodyChars, getSessionContextRows, getSessionUsageRows } from '../db';

export interface ContextUsage {
  /** Tokens occupying the context window on the most recent turn. */
  used: number;
  /** Best-known window size for the session's model. See inference note. */
  limit: number;
  /** used / limit, clamped 0..1. */
  fraction: number;
  /** How confident `limit` is: 'known' | 'inferred'. */
  limitBasis: 'known' | 'inferred';
  /** Model id from the transcript, or null. */
  model: string | null;
  /** ts of the turn this was measured from. */
  at: number | null;
}

// ---------------------------------------------------------------------------
// The limit problem
// ---------------------------------------------------------------------------

/**
 * Plausible context window sizes, ascending.
 *
 * ### THIS IS THE TABLE TO UPDATE WHEN CONTEXT LIMITS CHANGE.
 *
 * The transcript records `message.model` (observed on this machine:
 * `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `<synthetic>`) but
 * NOT the window size, and the long-context variant is not distinguishable
 * from the model id -- a `[1m]` session and a 200k session both record
 * `claude-opus-5`. I checked the whole transcript corpus for any other
 * signal: `message.context_management` exists but is null or an empty
 * `applied_edits` array, and no key anywhere carries a window or limit. So
 * the size genuinely cannot be read; it has to be inferred.
 *
 * Deliberately NOT keyed by model. Tying a guess to a model id would look
 * authoritative while being exactly as much of a guess, and would go stale
 * silently on the next model release.
 */
export const CONTEXT_WINDOW_TIERS: readonly number[] = [200_000, 1_000_000];

/**
 * Smallest tier that can hold `peakUsed`.
 *
 * Driven by the session's PEAK rather than its latest turn so the denominator
 * does not jump around as context fills, and does not shrink back after a
 * compaction drops the live figure.
 *
 * `limitBasis` is 'known' only when the tier is FORCED: the session has
 * demonstrably exceeded every smaller tier and the one left is the largest
 * that exists. Below that threshold a 200k session and a barely-used 1M
 * session are indistinguishable, so the answer is honestly 'inferred'.
 * Hardcoding 200k would report a 1M session as 99% full, which is worse than
 * reporting nothing.
 */
export function pickWindowTier(peakUsed: number): {
  limit: number;
  limitBasis: 'known' | 'inferred';
} {
  const tiers = CONTEXT_WINDOW_TIERS;
  const largest = tiers[tiers.length - 1] ?? 200_000;
  const secondLargest = tiers.length >= 2 ? (tiers[tiers.length - 2] as number) : 0;

  for (const tier of tiers) {
    if (peakUsed <= tier) {
      // Forced iff nothing smaller could have held it and this is the top tier.
      const forced = tier === largest && peakUsed > secondLargest;
      return { limit: tier, limitBasis: forced ? 'known' : 'inferred' };
    }
  }
  // Past the top of the table: the table is out of date, say so by staying
  // 'inferred' rather than claiming certainty about a limit we do not have.
  return { limit: largest, limitBasis: 'inferred' };
}

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

export interface ContextInput {
  /** raw_json of the newest line in the session carrying a usage record. */
  latestRawJson: string | null;
  latestTs: number | null;
  /** Highest occupancy seen anywhere in the session. */
  peakUsed: number;
}

/**
 * Pure core. Null when the session has no assistant line with a usage record
 * -- a session that has only a typed prompt so far has no context reading, and
 * inventing 0/200k would draw an empty gauge for a session that is mid-turn.
 */
export function deriveContextUsage(input: ContextInput): ContextUsage | null {
  if (input.latestRawJson === null) return null;
  const usage = extractUsage(input.latestRawJson);
  if (usage === null) return null;

  // All three counters, INCLUDING cache_read. Two reasons, and they pull in
  // opposite directions, so do not "fix" this to match usage.ts:
  //
  //  - `input_tokens` alone is near zero under prompt caching, so using it
  //    would draw an empty gauge for a nearly full session.
  //  - usage.ts deliberately EXCLUDES cache_read from its window totals,
  //    because it is re-reported every turn and summing it across a window
  //    counts the same cached content once per turn (~35x inflation).
  //
  // Both are right. This is ONE turn's prompt size -- occupancy -- where the
  // three counters are disjoint parts of a single prompt. That is a different
  // question from what a window SPENT. See the header of usage.ts.
  const used = contextUsedFrom(usage);
  const peak = Math.max(input.peakUsed, used);
  const { limit, limitBasis } = pickWindowTier(peak);

  return {
    used,
    limit,
    fraction: limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0,
    limitBasis,
    model: modelOf(input.latestRawJson),
    at: input.latestTs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function contextUsage(sessionId: string): Promise<ContextUsage | null> {
  const map = await contextUsageForSessions([sessionId]);
  return map.get(sessionId) ?? null;
}

/**
 * Batch form for the task list: one database round-trip for N sessions, not N.
 *
 * Sessions with no usable usage record are simply absent from the map rather
 * than present with a zeroed entry, so a caller cannot accidentally render a
 * 0% gauge for a session that has no reading yet.
 */
export async function contextUsageForSessions(
  sessionIds: string[],
): Promise<Map<string, ContextUsage>> {
  const out = new Map<string, ContextUsage>();
  const unique = [...new Set(sessionIds.filter((id) => id.length > 0))];
  if (unique.length === 0) return out;

  let inputs: Map<string, ContextInput>;
  try {
    inputs = await aggregateInDatabase(unique);
  } catch (err) {
    // Almost certainly a SQLite build without the JSON1 functions. Fall back
    // to deriving in TypeScript rather than blanking the indicator.
    console.warn('[context] SQL aggregate unavailable, falling back', err);
    inputs = await aggregateInMemory(unique);
  }

  for (const [sessionId, input] of inputs) {
    const usage = deriveContextUsage(input);
    if (usage !== null) out.set(sessionId, usage);
  }
  return out;
}

async function aggregateInDatabase(sessionIds: string[]): Promise<Map<string, ContextInput>> {
  const rows = await getSessionContextRows(sessionIds);
  const out = new Map<string, ContextInput>();
  for (const r of rows) {
    out.set(r.sessionId, {
      latestRawJson: r.latestRawJson,
      latestTs: r.latestTs,
      peakUsed: r.peakUsed,
    });
  }
  return out;
}

/**
 * Fallback aggregation, exported so the same logic is unit-testable.
 *
 * Usage belongs to the LINE, not the row: one assistant line expands into
 * several rows sharing the same raw_json, so rows are collapsed by
 * (sessionId, line index) -- recoverable from seq, which is
 * lineIndex * SEQ_STRIDE + blockIndex -- before anything is compared. Without
 * that, "latest" could be any block of the newest line, which is harmless,
 * but the peak scan would parse the same line several times over.
 */
export function aggregateUsageRows(
  rows: { sessionId: string; seq: number; rawJson: string; ts: number }[],
): Map<string, ContextInput> {
  const out = new Map<string, ContextInput>();
  const seenLines = new Set<string>();
  const latestLine = new Map<string, number>();

  for (const row of rows) {
    const lineIndex = Math.floor(row.seq / SEQ_STRIDE);
    const lineKey = `${row.sessionId}:${lineIndex}`;
    if (seenLines.has(lineKey)) continue;
    seenLines.add(lineKey);

    const usage = extractUsage(row.rawJson);
    if (usage === null) continue;
    const used = contextUsedFrom(usage);

    const existing = out.get(row.sessionId);
    if (existing === undefined) {
      out.set(row.sessionId, {
        latestRawJson: row.rawJson,
        latestTs: row.ts,
        peakUsed: used,
      });
      latestLine.set(row.sessionId, lineIndex);
      continue;
    }

    existing.peakUsed = Math.max(existing.peakUsed, used);
    if (lineIndex >= (latestLine.get(row.sessionId) ?? -1)) {
      latestLine.set(row.sessionId, lineIndex);
      existing.latestRawJson = row.rawJson;
      existing.latestTs = row.ts;
    }
  }
  return out;
}

async function aggregateInMemory(sessionIds: string[]): Promise<Map<string, ContextInput>> {
  return aggregateUsageRows(await getSessionUsageRows(sessionIds));
}

// ---------------------------------------------------------------------------
// Context bands — what /context shows, minus what is not recoverable
// ---------------------------------------------------------------------------

/**
 * Rough characters-per-token used to ESTIMATE conversation size from stored
 * message bodies.
 *
 * ~4 chars/token is the usual English rule of thumb. It is wrong in both
 * directions: code and JSON tokenize denser, non-Latin scripts far denser.
 *
 * WHAT WOULD REPLACE THIS: a real tokenizer over the same text. Until then
 * every band derived from it is reported with basis 'estimated' and the UI
 * must never present it as measured.
 */
export const CHARS_PER_TOKEN = 4;

export interface ContextBands {
  /** Measured exactly from message.usage. */
  totalUsed: number;
  /** ESTIMATED from stored message bodies for this session. */
  conversationEst: number;
  /** totalUsed - conversationEst. Static prefix: system prompt, tools, MCP, memory. */
  overheadEst: number;
  /** limit - totalUsed, or null when the limit is only inferred. */
  freeEst: number | null;
  /** Per-band confidence so the UI can never present an estimate as measured. */
  basis: { total: 'measured'; conversation: 'estimated'; overhead: 'estimated' };
}

/**
 * Two bands of the context window: roughly how much is this conversation, and
 * roughly how much is the static prefix Claude Code sends before it.
 *
 * NOT the category grid `/context` draws. That split (system prompt / system
 * tools / MCP tools / memory files / custom agents / messages / autocompact
 * buffer) is computed by Claude Code before the request goes out; the
 * transcript records only the aggregate in `message.usage`, so the per-category
 * breakdown is genuinely unrecoverable. Two honest bands beat seven invented
 * ones.
 *
 * `freeEst` is null whenever the window size is merely inferred: subtracting a
 * measured total from a guessed limit would dress a guess up as headroom.
 */
export async function contextBands(sessionId: string): Promise<ContextBands | null> {
  const usage = await contextUsage(sessionId);
  if (usage === null) return null;
  const chars = await getSessionBodyChars(sessionId);
  return deriveContextBands(usage, chars);
}

/** Pure core of contextBands, exported for testing. */
export function deriveContextBands(usage: ContextUsage, bodyChars: number): ContextBands {
  const totalUsed = usage.used;
  const rawEstimate = Math.round(Math.max(0, bodyChars) / CHARS_PER_TOKEN);

  // Clamp. The estimate is independent of the measurement, so it can exceed
  // it -- a long session whose bodies tokenize denser than 4 chars/token, or
  // one compacted since (bodies persist, context shrank). Rendering a
  // negative overhead band would be visible nonsense; pinning conversation to
  // the measured total and overhead to 0 degrades honestly.
  const conversationEst = Math.min(rawEstimate, totalUsed);
  const overheadEst = Math.max(0, totalUsed - conversationEst);

  return {
    totalUsed,
    conversationEst,
    overheadEst,
    freeEst: usage.limitBasis === 'known' ? Math.max(0, usage.limit - totalUsed) : null,
    basis: { total: 'measured', conversation: 'estimated', overhead: 'estimated' },
  };
}
