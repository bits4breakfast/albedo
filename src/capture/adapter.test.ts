/**
 * Tests for the one module that knows the transcript format.
 *
 * These exist to catch a FORMAT REGRESSION, so they assert on concrete rows
 * and concrete seq values rather than on shapes. Fixtures are synthetic and
 * hand-written (src/capture/fixtures) — no real transcript content.
 */

import { describe, expect, it } from 'vitest';

import basic from './fixtures/session-basic.jsonl?raw';
import malformed from './fixtures/malformed.jsonl?raw';
import {
  BODY_MAX_CHARS,
  countLines,
  cwdOf,
  extractUsage,
  parseLine,
  parseTranscript,
  SEQ_STRIDE,
  stopReasonOf,
  toolCallIdOf,
  titleOf,
  lastTitleIn,
  TURN_ENDING_STOP_REASONS,
} from './adapter';
import type { ParsedMessage } from '../types';

const SESSION = '11111111-2222-3333-4444-555555555555';
const CWD = '/Users/example/agents/demo/add-retry';

function bySeq(rows: ParsedMessage[], seq: number): ParsedMessage {
  const row = rows.find((r) => r.seq === seq);
  if (!row) throw new Error(`no row at seq ${seq}; have ${rows.map((r) => r.seq).join(',')}`);
  return row;
}

describe('parseTranscript — a whole synthetic session', () => {
  const rows = parseTranscript(basic);

  it('drops bookkeeping line types entirely', () => {
    // lines 0 (`mode`) and 10 (`last-prompt`) must contribute nothing
    expect(rows.some((r) => r.seq >= 0 && r.seq < SEQ_STRIDE)).toBe(false);
    expect(rows.some((r) => r.seq >= 10 * SEQ_STRIDE)).toBe(false);
  });

  it('expands each line into exactly the documented rows', () => {
    expect(rows.map((r) => `${r.seq}:${r.role}`)).toEqual([
      '100:user', // typed prompt
      '200:assistant', // thinking
      '201:assistant', // text
      '300:tool_use', // Read
      '400:tool_result', // Read result
      '500:assistant', // text
      '501:tool_use', // Bash
      '502:tool_use', // Edit
      '600:tool_result', // Bash result (error)
      '601:tool_result', // Edit result
      '700:system', // hook output
      '800:system', // turn-duration marker, no text
      '900:assistant', // final text turn
    ]);
  });

  it('computes seq as lineIndex * SEQ_STRIDE + blockIndex', () => {
    expect(bySeq(rows, 5 * SEQ_STRIDE + 0).toolName).toBeNull(); // text block
    expect(bySeq(rows, 5 * SEQ_STRIDE + 1).toolName).toBe('Bash');
    expect(bySeq(rows, 5 * SEQ_STRIDE + 2).toolName).toBe('Edit');
  });

  it('keeps seq monotonically increasing in file order', () => {
    const seqs = rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('carries sessionId and parsed timestamps onto every row', () => {
    for (const row of rows) {
      expect(row.sessionId).toBe(SESSION);
      expect(row.ts).toBeGreaterThan(0);
    }
    expect(bySeq(rows, 100).ts).toBe(Date.parse('2026-09-15T10:00:00.000Z'));
  });

  it('stores raw_json verbatim, never re-serialised', () => {
    const fileLines = basic.split('\n');
    // line 5 produced three rows; each must carry that exact original line
    for (const seq of [500, 501, 502]) {
      expect(bySeq(rows, seq).rawJson).toBe(fileLines[5]);
    }
    // and it must still be the untouched original, not a round-trip
    expect(bySeq(rows, 500).rawJson).toContain('"replace_all": false');
  });
});

describe('content block handling', () => {
  const rows = parseTranscript(basic);

  it('projects a typed prompt to a user row', () => {
    const row = bySeq(rows, 100);
    expect(row.role).toBe('user');
    expect(row.body).toBe('Add a retry to the uploader');
    expect(row.toolName).toBeNull();
  });

  it('marks thinking blocks with toolName "thinking", not a body prefix', () => {
    const thinking = bySeq(rows, 200);
    expect(thinking.role).toBe('assistant');
    expect(thinking.toolName).toBe('thinking');
    expect(thinking.body).toBe('The uploader has no backoff.');

    const text = bySeq(rows, 201);
    expect(text.role).toBe('assistant');
    expect(text.toolName).toBeNull();
    expect(text.body).toBe('I will look at the uploader first.');
  });

  it('summarises a tool_use readably and keeps the input searchable', () => {
    const read = bySeq(rows, 300);
    expect(read.role).toBe('tool_use');
    expect(read.toolName).toBe('Read');
    expect(read.targetPath).toBe(`${CWD}/src/uploader.ts`);
    expect(read.body?.split('\n')[0]).toBe(`Read: ${CWD}/src/uploader.ts`);
    expect(read.body).toContain('file_path');
  });

  it('extracts target_path from file_path for editing tools', () => {
    expect(bySeq(rows, 502).targetPath).toBe(`${CWD}/src/uploader.ts`);
    expect(bySeq(rows, 502).body).toContain('withRetry');
  });

  it('extracts a Bash target path only when it is a bare literal token', () => {
    expect(bySeq(rows, 501).targetPath).toBe(`${CWD}/src/uploader.test.ts`);
    expect(bySeq(rows, 501).body?.split('\n')[0]).toContain('npm test');

    const piped = parseLine(
      JSON.stringify({
        type: 'assistant',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat "$HOME/x" | wc -l' } },
          ],
        },
      }),
      0,
    );
    // "$HOME/x" is quoted and contains shell syntax: refuse to guess
    expect(piped[0]?.targetPath).toBeNull();
  });

  it('reads tool_result content in both string and block-array form', () => {
    expect(bySeq(rows, 400).body).toBe('export async function upload() { return post(); }');
    expect(bySeq(rows, 601).body).toBe('Edit applied.\n[image]');
  });

  it('flags error results in the body projection', () => {
    expect(bySeq(rows, 600).body).toBe('[error] 1 test failed');
  });

  it('puts system-line text on the row and tolerates system lines with none', () => {
    expect(bySeq(rows, 700).body).toBe('PostToolUse hook reported a lint warning');
    expect(bySeq(rows, 800).role).toBe('system');
    expect(bySeq(rows, 800).body).toBeNull();
  });
});

