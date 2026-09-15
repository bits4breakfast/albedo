/**
 * The trap this file exists for: `message.usage` belongs to the JSONL LINE,
 * but one line becomes several rows that all share the same raw_json. Summing
 * per row inflates the number by whatever the model happened to emit that turn.
 */

import { describe, expect, it } from 'vitest';

import { sumUsage, USAGE_WINDOW_MS } from './usage';
import { parseTranscript } from './adapter';
import basic from './fixtures/session-basic.jsonl?raw';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const SINCE = NOW - USAGE_WINDOW_MS;

const rows = parseTranscript(basic).map((r) => ({
  sessionId: r.sessionId,
  seq: r.seq,
  rawJson: r.rawJson,
  ts: r.ts,
}));

describe('sumUsage', () => {
  it('counts each assistant LINE once, not once per row it expanded into', () => {
    const total = sumUsage(rows, SINCE);
    // fixture line 2 emitted a thinking row AND a text row from one line;
    // line 5 emitted a text row and two tool_use rows. Four assistant lines
    // carry usage: msg_1, msg_2, msg_3, msg_4.
    expect(total.lineCount).toBe(4);
    expect(total.inputTokens).toBe(1200 + 90 + 2000 + 2400);
    expect(total.outputTokens).toBe(340 + 40 + 150 + 90);
    expect(total.cacheCreationInputTokens).toBe(800 + 0 + 0 + 0);
    expect(total.cacheReadInputTokens).toBe(15000 + 16000 + 17000 + 18000);
  });

  it('would double-count without line de-duplication (regression guard)', () => {
    const naive = rows.filter((r) => r.rawJson.includes('"usage"')).length;
    expect(naive).toBeGreaterThan(sumUsage(rows, SINCE).lineCount);
  });

  it('ignores rows older than the window', () => {
    const total = sumUsage(rows, NOW + 1);
    expect(total.lineCount).toBe(0);
    expect(total.inputTokens).toBe(0);
    expect(total.outputTokens).toBe(0);
  });

  it('reports sinceTs as the start of the window, not the oldest record', () => {
    expect(sumUsage(rows, SINCE).sinceTs).toBe(SINCE);
    expect(sumUsage([], SINCE).sinceTs).toBe(SINCE);
  });

  it('keeps usage from different sessions separate when de-duplicating', () => {
    const duplicated = rows.map((r) => ({ ...r, sessionId: 'other-session' }));
    const total = sumUsage([...rows, ...duplicated], SINCE);
    expect(total.lineCount).toBe(8);
  });

  it('survives rows whose raw_json is unusable', () => {
    const noisy = [
      { sessionId: 's', seq: 0, rawJson: '{ truncated', ts: NOW },
      { sessionId: 's', seq: 100, rawJson: '{"type":"assistant"}', ts: NOW },
      { sessionId: 's', seq: 200, rawJson: '{"type":"assistant","message":{"usage":"nope"}}', ts: NOW },
      {
        sessionId: 's',
        seq: 300,
        rawJson: '{"type":"assistant","message":{"usage":{"input_tokens":"x","output_tokens":7}}}',
        ts: NOW,
      },
    ];
    const total = sumUsage(noisy, SINCE);
    expect(total.lineCount).toBe(1);
    expect(total.inputTokens).toBe(0); // "x" is not a number: read defensively
    expect(total.outputTokens).toBe(7);
  });

  it('uses a 5 hour window', () => {
    expect(USAGE_WINDOW_MS).toBe(5 * 60 * 60 * 1000);
  });
});
