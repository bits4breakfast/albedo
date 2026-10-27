/**
 * A compaction in the transcript: the boundary, the summary, and the notice
 * Claude Code writes beside them. The fixture keeps the structure of real
 * Claude Code 2.1.309-2.1.310 lines -- order, uuids, the summary stamped 8 ms
 * before its boundary, attachment lines between it and the notice -- with
 * none of their content.
 */

import { describe, expect, it } from 'vitest';

import compaction from './fixtures/compaction.jsonl?raw';
import basic from './fixtures/session-basic.jsonl?raw';
import { compactBoundaryOf, compactSummaryOf, isNoticeLine, parseTranscript, queueFactsIn, SEQ_STRIDE } from './adapter';

const lines = compaction.split('\n').filter((l) => l.length > 0);
const line = (i: number) => lines[i] as string;

describe('compactBoundaryOf', () => {
  it('reads what the boundary recorded', () => {
    expect(compactBoundaryOf(line(2))).toEqual({ uuid: 'b-1', trigger: 'auto', preTokens: 284738, durationMs: 62969 });
    expect(compactBoundaryOf(line(8))).toEqual({ uuid: 'b-2', trigger: 'manual', preTokens: 120400, durationMs: 41200 });
  });

  it('is null for every other line', () => {
    for (const i of [0, 1, 3, 4, 5, 6, 7, 9]) expect(compactBoundaryOf(line(i))).toBeNull();
    for (const l of basic.split('\n')) expect(compactBoundaryOf(l)).toBeNull();
    expect(compactBoundaryOf('{"type":"system","subtype":"compact_bound')).toBeNull();
  });

  it('shows nothing for a field it does not know rather than guessing', () => {
    const odd = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'idle', preTokens: '5', durationMs: -1 } });
    expect(compactBoundaryOf(odd)).toEqual({ uuid: null, trigger: null, preTokens: null, durationMs: null });
    expect(compactBoundaryOf(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))?.trigger).toBeNull();
  });
});

describe('compactSummaryOf', () => {
  it('reads the whole summary and the boundary it follows', () => {
    const s = compactSummaryOf(line(3));
    expect(s?.parentUuid).toBe('b-1');
    expect(s?.text.startsWith('This session is being continued')).toBe(true);
    expect(s?.text).toContain('<tools-used-before-summary>Bash, Edit, Read</tools-used-before-summary>');
  });

  it('is null for a typed prompt, and for any other line', () => {
    for (const i of [0, 1, 2, 4, 5, 6, 7, 8]) expect(compactSummaryOf(line(i))).toBeNull();
    for (const l of basic.split('\n')) expect(compactSummaryOf(l)).toBeNull();
  });
});

describe('isNoticeLine', () => {
  it('is true for an informational system line only', () => {
    expect(lines.map((_, i) => isNoticeLine(line(i)))).toEqual(lines.map((_, i) => i === 6));
  });
});

describe('the compaction as rows', () => {
  const rows = parseTranscript(compaction);

  it('keeps every line it kept before, raw_json and body included', () => {
    expect(rows.map((r) => `${r.seq}:${r.role}`)).toEqual([
      '0:user',
      '100:assistant',
      '200:system', // boundary
      '300:user', // summary
      // 400, 500: attachment lines, never stored
      '600:system', // the notice
      '700:user',
      '800:system',
      '900:user',
    ]);
    const summary = rows.find((r) => r.seq === 3 * SEQ_STRIDE);
    expect(summary?.rawJson).toBe(line(3));
    // FTS still finds the summary: its body is the text.
    expect(summary?.body?.startsWith('This session is being continued')).toBe(true);
  });

  it('stamps the summary before its boundary: a ts-ordered read returns it first', () => {
    const boundary = rows.find((r) => r.seq === 200);
    const summary = rows.find((r) => r.seq === 300);
    expect((summary?.ts ?? 0) < (boundary?.ts ?? 0)).toBe(true);
  });

  it('never counts a summary as a prompt in the queue model', () => {
    const prompts = queueFactsIn(compaction).filter((f) => f.op === 'prompt');
    expect(prompts.map((p) => (p.op === 'prompt' ? p.text : ''))).toEqual(['Tidy the retry helper.', 'Now add a test.']);
  });
});