describe('tool_use / tool_result pairing', () => {
  const rows = parseTranscript(basic);

  it('resolves the tool name and path back onto the result row', () => {
    const result = bySeq(rows, 400);
    expect(result.toolName).toBe('Read');
    expect(result.targetPath).toBe(`${CWD}/src/uploader.ts`);
  });

  it('pairs each of several parallel calls independently', () => {
    expect(bySeq(rows, 600).toolName).toBe('Bash');
    expect(bySeq(rows, 601).toolName).toBe('Edit');
    expect(bySeq(rows, 601).targetPath).toBe(`${CWD}/src/uploader.ts`);
  });

  it('cannot pair across a standalone parseLine call, and says so with null', () => {
    const fileLines = basic.split('\n');
    const line4 = fileLines[4];
    expect(line4).toBeDefined();
    const solo = parseLine(line4 as string, 4);
    expect(solo[0]?.role).toBe('tool_result');
    expect(solo[0]?.toolName).toBeNull();
  });

  it('exposes the tool-call id from either side of the pair', () => {
    expect(toolCallIdOf(bySeq(rows, 300))).toBe('toolu_read_1');
    expect(toolCallIdOf(bySeq(rows, 400))).toBe('toolu_read_1');
    expect(toolCallIdOf(bySeq(rows, 501))).toBe('toolu_bash_1');
    expect(toolCallIdOf(bySeq(rows, 600))).toBe('toolu_bash_1');
    expect(toolCallIdOf(bySeq(rows, 201))).toBeNull(); // not a tool row
  });

  it('does not leak pairings between separate parseTranscript calls', () => {
    const fileLines = basic.split('\n');
    const orphan = parseTranscript([fileLines[6]].join('\n'), 6);
    expect(orphan[0]?.toolName).toBeNull();
  });
});

