/**
 * Context-window occupancy and rolling-window usage.
 *
 * The two failure modes these guard are both "looks plausible, is wrong":
 * reading `input_tokens` alone (near zero under caching, so a full session
 * renders empty), and letting an estimated band go negative against a
 * measured total.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; binds: unknown[] }[],
  handler: null as null | ((sql: string, binds: unknown[]) => unknown),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (sql: string, binds: unknown[]) => {
        state.calls.push({ sql, binds });
        if (state.handler === null) throw new Error('no handler configured');
        return state.handler(sql, binds);
      },
      execute: async () => ({ rowsAffected: 0 }),
    }),
  },
}));

import {
  CHARS_PER_TOKEN,
  CONTEXT_WINDOW_TIERS,
  contextBands,
  contextUsage,
  contextUsageForSessions,
  deriveContextBands,
  deriveContextUsage,
  aggregateUsageRows,
  pickWindowTier,
  withReportedWindow,
  type ContextUsage,
} from './context';
import {
  deriveWindowUsage,
  MIN_BURN_ELAPSED_MS,
  sumUsage,
  usageBreakdown,
  usageSummary,
  USAGE_WINDOW_MS,
  WEEK_WINDOW_MS,
  windowUsage,
} from './usage';
import { resetDb } from '../db';

// A real shape observed on a live session holding ~198k of context.
const REAL_SAMPLE = { input_tokens: 2, cache_read_input_tokens: 186_919, cache_creation_input_tokens: 10_889 };
const REAL_TOTAL = 2 + 186_919 + 10_889; // 197,810

function assistantLine(opts: {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  model?: string;
  ts?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's',
    timestamp: new Date(opts.ts ?? 0).toISOString(),
    message: {
      model: opts.model ?? 'claude-opus-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: opts.input ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  });
}

beforeEach(() => {
  resetDb();
  state.calls = [];
  state.handler = null;
  // The JSON1-fallback tests warn on purpose; keep the run readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('used = sum of all three input counters', () => {
  it('sums input + cache_read + cache_creation, never input_tokens alone', () => {
    const usage = deriveContextUsage({
      latestRawJson: assistantLine({
        input: REAL_SAMPLE.input_tokens,
        cacheRead: REAL_SAMPLE.cache_read_input_tokens,
        cacheCreation: REAL_SAMPLE.cache_creation_input_tokens,
      }),
      latestTs: 1_000,
      peakUsed: 0,
    });
    expect(usage?.used).toBe(REAL_TOTAL);
    // The obvious wrong implementation: under prompt caching input_tokens is 2,
    // so a session holding ~198k of context would render as empty.
    expect(usage?.used).not.toBe(REAL_SAMPLE.input_tokens);
    expect(usage?.fraction).toBeCloseTo(REAL_TOTAL / 200_000, 5);
    expect(usage?.fraction).toBeGreaterThan(0.98);
  });

  it('measures the latest turn, never a sum across turns', () => {
    // Each turn's input counters describe that turn's WHOLE prompt, so adding
    // turns together multiply-counts the same conversation.
    const rows = [
      { sessionId: 's', seq: 100, rawJson: assistantLine({ cacheRead: 50_000 }), ts: 1 },
      { sessionId: 's', seq: 200, rawJson: assistantLine({ cacheRead: 60_000 }), ts: 2 },
      { sessionId: 's', seq: 300, rawJson: assistantLine({ cacheRead: 70_000 }), ts: 3 },
    ];
    const input = aggregateUsageRows(rows).get('s');
    expect(input?.peakUsed).toBe(70_000);
    expect(deriveContextUsage(input!)?.used).toBe(70_000); // not 180,000
  });

  it('collapses the several rows one assistant line expands into', () => {
    const raw = assistantLine({ cacheRead: 90_000 });
    const rows = [
      { sessionId: 's', seq: 200, rawJson: raw, ts: 5 }, // thinking
      { sessionId: 's', seq: 201, rawJson: raw, ts: 5 }, // text
      { sessionId: 's', seq: 202, rawJson: raw, ts: 5 }, // tool_use
    ];
    expect(aggregateUsageRows(rows).get('s')?.peakUsed).toBe(90_000);
  });

  it('returns null for a session with no assistant usage record', () => {
    expect(deriveContextUsage({ latestRawJson: null, latestTs: null, peakUsed: 0 })).toBeNull();
    expect(
      deriveContextUsage({ latestRawJson: '{"type":"user"}', latestTs: 1, peakUsed: 0 }),
    ).toBeNull();
    expect(deriveContextUsage({ latestRawJson: '{ truncated', latestTs: 1, peakUsed: 0 })).toBeNull();
  });

  it('reports the model and measurement time', () => {
    const usage = deriveContextUsage({
      latestRawJson: assistantLine({ cacheRead: 1_000, model: 'claude-sonnet-5' }),
      latestTs: 4_242,
      peakUsed: 0,
    });
    expect(usage?.model).toBe('claude-sonnet-5');
    expect(usage?.at).toBe(4_242);
  });
});

describe('pickWindowTier — peak-based inference', () => {
  it('picks the smallest tier that fits', () => {
    expect(pickWindowTier(0).limit).toBe(200_000);
    expect(pickWindowTier(150_000).limit).toBe(200_000);
    expect(pickWindowTier(200_000).limit).toBe(200_000);
    expect(pickWindowTier(200_001).limit).toBe(1_000_000);
    expect(pickWindowTier(900_000).limit).toBe(1_000_000);
  });

  it("is 'inferred' below the top tier — a 1M session looks identical there", () => {
    expect(pickWindowTier(0).limitBasis).toBe('inferred');
    expect(pickWindowTier(199_999).limitBasis).toBe('inferred');
    expect(pickWindowTier(200_000).limitBasis).toBe('inferred');
  });

  it("is 'known' once the session has outgrown every smaller tier", () => {
    // Past 200k the session demonstrably is not a 200k session, and 1M is the
    // only tier left, so the limit is deduced rather than guessed.
    expect(pickWindowTier(200_001).limitBasis).toBe('known');
    expect(pickWindowTier(750_000).limitBasis).toBe('known');
  });

  it('stays honest when peak exceeds the whole table', () => {
    const over = pickWindowTier(2_000_000);
    expect(over.limit).toBe(1_000_000);
    expect(over.limitBasis).toBe('inferred'); // the table is stale, do not claim certainty
  });

  it('keeps the tier table ascending', () => {
    const sorted = [...CONTEXT_WINDOW_TIERS].sort((a, b) => a - b);
    expect([...CONTEXT_WINDOW_TIERS]).toEqual(sorted);
  });
});

describe('peak drives the denominator, not the latest turn', () => {
  it('does not shrink the limit back after a compaction', () => {
    // Session grew past 200k (so it is a 1M session), then compacted to 50k.
    const usage = deriveContextUsage({
      latestRawJson: assistantLine({ cacheRead: 50_000 }),
      latestTs: 10,
      peakUsed: 250_000,
    });
    expect(usage?.used).toBe(50_000);
    expect(usage?.limit).toBe(1_000_000);
    expect(usage?.limitBasis).toBe('known');
    expect(usage?.fraction).toBeCloseTo(0.05, 6);
  });

  it('never lets the latest turn exceed the peak it was given', () => {
    const usage = deriveContextUsage({
      latestRawJson: assistantLine({ cacheRead: 300_000 }),
      latestTs: 10,
      peakUsed: 0, // caller passed a stale peak
    });
    expect(usage?.limit).toBe(1_000_000);
  });

  it('clamps fraction into 0..1', () => {
    const usage = deriveContextUsage({
      latestRawJson: assistantLine({ cacheRead: 5_000_000 }),
      latestTs: 10,
      peakUsed: 5_000_000,
    });
    expect(usage?.fraction).toBe(1);
  });
});

describe('contextBands', () => {
  const measured: ContextUsage = {
    used: 100_000,
    limit: 200_000,
    fraction: 0.5,
    limitBasis: 'inferred',
    model: 'claude-opus-5',
    at: 1,
  };

  it('splits measured total into an estimated conversation and overhead', () => {
    const bands = deriveContextBands(measured, 200_000 * CHARS_PER_TOKEN * 0.3);
    expect(bands.totalUsed).toBe(100_000);
    expect(bands.conversationEst).toBe(60_000);
    expect(bands.overheadEst).toBe(40_000);
    expect(bands.conversationEst + bands.overheadEst).toBe(bands.totalUsed);
  });

  it('CLAMPS rather than rendering a negative overhead band', () => {
    // The estimate is independent of the measurement, so it can exceed it --
    // dense-tokenizing bodies, or a session compacted since the bodies were
    // stored. A negative band would be visible nonsense.
    const bands = deriveContextBands(measured, 100_000_000);
    expect(bands.conversationEst).toBe(100_000);
    expect(bands.overheadEst).toBe(0);
    expect(bands.overheadEst).toBeGreaterThanOrEqual(0);
    expect(bands.conversationEst).toBeLessThanOrEqual(bands.totalUsed);
  });

  it('handles zero and negative char counts without going negative', () => {
    expect(deriveContextBands(measured, 0).conversationEst).toBe(0);
    expect(deriveContextBands(measured, 0).overheadEst).toBe(100_000);
    expect(deriveContextBands(measured, -5).conversationEst).toBe(0);
  });

  it('withholds freeEst while the limit is only inferred', () => {
    expect(deriveContextBands(measured, 1_000).freeEst).toBeNull();
  });

  it('reports freeEst once the limit is deduced', () => {
    const known: ContextUsage = { ...measured, used: 300_000, limit: 1_000_000, limitBasis: 'known' };
    expect(deriveContextBands(known, 1_000).freeEst).toBe(700_000);
  });

  it('labels every band so the UI cannot present an estimate as measured', () => {
    expect(deriveContextBands(measured, 1_000).basis).toEqual({
      total: 'measured',
      conversation: 'estimated',
      overhead: 'estimated',
    });
  });

  it('returns null for a session with no reading yet', async () => {
    state.handler = (sql) => (sql.includes('peak_used') ? [] : [{ chars: 0 }]);
    expect(await contextBands('nope')).toBeNull();
  });

  it('reads body chars for the session end to end', async () => {
    state.handler = (sql) => {
      if (sql.includes('peak_used')) {
        return [
          {
            session_id: 's1',
            latest_ts: 9,
            latest_raw: assistantLine({ cacheRead: 100_000 }),
            peak_used: 100_000,
          },
        ];
      }
      return [{ chars: 40_000 }];
    };
    const bands = await contextBands('s1');
    expect(bands?.totalUsed).toBe(100_000);
    expect(bands?.conversationEst).toBe(10_000); // 40,000 chars / 4
    expect(bands?.overheadEst).toBe(90_000);
  });
});

describe('contextUsageForSessions — one query, not N', () => {
  it('issues a single query for many sessions', async () => {
    state.handler = () => [
      { session_id: 'a', latest_ts: 1, latest_raw: assistantLine({ cacheRead: 10 }), peak_used: 10 },
      { session_id: 'b', latest_ts: 2, latest_raw: assistantLine({ cacheRead: 20 }), peak_used: 20 },
      { session_id: 'c', latest_ts: 3, latest_raw: assistantLine({ cacheRead: 30 }), peak_used: 30 },
    ];
    const map = await contextUsageForSessions(['a', 'b', 'c']);
    expect(state.calls).toHaveLength(1);
    expect(map.size).toBe(3);
    expect(map.get('b')?.used).toBe(20);
  });

  it('de-duplicates and skips empty session ids without extra queries', async () => {
    state.handler = () => [];
    await contextUsageForSessions(['a', 'a', '', 'a']);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.binds).toEqual(['a', 'a']); // bound once per IN clause
  });

  it('issues no query at all for an empty list', async () => {
    state.handler = () => [];
    expect((await contextUsageForSessions([])).size).toBe(0);
    expect(state.calls).toHaveLength(0);
  });

  it('omits sessions with no usable reading rather than zeroing them', async () => {
    state.handler = () => [
      { session_id: 'a', latest_ts: 1, latest_raw: assistantLine({ cacheRead: 10 }), peak_used: 10 },
      { session_id: 'b', latest_ts: 2, latest_raw: null, peak_used: 0 },
    ];
    const map = await contextUsageForSessions(['a', 'b']);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false); // not a 0% gauge
  });

  it('falls back to row scanning when the database lacks JSON1', async () => {
    state.handler = (sql) => {
      if (sql.includes('json_extract')) throw new Error('no such function: json_extract');
      return [
        { session_id: 'a', seq: 100, raw_json: assistantLine({ cacheRead: 40_000 }), ts: 1 },
        { session_id: 'a', seq: 200, raw_json: assistantLine({ cacheRead: 80_000 }), ts: 2 },
      ];
    };
    const map = await contextUsageForSessions(['a']);
    expect(map.get('a')?.used).toBe(80_000); // latest line
  });

  it('contextUsage is the single-session form of the batch call', async () => {
    state.handler = () => [
      { session_id: 'solo', latest_ts: 7, latest_raw: assistantLine({ cacheRead: 55 }), peak_used: 55 },
    ];
    expect((await contextUsage('solo'))?.used).toBe(55);
    state.calls = [];
    state.handler = () => [];
    expect(await contextUsage('missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('deriveWindowUsage — boundary arithmetic', () => {
  const NOW = 1_000_000_000_000;
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    oldestTs: null,
  };

  it('handles a window with zero rows', () => {
    const w = deriveWindowUsage(empty, USAGE_WINDOW_MS, NOW);
    expect(w.windowStart).toBe(NOW - USAGE_WINDOW_MS);
    expect(w.windowEnd).toBe(NOW); // nothing is waiting to age out
    expect(w.resetsInMs).toBe(0);
    expect(w.inputTokens).toBe(0);
    expect(w.outputTokens).toBe(0);
    expect(w.burnRate).toBe(0);
    expect(Number.isFinite(w.burnRate)).toBe(true);
  });

  it('ends the window when the oldest counted turn ages out', () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const w = deriveWindowUsage(
      { ...empty, inputTokens: 1_000, oldestTs: NOW - twoHours },
      USAGE_WINDOW_MS,
      NOW,
    );
    expect(w.windowStart).toBe(NOW - USAGE_WINDOW_MS);
    expect(w.windowEnd).toBe(NOW - twoHours + USAGE_WINDOW_MS);
    expect(w.resetsInMs).toBe(USAGE_WINDOW_MS - twoHours);
  });

  it('never reports a negative time to reset', () => {
    const w = deriveWindowUsage(
      { ...empty, oldestTs: NOW - USAGE_WINDOW_MS * 2 },
      USAGE_WINDOW_MS,
      NOW,
    );
    expect(w.resetsInMs).toBe(0);
  });

  it('sums only the SPENT input counters, holding cache_read aside', () => {
    const w = deriveWindowUsage(
      {
        inputTokens: 100,
        outputTokens: 7,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 300,
        oldestTs: NOW - 3_600_000,
      },
      USAGE_WINDOW_MS,
      NOW,
    );
    expect(w.inputTokens).toBe(120); // not 420
    expect(w.cacheReadTokens).toBe(300);
    expect(w.outputTokens).toBe(7);
  });

  it('computes burn rate per hour over the stretch activity covers', () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const w = deriveWindowUsage(
      { ...empty, inputTokens: 5_000, outputTokens: 1_000, oldestTs: NOW - twoHours },
      USAGE_WINDOW_MS,
      NOW,
    );
    expect(w.burnRate).toBeCloseTo(3_000, 6); // 6,000 tokens over 2h
  });

  it('floors the burn-rate denominator so a fresh window is not absurd', () => {
    const w = deriveWindowUsage(
      { ...empty, inputTokens: 1_000, oldestTs: NOW - 1_000 },
      USAGE_WINDOW_MS,
      NOW,
    );
    // one second in: without the floor this reads 3,600,000 tokens/hour
    expect(w.burnRate).toBeCloseTo(1_000 / (MIN_BURN_ELAPSED_MS / 3_600_000), 6);
    expect(w.burnRate).toBeLessThan(100_000);
  });

  it('uses the same arithmetic for the weekly window', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    const w = deriveWindowUsage({ ...empty, inputTokens: 10, oldestTs: NOW - oneDay }, WEEK_WINDOW_MS, NOW);
    expect(w.windowStart).toBe(NOW - WEEK_WINDOW_MS);
    expect(w.resetsInMs).toBe(WEEK_WINDOW_MS - oneDay);
  });
});

describe('windowUsage aggregates across sessions', () => {
  const NOW = 1_000_000_000_000;

  it('counts every session, because the quota is account-wide', async () => {
    state.handler = (sql, binds) => {
      expect(sql).toContain('oldest_ts');
      // the query is not scoped to any session
      expect(sql).not.toContain('session_id IN');
      expect(binds).toEqual([NOW - USAGE_WINDOW_MS, NOW]);
      return [
        {
          input_tokens: 900,
          output_tokens: 90,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          line_count: 3,
          oldest_ts: NOW - 3_600_000,
        },
      ];
    };
    const w = await windowUsage('5h', NOW);
    expect(state.calls).toHaveLength(1);
    expect(w.inputTokens).toBe(900);
    expect(w.outputTokens).toBe(90);
    expect(w.burnRate).toBeCloseTo(990, 6);
  });

  it('spans seven days for the weekly form', async () => {
    state.handler = (_sql, binds) => {
      expect(binds).toEqual([NOW - WEEK_WINDOW_MS, NOW]);
      return [
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          line_count: 0,
          oldest_ts: null,
        },
      ];
    };
    const w = await windowUsage('week', NOW);
    expect(w.windowStart).toBe(NOW - WEEK_WINDOW_MS);
    expect(w.resetsInMs).toBe(0);
  });

  it('adds up distinct sessions on the fallback path', async () => {
    state.handler = (sql) => {
      if (sql.includes('json_extract')) throw new Error('no such function: json_extract');
      return [
        { session_id: 'a', seq: 100, raw_json: assistantLine({ input: 10, output: 1 }), ts: NOW - 1_000 },
        { session_id: 'b', seq: 100, raw_json: assistantLine({ input: 20, output: 2 }), ts: NOW - 1_000 },
        { session_id: 'c', seq: 100, raw_json: assistantLine({ input: 30, output: 3 }), ts: NOW - 1_000 },
      ];
    };
    const w = await windowUsage('5h', NOW);
    expect(w.inputTokens).toBe(60);
    expect(w.outputTokens).toBe(6);
  });

  it('keeps usageBreakdown components separate on the SQL path too', async () => {
    state.handler = () => [
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 300,
        line_count: 1,
        oldest_ts: NOW - 3_600_000,
      },
    ];
    const b = await usageBreakdown(NOW);
    expect(b.cacheCreationInputTokens).toBe(20);
    expect(b.cacheReadInputTokens).toBe(300);
    // usageSummary folds all three input-side counters together
    state.handler = () => [
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 300,
        line_count: 1,
        oldest_ts: NOW - 3_600_000,
      },
    ];
    const s = await usageSummary(NOW);
    expect(s.inputTokens).toBe(120); // 100 fresh + 20 cache_creation, NOT + 300
    expect(s.cacheReadTokens).toBe(300);
    expect(s.sinceTs).toBe(NOW - USAGE_WINDOW_MS);
  });

  it('does NOT grow with turn count from the cache_read term', () => {
    // The regression. A session holding a large cached context re-reports that
    // same cache_read on every turn. Summing it across a window counted the
    // same content once per turn: 872 turns x 186k produced 206M "tokens" in
    // five hours. Spend must scale with what each turn actually added, not
    // with how long the conversation is.
    const CACHE = 186_000;
    const build = (turns: number) =>
      Array.from({ length: turns }, (_, i) => ({
        sessionId: 's',
        seq: i * 100,
        rawJson: assistantLine({ input: 10, cacheCreation: 100, cacheRead: CACHE, output: 50 }),
        ts: 1_000 + i,
      }));

    const ten = deriveWindowUsage(sumUsage(build(10), 0), USAGE_WINDOW_MS, NOW);
    const eighty = deriveWindowUsage(sumUsage(build(80), 0), USAGE_WINDOW_MS, NOW);

    // Fresh spend scales with turns: 8x the turns, 8x the spend.
    expect(ten.inputTokens).toBe(10 * 110);
    expect(eighty.inputTokens).toBe(80 * 110);

    // And the cached context never enters that figure, at any turn count.
    expect(ten.inputTokens).toBeLessThan(CACHE);
    expect(eighty.inputTokens).toBeLessThan(CACHE);

    // It is still reported, just separately and never added in.
    expect(eighty.cacheReadTokens).toBe(80 * CACHE);
    expect(eighty.inputTokens + eighty.outputTokens).toBeLessThan(eighty.cacheReadTokens / 100);
  });

  it('keeps the burn rate free of the same inflation', () => {
    const oneHour = 3_600_000;
    const w = deriveWindowUsage(
      {
        inputTokens: 1_000,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 200_000_000, // the term that inflated everything
        outputTokens: 500,
        oldestTs: NOW - oneHour,
      },
      USAGE_WINDOW_MS,
      NOW,
    );
    expect(w.burnRate).toBeCloseTo(2_000, 6); // 1000 + 500 + 500 over one hour
  });

  it('usageSummary reports spend and cache reads as separate figures', async () => {
    state.handler = () => [
      {
        input_tokens: 1_744,
        output_tokens: 965_174,
        cache_creation_input_tokens: 4_827_054,
        cache_read_input_tokens: 205_860_130,
        line_count: 872,
        oldest_ts: NOW - 3_600_000,
      },
    ];
    const s = await usageSummary(NOW);
    // The real five-hour numbers from the user's database.
    expect(s.inputTokens).toBe(4_828_798); // 1,744 + 4,827,054
    expect(s.outputTokens).toBe(965_174);
    expect(s.cacheReadTokens).toBe(205_860_130);
    // Previously this reported ~210,000,000 as one figure.
    expect(s.inputTokens + s.outputTokens).toBeLessThan(6_000_000);
  });

  it('does not double-count the rows one line expands into', () => {
    const raw = assistantLine({ input: 500, output: 50 });
    const totals = sumUsage(
      [
        { sessionId: 'a', seq: 200, rawJson: raw, ts: 10 },
        { sessionId: 'a', seq: 201, rawJson: raw, ts: 10 },
        { sessionId: 'a', seq: 202, rawJson: raw, ts: 10 },
      ],
      0,
    );
    expect(totals.inputTokens).toBe(500);
    expect(totals.lineCount).toBe(1);
    expect(totals.oldestTs).toBe(10);
  });
});

describe('deriveContextUsage / model catalog', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1, cache_read_input_tokens: 144_999, cache_creation_input_tokens: 0, output_tokens: 5 },
    },
  });
  const input = { latestRawJson: line, latestTs: 1, peakUsed: 145_000 };

  it('uses the catalog window and calls it known', () => {
    const u = deriveContextUsage(input, new Map([['claude-opus-5-5', 1_000_000]]));
    expect(u?.limit).toBe(1_000_000);
    expect(u?.limitBasis).toBe('known');
    expect(u?.fraction).toBeCloseTo(0.145, 3);
  });

  it('falls back to inference for a model the catalog does not list', () => {
    const u = deriveContextUsage(input, new Map([['claude-other', 1_000_000]]));
    expect(u?.limit).toBe(200_000);
    expect(u?.limitBasis).toBe('inferred');
  });
});

describe('withReportedWindow — the status line knows the window', () => {
  const snap = (over: object = {}) => ({
    sessionId: 's', fiveHour: null, sevenDay: null, contextPct: 20, contextSize: 1_000_000, at: 5, ...over,
  });
  const inferred: ContextUsage = { used: 180_000, limit: 200_000, fraction: 0.9, limitBasis: 'inferred', model: 'm', at: 1 };

  it('replaces an inferred 200k with the reported 1M, keeping the exact count', () => {
    expect(withReportedWindow(inferred, snap())).toEqual({ ...inferred, limit: 1_000_000, fraction: 0.18, limitBasis: 'known' });
  });

  it('stands in with the reported percentage before any transcript reading', () => {
    expect(withReportedWindow(null, snap())).toMatchObject({ used: 200_000, fraction: 0.2, limitBasis: 'known' });
    expect(withReportedWindow(null, snap({ contextPct: null }))).toBeNull();
  });

  it('changes nothing without a reported size', () => {
    expect(withReportedWindow(inferred, null)).toBe(inferred);
    expect(withReportedWindow(inferred, snap({ contextSize: null }))).toBe(inferred);
  });
});