describe('malformed and hostile input', () => {
  it('never throws, whatever the line is', () => {
    const hostile = [
      '',
      '   ',
      '{',
      '{"type":',
      'null',
      'true',
      '3.14',
      '[]',
      '{"type":123}',
      '{"type":"user","message":null}',
      '{"type":"user","message":{"content":{"weird":true}}}',
    ];
    for (const line of hostile) {
      expect(() => parseLine(line, 0)).not.toThrow();
    }
    expect(() => parseTranscript(malformed)).not.toThrow();
  });

  it('yields [] for a truncated final line — the file is mid-append', () => {
    const lines = malformed.split('\n');
    const truncated = lines[lines.length - 1] as string;
    expect(truncated.endsWith('"mess')).toBe(true); // the fixture really is cut off
    expect(parseLine(truncated, 11)).toEqual([]);
    // and the surrounding parse still returns everything before it
    expect(parseTranscript(malformed).some((r) => r.seq >= 11 * SEQ_STRIDE)).toBe(false);
  });

  it('skips blank lines, non-objects and unknown line types without a row', () => {
    const rows = parseTranscript(malformed);
    const seqs = new Set(rows.map((r) => Math.floor(r.seq / SEQ_STRIDE)));
    expect(seqs.has(1)).toBe(false); // blank
    expect(seqs.has(2)).toBe(false); // not json
    expect(seqs.has(3)).toBe(false); // bare json string
    expect(seqs.has(4)).toBe(false); // json array
    expect(seqs.has(5)).toBe(false); // unknown `type`
    expect(seqs.has(6)).toBe(false); // no `type`
  });

  it('still keeps a row for a recognised line with an unexpected shape', () => {
    const rows = parseTranscript(malformed);
    // line 7: message.content is a number; line 8: no message; line 9: empty content
    for (const line of [7, 8, 9]) {
      const row = rows.find((r) => Math.floor(r.seq / SEQ_STRIDE) === line);
      expect(row, `expected a row for line ${line}`).toBeDefined();
      expect(row?.rawJson.length).toBeGreaterThan(0);
      expect(row?.body).toBeNull();
    }
  });

  it('gives an unparseable timestamp ts 0 rather than pretending it is now', () => {
    const rows = parseTranscript(malformed);
    const row = rows.find((r) => Math.floor(r.seq / SEQ_STRIDE) === 7);
    expect(row?.ts).toBe(0);
  });

  it('keeps a placeholder row for block types it has never seen', () => {
    const rows = parseTranscript(malformed).filter(
      (r) => Math.floor(r.seq / SEQ_STRIDE) === 10,
    );
    expect(rows.map((r) => r.body)).toEqual(['[wormhole]', null]);
  });

  it('treats a line with no sessionId as storable, leaving the id empty', () => {
    const rows = parseLine('{"type":"user","message":{"role":"user","content":"hi"}}', 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('');
    expect(rows[0]?.seq).toBe(300);
  });
});

describe('body truncation', () => {
  it('truncates the projection but never the raw line', () => {
    const huge = 'x'.repeat(BODY_MAX_CHARS * 2);
    const raw = JSON.stringify({
      type: 'user',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }],
      },
    });
    const row = parseLine(raw, 0)[0];
    expect(row).toBeDefined();
    expect(row?.body?.length).toBeGreaterThan(BODY_MAX_CHARS);
    expect(row?.body?.length).toBeLessThan(BODY_MAX_CHARS + 200);
    expect(row?.body).toContain('truncated');
    expect(row?.rawJson).toBe(raw);
    expect(row?.rawJson.length).toBeGreaterThan(BODY_MAX_CHARS * 2);
  });
});

describe('chunked parsing (what the watcher does)', () => {
  it('continues seq numbering from fromLineIndex', () => {
    const lines = basic.split('\n');
    const head = lines.slice(0, 5).join('\n') + '\n';
    const tail = lines.slice(5).join('\n');

    const first = parseTranscript(head, 0);
    const second = parseTranscript(tail, countLines(head));

    expect(first.map((r) => r.seq)).toEqual([100, 200, 201, 300, 400]);
    expect(second.map((r) => r.seq)).toEqual([500, 501, 502, 600, 601, 700, 800, 900]);
    expect(first.concat(second).map((r) => r.seq)).toEqual(
      parseTranscript(basic).map((r) => r.seq),
    );
  });

  it('counts line slots the same way parseTranscript indexes them', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2); // unterminated tail still occupies a slot
  });
});

describe('format-aware accessors used by status.ts and usage.ts', () => {
  const rows = parseTranscript(basic);

  it('reads usage off assistant lines only', () => {
    const usage = extractUsage(bySeq(rows, 200).rawJson);
    expect(usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheCreationInputTokens: 800,
      cacheReadInputTokens: 15000,
    });
    expect(extractUsage(bySeq(rows, 100).rawJson)).toBeNull(); // user line
    expect(extractUsage('not json')).toBeNull();
    expect(extractUsage(bySeq(rows, 700).rawJson)).toBeNull(); // system line
  });

  it('reads stop_reason off assistant lines only', () => {
    // fixture line 9 ends the turn; lines 3 and 5 are waiting on tools
    expect(stopReasonOf(bySeq(rows, 900).rawJson)).toBe('end_turn');
    expect(stopReasonOf(bySeq(rows, 300).rawJson)).toBe('tool_use');
    expect(stopReasonOf(bySeq(rows, 501).rawJson)).toBe('tool_use');
    // a null stop_reason is "absent", not "finished"
    expect(stopReasonOf(bySeq(rows, 200).rawJson)).toBeNull();
    expect(stopReasonOf(bySeq(rows, 100).rawJson)).toBeNull(); // user line
    expect(stopReasonOf(bySeq(rows, 700).rawJson)).toBeNull(); // system line
    expect(stopReasonOf('{ truncated')).toBeNull();
    expect(stopReasonOf('{"type":"assistant"}')).toBeNull();
  });

  it('classifies only turn-ending stop reasons as handing control back', () => {
    expect(TURN_ENDING_STOP_REASONS.has('end_turn')).toBe(true);
    expect(TURN_ENDING_STOP_REASONS.has('stop_sequence')).toBe(true);
    expect(TURN_ENDING_STOP_REASONS.has('tool_use')).toBe(false);
    expect(TURN_ENDING_STOP_REASONS.has('max_tokens')).toBe(false);
  });

  it('reads the real cwd off a line, never a slugified directory name', () => {
    expect(cwdOf(bySeq(rows, 100).rawJson)).toBe(CWD);
    expect(cwdOf('{"type":"user"}')).toBeNull();
    expect(cwdOf('}{')).toBeNull();
  });
});

describe('session titles — lifted out, never persisted as messages', () => {
  const aiTitle = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's' });
  const customTitle = (t: string) =>
    JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' });

  it('reads both title line shapes', () => {
    expect(titleOf(aiTitle('Fix the uploader'))).toBe('Fix the uploader');
    expect(titleOf(customTitle('My own name'))).toBe('My own name');
  });

  it('still produces no message rows for a title line', () => {
    // They are bookkeeping. Capturing the title must not start persisting them.
    expect(parseLine(aiTitle('Fix the uploader'), 3)).toEqual([]);
    expect(parseLine(customTitle('My own name'), 3)).toEqual([]);
    expect(parseTranscript([aiTitle('a'), customTitle('b'), ''].join('\n'))).toEqual([]);
  });

  it('is null for anything that is not a title line', () => {
    expect(titleOf('{"type":"user","message":{"role":"user","content":"hi"}}')).toBeNull();
    expect(titleOf('{"type":"ai-title"}')).toBeNull(); // no value
    expect(titleOf('{"type":"ai-title","aiTitle":42}')).toBeNull(); // wrong type
    expect(titleOf('{ truncated')).toBeNull();
    expect(titleOf('')).toBeNull();
  });

  it('treats a blank title as no title', () => {
    expect(titleOf(aiTitle('   '))).toBeNull();
    expect(titleOf(aiTitle(''))).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(titleOf(aiTitle('  Fix the uploader \n'))).toBe('Fix the uploader');
  });

  it('takes the LAST title in a chunk, across both types', () => {
    const chunk = [aiTitle('first'), customTitle('second'), aiTitle('third'), ''].join('\n');
    expect(lastTitleIn(chunk)).toBe('third');

    const customLast = [aiTitle('generated'), customTitle('user chose this'), ''].join('\n');
    expect(lastTitleIn(customLast)).toBe('user chose this');
  });

  it('returns null for a chunk with no title line', () => {
    expect(lastTitleIn(basic)).toBeNull();
    expect(lastTitleIn('')).toBeNull();
  });

  it('finds a title among ordinary traffic', () => {
    const chunk = basic.split('\n').slice(0, 3).concat(aiTitle('Add a retry'), '').join('\n');
    expect(lastTitleIn(chunk)).toBe('Add a retry');
  });

  it('survives a truncated title line mid-append', () => {
    expect(() => lastTitleIn('{"type":"ai-title","aiTit')).not.toThrow();
    expect(lastTitleIn('{"type":"ai-title","aiTit')).toBeNull();
    // and a good title earlier in the chunk still wins
    expect(lastTitleIn([aiTitle('good'), '{"type":"ai-title","aiTit'].join('\n'))).toBe('good');
  });
});
